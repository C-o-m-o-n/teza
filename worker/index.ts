// The `teza` Worker. Static files in dist/ are served by Cloudflare's asset handler; only
// /api/* (see `run_worker_first` in wrangler.jsonc) and asset misses reach this script.
// POST /api/room issues a room code; GET /api/match/<code>?mode=create|join with `Upgrade:
// websocket` opens or joins that room's Durable Object. A player coming back adds
// `?resume=<token>&ack=<peerAck>` instead of `mode`, which is checked before the upgrade.
// /api/account/* goes to the single `Accounts` Durable Object (src/server/accounts.ts), which
// also hosts the ranked queue and the public /api/leaderboard and /api/profile/<username>
// (src/server/leaderboard.ts). A ranked room (`?mode=ranked`) is registered with its `Match`
// object by the queue over RPC; its socket needs a session, which the Worker resolves to an
// account and hands to `Match` in ACCOUNT_HEADER. Without a well-formed session cookie it is
// refused here, without a call to `Accounts`.

import { DurableObject } from "cloudflare:workers";
import {
  AccountRow, AccountStore, CalibratedRow, cookieToken, handleAccount, MAX_BODY_BYTES, PAIR_WINDOW_MS, pairAllowed, RankedMatchRow,
  QueueHost, RatingChange, rateRankedMatch, RatingRow, readBody, reportNoShow, sessionKey, SessionRow, withTimeout,
} from "../src/server/accounts";
import { handlePublic, isPublicRoute } from "../src/server/leaderboard";
import {
  admission, cryptoRandom, MatchSession, newRoomCode, REPORT_TIMEOUT_MS, ResumeRequest, ROOM_CODE, SlotIndex, SlotRating,
} from "../src/server/match";
import { RD_HIDDEN } from "../src/server/rating";
import { Matchmaker, QueuePlayer } from "../src/server/matchmaking";

export interface Env {
  MATCH: DurableObjectNamespace<Match>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
}

const MATCH_ROUTE = /^\/api\/match\/([^/]*)$/;
/** The account key of a ranked socket, set only by the Worker (incoming copies are stripped). */
const ACCOUNT_HEADER = "X-Teza-Account";
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
    if (path.startsWith("/api/account/") || isPublicRoute(path)) {
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
    const headers = new Headers(request.headers);
    headers.delete(ACCOUNT_HEADER);
    const url = new URL(request.url);
    if (url.searchParams.get("mode") === "ranked" && !url.searchParams.has("resume")) {
      const cookie = request.headers.get("Cookie");
      // no session token at all: answered here, so cookieless upgrades never reach the Accounts object
      if (cookieToken(cookie) === null) return new Response("Sign in to play ranked", { status: 401 });
      const key = await accounts(env).sessionAccount(cookie);
      if (key === null) return new Response("Sign in to play ranked", { status: 401 });
      headers.set(ACCOUNT_HEADER, key);
    }
    return env.MATCH.get(env.MATCH.idFromName(route[1])).fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

function accounts(env: Env): DurableObjectStub<Accounts> {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
}

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as number),
};

/** One instance per match id. Holds both sockets in memory (no hibernation) for the life of the match. */
export class Match extends DurableObject<Env> {
  private session = new MatchSession(clock);

