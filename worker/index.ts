// The `teza` Worker. Static files in dist/ are served by Cloudflare's asset handler; only
// /api/* (see `run_worker_first` in wrangler.jsonc) and asset misses reach this script.
// GET /api/match/<id> with `Upgrade: websocket` joins the match's Durable Object. A player
// coming back adds `?resume=<token>&ack=<peerAck>`, which is checked before the upgrade.

import { DurableObject } from "cloudflare:workers";
import { MatchSession, ResumeRequest } from "../src/server/match";

export interface Env {
  MATCH: DurableObjectNamespace<Match>;
}

const MATCH_ROUTE = /^\/api\/match\/([^/]*)$/;
const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
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
    const route = MATCH_ROUTE.exec(new URL(request.url).pathname);
    if (!route) return new Response("Not found", { status: 404 });
    if (!MATCH_ID.test(route[1])) return new Response("Bad match id", { status: 400 });
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
    const resume = resumeParams(new URL(request.url));
    if (resume === null) return new Response("Bad resume parameters", { status: 400 });
    if (resume && !this.session.hasToken(resume.token)) return new Response("Unknown resume token", { status: 403 });
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
