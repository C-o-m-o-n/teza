// The Worker's routing (worker/index.ts) with stub bindings. `cloudflare:workers` only exists in the
// Workers runtime, so it is mocked, and the Worker is imported by a path tsc doesn't follow (its
// types come from @cloudflare/workers-types, checked by `tsc -p worker`).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME, LEGACY_COOKIE_NAME } from "../src/server/accounts";
import { FakeClock, MemoryClaims } from "./match-harness";
import { MatchSession, admit, issueClaim, resumeRequest, upgradeHeaders } from "../src/server/match";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

type Fetch = (request: Request, env: unknown) => Promise<Response>;
let worker: { fetch: Fetch };

beforeAll(async () => {
  const path = "../worker/index";
  worker = (await import(/* @vite-ignore */ path)).default;
});

/**
 * Bindings that record what reaches the Accounts and Match objects. Each room code gets a Match stub
 * with the real claim rules (issueClaim, admit) over a MatchSession and in-memory storage; its fetch
 * answers 200 with the 101's headers when the upgrade would be accepted (Node can't build a 101).
 */
function env(account: string | null = "alice") {
  const calls = { sessionAccount: [] as (string | null)[], accountsFetch: [] as string[], match: [] as Request[], issued: [] as string[] };
  const accounts = {
    sessionAccount: async (cookie: string | null) => {
      calls.sessionAccount.push(cookie);
      return account;
    },
    fetch: async (request: Request) => {
      calls.accountsFetch.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    },
  };
  const clock = new FakeClock();
  const rooms = new Map<string, { session: MatchSession; claims: MemoryClaims }>();
  const room = (code: string) => {
    if (!rooms.has(code)) rooms.set(code, { session: new MatchSession(clock), claims: new MemoryClaims() });
    return rooms.get(code)!;
  };
  const match = (code: string) => ({
    issueRoom: async () => {
      calls.issued.push(code);
      return (await issueClaim(room(code).session, room(code).claims, clock.now())) !== null;
    },
    fetch: async (request: Request) => {
      calls.match.push(request);
      const { session, claims } = room(code);
      if (resumeRequest(request.headers) === undefined) {
        const refused = await admit(session, claims, new URL(request.url).searchParams.get("mode"), request.headers.get("X-Teza-Account"), clock.now());
        if (refused) return new Response(refused.message, { status: refused.status });
      }
      return new Response("match", { status: 200, headers: upgradeHeaders(request.headers) });
    },
  });
  return {
    calls,
    clock,
    bindings: {
      ACCOUNTS: { idFromName: (n: string) => n, get: () => accounts },
      MATCH: { idFromName: (n: string) => n, get: (code: string) => match(code) },
    },
  };
}

const TOKEN = "0123456789abcdef0123456789abcdef";

function upgrade(query: string, cookie?: string, extra: Record<string, string> = {}, base = "https://teza.example", code = "ABCDEF") {
  return new Request(`${base}/api/match/${code}?${query}`, {
    headers: { Upgrade: "websocket", ...(cookie ? { Cookie: cookie } : {}), ...extra },
  });
}

const resumeHeader = (protocol: string) => ({ "Sec-WebSocket-Protocol": protocol });

async function newRoom(e: ReturnType<typeof env>, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request("https://teza.example/api/room", { method: "POST", headers }), e.bindings);
}

describe("worker: ranked upgrades", () => {
  it("answers 401 without calling Accounts when there is no well-formed session cookie", async () => {
    for (const cookie of [undefined, "other=1", `${COOKIE_NAME}=nothex`, `${COOKIE_NAME}=${"a".repeat(63)}`]) {
      const e = env();
      const res = await worker.fetch(upgrade("mode=ranked", cookie), e.bindings);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Sign in to play ranked");
      expect(e.calls.sessionAccount).toEqual([]);
      expect(e.calls.match).toEqual([]);
    }
  });

  it("resolves a well-formed cookie through sessionAccount and hands the account to Match", async () => {
    const cookie = `${COOKIE_NAME}=${"a".repeat(64)}`;
    const e = env("alice");
    const res = await worker.fetch(upgrade("mode=ranked", cookie), e.bindings);
    expect(res.status).toBe(404); // Match's own answer: the stub room is not ranked
    expect(e.calls.sessionAccount).toEqual([cookie]);
    expect(e.calls.match[0].headers.get("X-Teza-Account")).toBe("alice");

    const expired = env(null);
    expect((await worker.fetch(upgrade("mode=ranked", cookie), expired.bindings)).status).toBe(401);
    expect(expired.calls.sessionAccount).toHaveLength(1);
  });

  it("takes the legacy cookie name too", async () => {
    const cookie = `${LEGACY_COOKIE_NAME}=${"a".repeat(64)}`;
    const e = env("alice");
    await worker.fetch(upgrade("mode=ranked", cookie), e.bindings);
    expect(e.calls.sessionAccount).toEqual([cookie]);
    expect(e.calls.match[0].headers.get("X-Teza-Account")).toBe("alice");
  });

  it("leaves create, join and resume alone", async () => {
    const e = env();
    const { code } = await (await newRoom(e)).json() as { code: string };
    expect((await worker.fetch(upgrade("mode=create", undefined, {}, undefined, code), e.bindings)).status).toBe(200);
    expect((await worker.fetch(upgrade("mode=join"), e.bindings)).status).toBe(404); // nobody there, as before
    expect((await worker.fetch(upgrade("mode=ranked", undefined, resumeHeader(`teza, resume.${TOKEN}.0`)), e.bindings)).status).toBe(200);
    expect(e.calls.sessionAccount).toEqual([]);
  });
});