  /**
   * RPC from the matchmaker (Accounts): make this room a ranked match for `players`. False if the
   * code is already in use (someone holds a slot, or it is ranked already). Kept in memory only:
   * if the object restarts, the match just can't start as ranked.
   */
  async registerRanked(code: string, players: [QueuePlayer, QueuePlayer]): Promise<boolean> {
    if (this.session.hasPlayers || this.session.isRanked) return false;
    const keys = [players[0].key, players[1].key] as const;
    const session: MatchSession = new MatchSession(clock, cryptoRandom, {
      accounts: keys,
      report: async (winner: SlotIndex | null) => {
        const winnerKey = winner === null ? null : session.accountOf(winner);
        const changes = await accounts(this.env).reportRanked(code, winnerKey);
        if (!changes) return null;
        const bySlot = (i: SlotIndex): SlotRating | undefined => {
          const c = changes.find((x) => x.key === session.accountOf(i));
          return c && { tr: c.tr, delta: c.delta };
        };
        const ratings = [bySlot(0), bySlot(1)];
        return ratings[0] && ratings[1] ? [ratings[0], ratings[1]] : null;
      },
      noShow: (absent: string) => withTimeout(accounts(this.env).reportNoShow(code, absent), REPORT_TIMEOUT_MS),
    });
    this.session = session;
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const resume = resumeParams(url);
    if (resume === null) return new Response("Bad resume parameters", { status: 400 });
    if (resume && !this.session.hasToken(resume.token)) return new Response("Unknown resume token", { status: 403 });
    const account = request.headers.get(ACCOUNT_HEADER);
    if (!resume) {
      // a new player says whether they open the room, join it or take a ranked slot, so nobody takes over a live code
      const refused = admission(this.session, url.searchParams.get("mode"), account);
      if (refused) return new Response(refused.message, { status: refused.status });
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
    }, resume, account ?? undefined);
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

/** One global instance holding every account, session and rating in its SQLite storage, and the ranked queue in memory. */
export class Accounts extends DurableObject<Env> {
  private store: AccountStore;
  private matchmaker: Matchmaker;
  private cooldowns = new Map<string, number>(); // no-show cooldowns, in memory only

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
    // Ratings and the ranked rooms awaiting a result are new tables in this class: no migration needed.
    sql.exec(`CREATE TABLE IF NOT EXISTS ratings (
      username_key TEXT PRIMARY KEY,
      r REAL NOT NULL,
      rd REAL NOT NULL,
      vol REAL NOT NULL,
      games INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ranked_matches (
      code TEXT PRIMARY KEY,
      key_a TEXT NOT NULL,
      key_b TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // One row per rated ranked match, for the per-pair cap (key_lo < key_hi); rows older than PAIR_WINDOW_MS are pruned.
    sql.exec(`CREATE TABLE IF NOT EXISTS rated_pairs (
      key_lo TEXT NOT NULL,
      key_hi TEXT NOT NULL,
      rated_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS rated_pairs_by_pair ON rated_pairs (key_lo, key_hi, rated_at)");
    const ordered = (a: string, b: string) => (a < b ? [a, b] : [b, a]);
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
      rating(key): RatingRow | null {
        return sql.exec<{ r: number; rd: number; vol: number; games: number }>(
          "SELECT r, rd, vol, games FROM ratings WHERE username_key = ?", key).toArray()[0] ?? null;
      },
      calibrated(): CalibratedRow[] {
        return sql.exec<{ username_key: string; username: string; created_at: number; r: number; rd: number; games: number }>(
          `SELECT a.username_key, a.username, a.created_at, r.r, r.rd, r.games
           FROM ratings r JOIN accounts a ON a.username_key = r.username_key WHERE r.rd <= ?`, RD_HIDDEN).toArray()
          .map((row) => ({ key: row.username_key, username: row.username, createdAt: row.created_at, r: row.r, rd: row.rd, games: row.games }));
      },
      rankedMatch(code): RankedMatchRow | null {
        const row = sql.exec<{ key_a: string; key_b: string; created_at: number }>(
          "SELECT key_a, key_b, created_at FROM ranked_matches WHERE code = ?", code).toArray()[0];
        return row ? { keys: [row.key_a, row.key_b], createdAt: row.created_at } : null;
      },
      insertRankedMatch(code, row) {
        sql.exec("INSERT OR REPLACE INTO ranked_matches VALUES (?, ?, ?, ?)", code, row.keys[0], row.keys[1], row.createdAt);
      },
      deleteRankedMatch(code) {
        return sql.exec("DELETE FROM ranked_matches WHERE code = ?", code).rowsWritten > 0;
      },
      deleteRankedMatchesBefore(createdAt) {
        sql.exec("DELETE FROM ranked_matches WHERE created_at < ?", createdAt);
      },
      rateMatch(code, ratings, at) {
        return ctx.storage.transactionSync(() => {
          if (sql.exec("DELETE FROM ranked_matches WHERE code = ?", code).rowsWritten === 0) return false;
          for (const [key, row] of ratings) {
            sql.exec("INSERT OR REPLACE INTO ratings VALUES (?, ?, ?, ?, ?)", key, row.r, row.rd, row.vol, row.games);
          }
          if (ratings.length === 2) {
            const [lo, hi] = ordered(ratings[0][0], ratings[1][0]);
            sql.exec("INSERT INTO rated_pairs VALUES (?, ?, ?)", lo, hi, at);
          }
          sql.exec("DELETE FROM rated_pairs WHERE rated_at < ?", at - PAIR_WINDOW_MS);
          return true;
        });
      },
      openMatchCount(keyA, keyB, since) {
        return sql.exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ranked_matches
           WHERE ((key_a = ? AND key_b = ?) OR (key_a = ? AND key_b = ?)) AND created_at >= ?`,
          keyA, keyB, keyB, keyA, since).one().n;
      },
      pairCount(keyA, keyB, since) {
        const [lo, hi] = ordered(keyA, keyB);
        return sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM rated_pairs WHERE key_lo = ? AND key_hi = ? AND rated_at >= ?", lo, hi, since).one().n;
      },
    };
    this.matchmaker = new Matchmaker(() => Date.now(), pairAllowed(this.store, this.cooldowns));
  }

  async fetch(request: Request): Promise<Response> {
    if (isPublicRoute(new URL(request.url).pathname)) return handlePublic(request, this.store);
    return handleAccount(request, this.store, Date.now, this.queueHost());
  }

  private queueHost(): QueueHost {
    return {
      matchmaker: this.matchmaker,
      openRoom: (code, players) => this.env.MATCH.get(this.env.MATCH.idFromName(code)).registerRanked(code, players),
      cooldowns: this.cooldowns,
    };
  }

  /** RPC from the Worker: the account key a `Cookie` header's session belongs to, or null. */
  async sessionAccount(cookie: string | null): Promise<string | null> {
    return sessionKey(cookie, this.store);
  }

  /** RPC from a ranked `Match`: rate its result once. Null if it was not a ranked match or was rated already. */
  async reportRanked(code: string, winnerKey: string | null): Promise<RatingChange[] | null> {
    return rateRankedMatch(this.store, code, winnerKey);
  }

  /** RPC from a ranked `Match` whose lobby timed out with one account missing: drop the room unrated and cool that account down. */
  async reportNoShow(code: string, absentKey: string): Promise<boolean> {
    return reportNoShow(this.queueHost(), this.store, code, absentKey);
  }
}
