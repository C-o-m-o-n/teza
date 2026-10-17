// The `teza` Worker. Static files in dist/ are served by Cloudflare's asset handler; only
// /api/* (see `run_worker_first` in wrangler.jsonc) and asset misses reach this script.
// POST /api/room issues a room code; GET /api/match/<code>?mode=create|join with `Upgrade:
// websocket` opens or joins that room's Durable Object. A player coming back adds
// `?resume=<token>&ack=<peerAck>` instead of `mode`, which is checked before the upgrade.
// /api/account/* goes to the single `Accounts` Durable Object (src/server/accounts.ts).

import { DurableObject } from "cloudflare:workers";
import { AccountRow, AccountStore, handleAccount, MAX_BODY_BYTES, readBody, SessionRow } from "../src/server/accounts";
import { MatchSession, newRoomCode, ResumeRequest, ROOM_CODE } from "../src/server/match";

export interface Env {
  MATCH: DurableObjectNamespace<Match>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
}

const MATCH_ROUTE = /^\/api\/match\/([^/]*)$/;
const TOKEN = /^[0-9a-f]{32}$/;
const ACK = /^[0-9]{1,15}$/;

/** `?resume=<token>&ack=<n>` (ack defaults to 0), undefined without `resume`, or null if malformed. */
function resumeParams(url: URL): ResumeRequest | undefined | null {
  const token = url.searchParams.get("resume");
  if (token === null) return undefined;
  const ack = url.searchParams.get("ack") ?? "0";
  if (!TOKEN.test(token) || !ACK.test(ack)) return null;
  return { token, peerAck: Number(ack) };
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/account/")) {
      // Hand the Durable Object a buffered body: a streamed one breaks the connection when the
      // object answers (e.g. 403, 415) before reading it.
      const body = request.body ? await readBody(request) : null;
      if (body === null && request.body) {
        return Response.json({ error: `Body must be at most ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
      }
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(new Request(request, { body }));
    }
    if (path === "/api/room") {
      // No storage: the room exists once its creator's socket holds a slot (Match.fetch).
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      return Response.json({ code: newRoomCode() }, { status: 201 });
    }
    const route = MATCH_ROUTE.exec(path);
    if (!route) return new Response("Not found", { status: 404 });
    if (!ROOM_CODE.test(route[1])) return new Response("Bad room code", { status: 400 });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
    }
    return env.MATCH.get(env.MATCH.idFromName(route[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** One instance per match id. Holds both sockets in memory (no hibernation) for the life of the match. */
export class Match extends DurableObject<Env> {
  private session = new MatchSession({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as number),
  });

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const resume = resumeParams(url);
    if (resume === null) return new Response("Bad resume parameters", { status: 400 });
    if (resume && !this.session.hasToken(resume.token)) return new Response("Unknown resume token", { status: 403 });
    if (!resume) {
      // a new player says whether they open the room or join it, so nobody takes over a live code
      const mode = url.searchParams.get("mode");
      if (mode !== "create" && mode !== "join") return new Response("Expected ?mode=create or ?mode=join", { status: 400 });
      if (mode === "create" && this.session.hasPlayers) return new Response("Room code taken", { status: 409 });
      if (mode === "join" && !this.session.hasPlayers) return new Response("No such room", { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = this.session.connect({
      send: (data) => {
        try {
          server.send(data);
        } catch {
          // socket already closing; the close event will follow
        }
      },
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {
          // already closed
        }
      },
    }, resume);
    server.addEventListener("message", (event) => this.session.message(conn, event.data));
    server.addEventListener("close", () => {
      this.session.disconnect(conn);
      try {
        server.close(1000, "closed");
      } catch {
        // already closed
      }
    });
    server.addEventListener("error", () => this.session.disconnect(conn));
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** One global instance holding every account and session in its SQLite storage. */
export class Accounts extends DurableObject<Env> {
  private store: AccountStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
      username_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      records TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.store = {
      account(key): AccountRow | null {
        const row = sql.exec<{ username: string; password_hash: string; created_at: number; records: string }>(
          "SELECT username, password_hash, created_at, records FROM accounts WHERE username_key = ?", key).toArray()[0];
        return row ? { username: row.username, passwordHash: row.password_hash, createdAt: row.created_at, records: row.records } : null;
      },
      insertAccount(key, row) {
        return sql.exec("INSERT OR IGNORE INTO accounts VALUES (?, ?, ?, ?, ?)",
          key, row.username, row.passwordHash, row.createdAt, row.records).rowsWritten > 0;
      },
      setRecords(key, records) {
        sql.exec("UPDATE accounts SET records = ? WHERE username_key = ?", records, key);
      },
      session(tokenHash): SessionRow | null {
        const row = sql.exec<{ username_key: string; expires_at: number }>(
          "SELECT username_key, expires_at FROM sessions WHERE token_hash = ?", tokenHash).toArray()[0];
        return row ? { key: row.username_key, expiresAt: row.expires_at } : null;
      },
      insertSession(tokenHash, row) {
        sql.exec("INSERT INTO sessions VALUES (?, ?, ?)", tokenHash, row.key, row.expiresAt);
      },
      deleteSession(tokenHash) {
        sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
      },
      deleteExpiredSessions(now) {
        sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    return handleAccount(request, this.store);
  }
}
