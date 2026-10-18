// The Worker's routing (worker/index.ts) with stub bindings. `cloudflare:workers` only exists in the
// Workers runtime, so it is mocked, and the Worker is imported by a path tsc doesn't follow (its
// types come from @cloudflare/workers-types, checked by `tsc -p worker`).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../src/server/accounts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

type Fetch = (request: Request, env: unknown) => Promise<Response>;
let worker: { fetch: Fetch };

beforeAll(async () => {
  const path = "../worker/index";
  worker = (await import(/* @vite-ignore */ path)).default;
});

/** Bindings that record what reaches the Accounts and Match objects. */
function env(account: string | null = "alice") {
  const calls = { sessionAccount: [] as (string | null)[], accountsFetch: [] as string[], match: [] as Request[] };
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
  const match = {
    fetch: async (request: Request) => {
      calls.match.push(request);
      return new Response("match", { status: 200 });
    },
  };
  return {
    calls,
    bindings: {
      ACCOUNTS: { idFromName: (n: string) => n, get: () => accounts },
      MATCH: { idFromName: (n: string) => n, get: () => match },
    },
  };
}

const upgrade = (query: string, cookie?: string) => new Request(`https://teza.example/api/match/ABCDEF?${query}`, {
  headers: { Upgrade: "websocket", ...(cookie ? { Cookie: cookie } : {}) },
});

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
    expect(res.status).toBe(200);
    expect(e.calls.sessionAccount).toEqual([cookie]);
    expect(e.calls.match[0].headers.get("X-Teza-Account")).toBe("alice");

    const expired = env(null);
    expect((await worker.fetch(upgrade("mode=ranked", cookie), expired.bindings)).status).toBe(401);
    expect(expired.calls.sessionAccount).toHaveLength(1);
  });

  it("leaves create, join and resume alone", async () => {
    const e = env();
    expect((await worker.fetch(upgrade("mode=create"), e.bindings)).status).toBe(200);
    expect((await worker.fetch(upgrade(`mode=ranked&resume=${"b".repeat(32)}`), e.bindings)).status).toBe(200);
    expect(e.calls.sessionAccount).toEqual([]);
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