describe("worker: Origin", () => {
  it("refuses a cross-origin upgrade before calling Match", async () => {
    for (const origin of ["https://evil.example", "null", "https://teza.comonhq.com.evil.example", "https://evil.teza.comonhq.com", "http://teza.comonhq.com"]) {
      const e = env();
      const res = await worker.fetch(upgrade("mode=join", undefined, { Origin: origin }, "https://teza.comonhq.com"), e.bindings);
      expect(res.status, origin).toBe(403);
      expect(await res.text()).toBe("Cross-origin request refused");
      expect(e.calls.match).toEqual([]);
    }
  });

  it("lets the site, the request's own origin and no Origin through", async () => {
    for (const [base, origin] of [
      ["https://teza.comonhq.com", "https://teza.comonhq.com"], ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
      ["http://127.0.0.1:8787", "https://teza.comonhq.com"], ["https://teza.comonhq.com", null],
    ] as const) {
      const e = env();
      const res = await worker.fetch(upgrade("mode=join", undefined, origin ? { Origin: origin } : {}, base), e.bindings);
      expect(res.status, `${base} ${origin}`).toBe(404); // reached Match: nobody holds the room
      expect(e.calls.match).toHaveLength(1);
    }
    const local = env();
    const res = await worker.fetch(upgrade("mode=join", undefined, { Origin: "http://localhost:8787" }, "http://127.0.0.1:8787"), local.bindings);
    expect(res.status).toBe(403); // another name for the same host is still another origin
  });

  it("refuses POST /api/room from another origin", async () => {
    const e = env();
    const res = await newRoom(e, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(e.calls.issued).toEqual([]);
    expect((await newRoom(e, { Origin: "https://teza.example" })).status).toBe(201);
    expect((await newRoom(e)).status).toBe(201);
  });
});

describe("worker: GET /api/room", () => {
  it("says online play is here without reserving anything", async () => {
    const e = env();
    const res = await worker.fetch(new Request("https://teza.example/api/room", { headers: { Origin: "https://teza.example" } }), e.bindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: true });
    expect(e.calls.issued).toEqual([]);
    expect(e.calls.match).toEqual([]);
    const cross = await worker.fetch(new Request("https://teza.example/api/room", { headers: { Origin: "https://evil.example" } }), e.bindings);
    expect(cross.status).toBe(403);
    const put = await worker.fetch(new Request("https://teza.example/api/room", { method: "PUT" }), e.bindings);
    expect(put.status).toBe(405);
    expect(put.headers.get("Allow")).toBe("GET, POST");
  });
});

describe("worker: resume", () => {
  it("refuses the old resume query with 400", async () => {
    for (const query of [`resume=${TOKEN}`, `resume=${TOKEN}&ack=3`, `mode=join&ack=3`, `mode=ranked&resume=${TOKEN}`]) {
      const e = env();
      expect((await worker.fetch(upgrade(query), e.bindings)).status, query).toBe(400);
      expect(e.calls.match).toEqual([]);
    }
  });

  it("passes a well-formed resume subprotocol through to Match, answering with teza only", async () => {
    const e = env();
    const res = await worker.fetch(upgrade("", undefined, resumeHeader(`teza, resume.${TOKEN}.5`)), e.bindings);
    expect(res.status).toBe(200);
    expect(resumeRequest(e.calls.match[0].headers)).toEqual({ token: TOKEN, peerAck: 5 });
    expect(new URL(e.calls.match[0].url).search).toBe("");
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("teza");
    for (const [, value] of res.headers) expect(value).not.toContain(TOKEN);
  });

  it("refuses a malformed resume subprotocol with 400", async () => {
    for (const protocol of [`teza, resume.${TOKEN.slice(1)}.5`, `teza, resume.${TOKEN}.x`, `resume.${TOKEN}.5`, "teza, resume"]) {
      const e = env();
      expect((await worker.fetch(upgrade("", undefined, resumeHeader(protocol)), e.bindings)).status, protocol).toBe(400);
      expect(e.calls.match).toEqual([]);
    }
  });
});

describe("worker: issued room codes", () => {
  it("creates only codes POST /api/room returned, each once", async () => {
    const e = env();
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await newRoom(e);
      expect(res.status).toBe(201);
      codes.push(((await res.json()) as { code: string }).code);
    }
    expect(codes[0]).not.toBe(codes[1]);
    const never = ["ABCDEF", "ZZZZZZ"].find((c) => !codes.includes(c))!;
    expect((await worker.fetch(upgrade("mode=create", undefined, {}, undefined, never), e.bindings)).status).toBe(404);
    for (const code of codes) {
      expect((await worker.fetch(upgrade("mode=create", undefined, {}, undefined, code), e.bindings)).status).toBe(200);
      expect((await worker.fetch(upgrade("mode=create", undefined, {}, undefined, code), e.bindings)).status).toBe(404); // claim used
    }
  });

  it("draws another code when one is taken, and gives up with 503", async () => {
    const e = env();
    let taken = 0;
    const match = e.bindings.MATCH.get;
    e.bindings.MATCH.get = (code: string) => ({ ...match(code), issueRoom: async () => (++taken, false) });
    const res = await newRoom(e);
    expect(res.status).toBe(503);
    expect(taken).toBe(5);
  });
});

describe("worker: public routes", () => {
  it("forwards /api/leaderboard and /api/profile/* to the Accounts object", async () => {
    const e = env();
    for (const path of ["/api/leaderboard", "/api/profile/Alice"]) {
      expect((await worker.fetch(new Request(`https://teza.example${path}`), e.bindings)).status).toBe(200);
    }
    expect(e.calls.accountsFetch).toEqual(["/api/leaderboard", "/api/profile/Alice"]);
  });
});
