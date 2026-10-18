import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountRow, AccountStore, COOKIE_NAME, MAX_BODY_BYTES, QueueHost, RANKED_MATCH_TTL_MS, RankedMatchRow, RatingRow,
  SESSION_TTL_S, SessionRow, handleAccount, rateRankedMatch, sessionKey,
} from "../src/server/accounts";
import { Matchmaker, QUEUE_STALE_MS } from "../src/server/matchmaking";
import { ROOM_CODE } from "../src/server/match";
import { Records, mergeRecords, recordsError } from "../src/profile";

class MemoryStore implements AccountStore {
  accounts = new Map<string, AccountRow>();
  sessions = new Map<string, SessionRow>();
  account(key: string): AccountRow | null {
    return this.accounts.get(key) ?? null;
  }
  insertAccount(key: string, row: AccountRow): boolean {
    if (this.accounts.has(key)) return false;
    this.accounts.set(key, { ...row });
    return true;
  }
  setRecords(key: string, records: string): void {
    this.accounts.get(key)!.records = records;
  }
  session(tokenHash: string): SessionRow | null {
    return this.sessions.get(tokenHash) ?? null;
  }
  insertSession(tokenHash: string, row: SessionRow): void {
    this.sessions.set(tokenHash, { ...row });
  }
  deleteSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
  }
  deleteExpiredSessions(now: number): void {
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
  }
  ratings = new Map<string, RatingRow>();
  ranked = new Map<string, RankedMatchRow>();
  rating(key: string): RatingRow | null {
    return this.ratings.get(key) ?? null;
  }
  rankedMatch(code: string): RankedMatchRow | null {
    return this.ranked.get(code) ?? null;
  }
  insertRankedMatch(code: string, row: RankedMatchRow): void {
    this.ranked.set(code, row);
  }
  deleteRankedMatchesBefore(createdAt: number): void {
    for (const [k, m] of this.ranked) if (m.createdAt < createdAt) this.ranked.delete(k);
  }
  rateMatch(code: string, ratings: [string, RatingRow][]): boolean {
    if (!this.ranked.delete(code)) return false;
    for (const [key, row] of ratings) this.ratings.set(key, { ...row });
    return true;
  }
}

const ORIGIN = "https://teza.example";
const PASSWORD = "correct horse battery";

let store: MemoryStore;
let clock: number;
let queue: QueueHost;
let rooms: { code: string; players: string[] }[]; // what the queue registered with the Match objects
let roomsRefused: number; // how many registrations to refuse (a code already in use) before accepting

beforeEach(() => {
  store = new MemoryStore();
  clock = 1_700_000_000_000;
  rooms = [];
  roomsRefused = 0;
  queue = {
    matchmaker: new Matchmaker(() => clock),
    openRoom: async (code, players) => {
      if (roomsRefused > 0) {
        roomsRefused--;
        return false;
      }
      rooms.push({ code, players: players.map((p) => p.key) });
      return true;
    },
  };
});

interface Opts {
  body?: unknown;
  rawBody?: string;
  cookie?: string | null;
  origin?: string;
  contentType?: string | null;
}

function call(method: string, route: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = `${COOKIE_NAME}=${opts.cookie}`;
  if (opts.origin) headers.Origin = opts.origin;
  let body: string | undefined;
  if (method !== "GET") {
    if (opts.contentType !== null) headers["Content-Type"] = opts.contentType ?? "application/json";
    body = opts.rawBody ?? JSON.stringify(opts.body ?? {});
  }
  return handleAccount(new Request(`${ORIGIN}/api/account/${route}`, { method, headers, body }), store, () => clock, queue);
}

function tokenOf(res: Response): string {
  const m = new RegExp(`^${COOKIE_NAME}=([0-9a-f]+);`).exec(res.headers.get("Set-Cookie") ?? "");
  expect(m).not.toBeNull();
  return m![1];
}

async function register(username = "Alice", password = PASSWORD): Promise<string> {
  const res = await call("POST", "register", { body: { username, password } });
  expect(res.status).toBe(201);
  return tokenOf(res);
}

const run = (value: number) => ({ value, pps: 2, apm: 50, pieces: 100, date: 1 });

async function storedRecords(key = "alice"): Promise<Records> {
  return JSON.parse(store.accounts.get(key)!.records);
}

describe("register and login", () => {
  it("registers, logs in and returns the profile", async () => {
    const reg = await call("POST", "register", { body: { username: "Alice", password: PASSWORD } });
    expect(reg.status).toBe(201);
    expect(await reg.json()).toEqual({ username: "Alice", createdAt: clock, records: { vs: {} } });
    const login = await call("POST", "login", { body: { username: "aLiCe", password: PASSWORD } });
    expect(login.status).toBe(200);
    const token = tokenOf(login);
    const me = await call("GET", "me", { cookie: token });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ username: "Alice", createdAt: clock, records: { vs: {} }, rating: { tr: null, games: 0 } });
  });

  it("gives identical 401s for a wrong password and an unknown user", async () => {
    await register();
    const wrong = await call("POST", "login", { body: { username: "Alice", password: "wrong password" } });
    const unknown = await call("POST", "login", { body: { username: "Nobody", password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect([...wrong.headers]).toEqual([...unknown.headers]);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses a name that differs only by case with 409", async () => {
    await register("Alice");
    const res = await call("POST", "register", { body: { username: "ALICE", password: "another password" } });
    expect(res.status).toBe(409);
    expect(store.accounts.size).toBe(1);
  });

  it.each([
    ["2-char username", { username: "ab", password: PASSWORD }],
    ["17-char username", { username: "a".repeat(17), password: PASSWORD }],
    ["username with a space", { username: "al ice", password: PASSWORD }],
    ["username not a string", { username: 123, password: PASSWORD }],
    ["missing username", { password: PASSWORD }],
    ["7-char password", { username: "Alice", password: "1234567" }],
    ["129-char password", { username: "Alice", password: "p".repeat(129) }],
    ["password not a string", { username: "Alice", password: 12345678 }],
  ])("rejects %s with 400 and a message", async (_, body) => {
    for (const route of ["register", "login"]) {
      const res = await call("POST", route, { body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must be/);
    }
    expect(store.accounts.size).toBe(0);
  });

  it("stores a salted hash, never the password", async () => {
    await register("Alice", PASSWORD);
    await register("Bob", PASSWORD);
    const a = store.accounts.get("alice")!;
    const b = store.accounts.get("bob")!;
    for (const row of [a, b]) {
      expect(JSON.stringify(row)).not.toContain(PASSWORD);
      expect(row.passwordHash).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    }
    expect(a.passwordHash).not.toBe(b.passwordHash);
    expect(a.passwordHash.split("$")[2]).not.toBe(b.passwordHash.split("$")[2]);
    for (const hash of store.sessions.keys()) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sessions", () => {
  it("sets an HttpOnly, Secure, SameSite=Strict cookie on /api for 30 days and stores only its hash", async () => {
    const res = await call("POST", "register", { body: { username: "Alice", password: PASSWORD } });
    const cookie = res.headers.get("Set-Cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api", `Max-Age=${SESSION_TTL_S}`]) {
      expect(cookie.split("; ")).toContain(attr);
    }
    const token = tokenOf(res);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.sessions.size).toBe(1);
    expect(store.sessions.has(token)).toBe(false);
  });

  it("gives 401 for me without a session, with a bad cookie, and after logout", async () => {
    expect((await call("GET", "me")).status).toBe(401);
    expect((await call("GET", "me", { cookie: "f".repeat(64) })).status).toBe(401);
    const token = await register();
    expect((await call("GET", "me", { cookie: token })).status).toBe(200);
    const out = await call("POST", "logout", { cookie: token });
    expect(out.status).toBe(200);
    expect(out.headers.get("Set-Cookie")).toMatch(new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`));
    expect(store.sessions.size).toBe(0);
    expect((await call("GET", "me", { cookie: token })).status).toBe(401);
  });

  it("gives 401 once the session has expired", async () => {
    const token = await register();
    clock += SESSION_TTL_S * 1000 - 1;
    expect((await call("GET", "me", { cookie: token })).status).toBe(200);
    clock += 1;
    expect((await call("GET", "me", { cookie: token })).status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it("refuses state-changing requests from another origin with 403", async () => {
    const token = await register();
    const cross = { origin: "https://evil.example", cookie: token };
    const body = { username: "Mallory", password: PASSWORD };
    expect((await call("POST", "register", { ...cross, body })).status).toBe(403);
    expect((await call("POST", "login", { ...cross, body: { username: "Alice", password: PASSWORD } })).status).toBe(403);
    expect((await call("PUT", "records", { ...cross, body: { records: { vs: { X: { wins: 9, losses: 0 } } } } })).status).toBe(403);
    expect((await call("POST", "logout", cross)).status).toBe(403);
    expect(store.accounts.size).toBe(1);
    expect(store.sessions.size).toBe(1);
    expect(await storedRecords()).toEqual({ vs: {} });
    // the page's own origin is fine
    expect((await call("POST", "login", { origin: ORIGIN, body: { username: "Alice", password: PASSWORD } })).status).toBe(200);
  });
});

describe("request checks", () => {
  it("requires application/json on POST and PUT", async () => {
    const body = { username: "Alice", password: PASSWORD };
    expect((await call("POST", "register", { body, contentType: null })).status).toBe(415);
    expect((await call("POST", "register", { body, contentType: "text/plain" })).status).toBe(415);
    expect((await call("POST", "register", { body, contentType: "application/json; charset=utf-8" })).status).toBe(201);
  });

  it("refuses bodies over 4 KB, bad JSON, wrong methods and unknown routes", async () => {
    const big = JSON.stringify({ username: "Alice", password: PASSWORD, pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await call("POST", "register", { rawBody: big })).status).toBe(413);
    expect((await call("POST", "register", { rawBody: "{nope" })).status).toBe(400);
    expect((await call("POST", "register", { rawBody: "[1]" })).status).toBe(400);
    const wrongMethod = await call("GET", "login");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");
    expect((await call("GET", "nope")).status).toBe(404);
    expect((await call("GET", "__proto__")).status).toBe(404);
    expect(store.accounts.size).toBe(0);
  });
});

describe("records", () => {
  let token: string;
  const put = (records: unknown) => call("PUT", "records", { cookie: token, body: { records } });

  beforeEach(async () => {
    token = await register();
  });

  it("needs a session", async () => {
    expect((await call("PUT", "records", { body: { records: { vs: {} } } })).status).toBe(401);
  });

  it("keeps the better 40L time and Blitz score", async () => {
    expect((await put({ "40l": run(3000), blitz: run(50000), vs: {} })).status).toBe(200);
    const worse = await put({ "40l": run(3600), blitz: run(40000), vs: {} });
    expect(worse.status).toBe(200);
    expect((await worse.json()).records).toEqual({ "40l": run(3000), blitz: run(50000), vs: {} });
    expect(await storedRecords()).toEqual({ "40l": run(3000), blitz: run(50000), vs: {} });
    await put({ "40l": run(2400), blitz: run(60000), vs: {} });
    expect(await storedRecords()).toEqual({ "40l": run(2400), blitz: run(60000), vs: {} });
    const me = await (await call("GET", "me", { cookie: token })).json();
    expect(me.records["40l"].value).toBe(2400);
  });

  it("never lowers bot wins or losses", async () => {
    await put({ vs: { EASY: { wins: 5, losses: 2 }, HARD: { wins: 0, losses: 7 } } });
    await put({ vs: { EASY: { wins: 3, losses: 4 } } });
    await put({ vs: { HARD: { wins: 1, losses: 0 }, NEW: { wins: 1, losses: 1 } } });
    expect((await storedRecords()).vs).toEqual({
      EASY: { wins: 5, losses: 4 }, HARD: { wins: 1, losses: 7 }, NEW: { wins: 1, losses: 1 },
    });
  });

  const tooManyBots = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`BOT${i}`, { wins: 1, losses: 0 }]));
  it.each([
    ["missing records", undefined],
    ["records not an object", [1, 2]],
    ["unknown top-level key", { vs: {}, zen: run(1) }],
    ["unknown run key", { "40l": { ...run(3000), extra: 1 }, vs: {} }],
    ["missing run key", { blitz: { value: 1, pps: 1, apm: 1, pieces: 1 }, vs: {} }],
    ["negative number", { blitz: run(-5), vs: {} }],
    ["negative pps", { "40l": { ...run(3000), pps: -1 }, vs: {} }],
    ["non-finite number (null after JSON)", { blitz: { ...run(100), apm: Infinity }, vs: {} }],
    ["non-numeric value", { blitz: { ...run(100), apm: "Infinity" }, vs: {} }],
    ["string number", { blitz: { ...run(100), value: "100" }, vs: {} }],
    ["40l frames of 0", { "40l": run(0), vs: {} }],
    ["40l frames over 1e7", { "40l": run(1e7 + 1), vs: {} }],
    ["unknown vs key", { vs: { EASY: { wins: 1, losses: 0, draws: 1 } } }],
    ["negative losses", { vs: { EASY: { wins: 1, losses: -1 } } }],
    ["more than 20 bot names", { vs: tooManyBots }],
    ["bot name over 32 chars", { vs: { ["B".repeat(33)]: { wins: 1, losses: 0 } } }],
  ])("rejects %s with 400 and leaves records unchanged", async (_, records) => {
    const before = { "40l": run(3000), vs: { EASY: { wins: 2, losses: 1 } } };
    await put(before);
    const res = await put(records);
    expect(res.status).toBe(400);
    expect(await storedRecords()).toEqual(before);
  });

  it("rejects Infinity and NaN in the shared validator (JSON sends them as null, which the route rejects)", () => {
    expect(recordsError({ blitz: { ...run(100), value: Infinity }, vs: {} })).not.toBeNull();
    expect(recordsError({ "40l": { ...run(3000), pps: NaN }, vs: {} })).not.toBeNull();
    expect(recordsError({ vs: { EASY: { wins: Infinity, losses: 0 } } })).not.toBeNull();
    expect(recordsError({ "40l": run(3000), blitz: run(100), vs: { EASY: { wins: 1, losses: 0 } } })).toBeNull();
  });

  it("rejects a PUT whose merge would pass 20 bot names", async () => {
    const half = (from: number) => Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`BOT${from + i}`, { wins: 1, losses: 0 }]));
    expect((await put({ vs: half(0) })).status).toBe(200);
    expect((await put({ vs: half(100) })).status).toBe(400);
    expect(Object.keys((await storedRecords()).vs)).toHaveLength(15);
  });

  it("treats __proto__ as a plain bot name", () => {
    const merged = mergeRecords({ vs: {} }, JSON.parse('{"vs":{"__proto__":{"wins":3,"losses":1}}}'));
    expect(Object.getPrototypeOf(merged.vs)).toBe(Object.prototype);
    expect(Object.keys(merged.vs)).toEqual(["__proto__"]);
  });
});

describe("session lookup", () => {
  it("resolves a Cookie header to the account key, as the Worker does for ranked sockets", async () => {
    const token = await register("Alice");
    expect(await sessionKey(`${COOKIE_NAME}=${token}`, store, () => clock)).toBe("alice");
    expect(await sessionKey(`other=1; ${COOKIE_NAME}=${token}`, store, () => clock)).toBe("alice");
    expect(await sessionKey(null, store, () => clock)).toBeNull();
    expect(await sessionKey(`${COOKIE_NAME}=${"f".repeat(64)}`, store, () => clock)).toBeNull();
    expect(await sessionKey(`${COOKIE_NAME}=${token}`, store, () => clock + SESSION_TTL_S * 1000)).toBeNull();
    expect(store.sessions.size).toBe(0); // the expired session was deleted
  });
});

describe("ratings", () => {
  async function rankedPair(): Promise<{ a: string; b: string; code: string }> {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    const status = await (await call("GET", "queue/status", { cookie: a })).json();
    expect(status.status).toBe("matched");
    return { a, b, code: status.code };
  }

  it("gives me a hidden TR and no games for a new account, never r, rd or vol", async () => {
    const token = await register();
    const me = await (await call("GET", "me", { cookie: token })).json();
    expect(me.rating).toEqual({ tr: null, games: 0 });
    expect(JSON.stringify(me)).not.toMatch(/"(r|rd|vol)"/);
  });

  it("rates a ranked match once, persists both rows, and shows the TR once RD is low enough", async () => {
    const { a, code } = await rankedPair();
    const result = rateRankedMatch(store, code, "alice")!;
    expect(result.map((x) => x.key)).toEqual(["alice", "bob"]);
    expect(result).toEqual([{ key: "alice", tr: null, delta: null }, { key: "bob", tr: null, delta: null }]);
    const alice = store.ratings.get("alice")!;
    const bob = store.ratings.get("bob")!;
    expect(alice.r).toBeGreaterThan(1500);
    expect(bob.r).toBeLessThan(1500);
    expect(alice.r - 1500).toBeCloseTo(1500 - bob.r, 9);
    expect([alice.games, bob.games]).toEqual([1, 1]);
    expect(alice.rd).toBeLessThan(350);

    // a second report for the same match changes nothing
    expect(rateRankedMatch(store, code, "bob")).toBeNull();
    expect(store.ratings.get("alice")).toEqual(alice);

    const me = await (await call("GET", "me", { cookie: a })).json();
    expect(me.rating).toEqual({ tr: null, games: 1 });
    expect(JSON.stringify(me)).not.toMatch(/"(r|rd|vol)"/);

    // settled ratings: TR is shown, with a signed delta for each side
    store.ratings.set("alice", { r: 1600, rd: 80, vol: 0.06, games: 30 });
    store.ratings.set("bob", { r: 1550, rd: 90, vol: 0.06, games: 30 });
    store.insertRankedMatch("QQQQQQ", { keys: ["alice", "bob"], createdAt: clock });
    const [aliceLost, bobWon] = rateRankedMatch(store, "QQQQQQ", "bob")!;
    expect(aliceLost.delta).toBeLessThan(0);
    expect(bobWon.delta).toBeGreaterThan(0);
    expect(aliceLost.tr).toBe((await (await call("GET", "me", { cookie: a })).json()).rating.tr);
  });

  it("scores a draw 0.5 each and refuses an unknown match or a winner who did not play", async () => {
    const { code } = await rankedPair();
    expect(rateRankedMatch(store, code, "mallory")).toBeNull();
    expect(rateRankedMatch(store, "ZZZZZZ", "alice")).toBeNull();
    expect(store.ratings.size).toBe(0);
    rateRankedMatch(store, code, null);
    expect(store.ratings.get("alice")!.r).toBeCloseTo(1500, 9);
    expect(store.ratings.get("bob")!.games).toBe(1);
  });
});

describe("ranked queue", () => {
  it("needs a session for join, status and leave", async () => {
    expect((await call("POST", "queue/join")).status).toBe(401);
    expect((await call("GET", "queue/status")).status).toBe(401);
    expect((await call("POST", "queue/leave")).status).toBe(401);
  });

  it("runs the same origin and JSON checks as the other POST routes", async () => {
    const token = await register();
    expect((await call("POST", "queue/join", { cookie: token, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "queue/join", { cookie: token, contentType: "text/plain" })).status).toBe(415);
    expect((await call("POST", "queue/join", { cookie: token, rawBody: "[]" })).status).toBe(400);
    expect((await call("GET", "queue/join", { cookie: token })).status).toBe(405);
    expect(queue.matchmaker.size).toBe(0);
  });

  it("is not served without a queue host", async () => {
    const token = await register();
    const res = await handleAccount(new Request(`${ORIGIN}/api/account/queue/status`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
    }), store, () => clock);
    expect(res.status).toBe(404);
  });

  it("waits with range 500, then pairs two accounts into one registered room", async () => {
    const a = await register("Alice");
    const join = await call("POST", "queue/join", { cookie: a, origin: ORIGIN });
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual({ status: "waiting" });
    clock += 3000;
    expect(await (await call("GET", "queue/status", { cookie: a })).json()).toEqual({ status: "waiting", waited: 3, range: 500 });

    const b = await register("Bob");
    expect(await (await call("POST", "queue/join", { cookie: b })).json()).toEqual({ status: "waiting" });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].players).toEqual(["alice", "bob"]);
    expect(rooms[0].code).toMatch(ROOM_CODE);
    expect(store.rankedMatch(rooms[0].code)).toEqual({ keys: ["alice", "bob"], createdAt: clock });

    const sa = await (await call("GET", "queue/status", { cookie: a })).json();
    const sb = await (await call("GET", "queue/status", { cookie: b })).json();
    expect(sa).toEqual({ status: "matched", code: rooms[0].code });
    expect(sb).toEqual(sa);
    expect(await (await call("GET", "queue/status", { cookie: a })).json()).toEqual({ status: "none" });
  });

  it("tries another code when one is taken, and requeues when no room opens", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    roomsRefused = 1;
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toHaveLength(1);
    expect((await (await call("GET", "queue/status", { cookie: b })).json()).status).toBe("matched");

    await call("POST", "queue/join", { cookie: a });
    roomsRefused = 99;
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toHaveLength(1);
    expect((await (await call("GET", "queue/status", { cookie: a })).json()).status).toBe("waiting");
  });

  it("leave answers 200 with or without an entry, and a stale entry is dropped", async () => {
    const a = await register("Alice");
    expect((await call("POST", "queue/leave", { cookie: a })).status).toBe(200);
    await call("POST", "queue/join", { cookie: a });
    expect((await call("POST", "queue/leave", { cookie: a })).status).toBe(200);
    expect(await (await call("GET", "queue/status", { cookie: a })).json()).toEqual({ status: "none" });

    await call("POST", "queue/join", { cookie: a });
    clock += QUEUE_STALE_MS;
    const b = await register("Bob");
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toEqual([]);
    expect(await (await call("GET", "queue/status", { cookie: a })).json()).toEqual({ status: "none" });
  });

  it("forgets ranked rooms nobody reported after RANKED_MATCH_TTL_MS", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    const first = rooms[0].code;
    clock += RANKED_MATCH_TTL_MS + 1;
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    expect(store.rankedMatch(first)).toBeNull();
    expect(store.rankedMatch(rooms[1].code)).not.toBeNull();
  });
});
