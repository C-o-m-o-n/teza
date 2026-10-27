import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COOKIE_NAME, LEGACY_COOKIE_NAME, MAX_ACCOUNTS, MAX_BODY_BYTES, MAX_REGISTRATIONS_PER_DAY, MAX_REGISTRATIONS_PER_IP, MAX_REGISTRATIONS_PER_PREFIX, REGISTRATION_WINDOW_MS, MAX_PAIR_RATED, NO_SHOW_COOLDOWN_MS, OPEN_ROOM_TIMEOUT_MS, PAIR_WINDOW_MS, QueueHost,
  RANKED_MATCH_TTL_MS, SESSION_TTL_S, cookieToken, handleAccount, pairAllowed, INVALID_IP_BUCKET, ipBuckets, rateRankedMatch, reportNoShow, sessionKey,
} from "../src/server/accounts";
import { Matchmaker, QUEUE_STALE_MS } from "../src/server/matchmaking";
import { ROOM_CODE } from "../src/server/match";
import { Records, mergeRecords, recordsError } from "../src/profile";
import { MemoryStore } from "./account-store";

const ORIGIN = "https://teza.example";
const PASSWORD = "correct horse battery";

let store: MemoryStore;
let clock: number;
let queue: QueueHost;
let rooms: { code: string; players: string[] }[]; // what the queue registered with the Match objects
let roomsRefused: number; // how many registrations to refuse (a code already in use) before accepting
let roomsHang: boolean; // registrations never answer (a hung Match object)

beforeEach(() => {
  store = new MemoryStore();
  clock = 1_700_000_000_000;
  rooms = [];
  roomsRefused = 0;
  roomsHang = false;
  const cooldowns = new Map<string, number>();
  queue = {
    matchmaker: new Matchmaker(() => clock, pairAllowed(store, cooldowns, () => clock)),
    cooldowns,
    openRoom: async (code, players) => {
      if (roomsHang) return new Promise<boolean>(() => {});
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
  rawCookie?: string; // a whole Cookie header, instead of `cookie`
  ip?: string; // CF-Connecting-IP
  origin?: string;
  contentType?: string | null;
}

function call(method: string, route: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = `${COOKIE_NAME}=${opts.cookie}`;
  if (opts.rawCookie) headers.Cookie = opts.rawCookie;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
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
  it("sets an HttpOnly, Secure, SameSite=Strict __Host- cookie on / for 30 days, expires the legacy one, and stores only its hash", async () => {
    for (const res of [
      await call("POST", "register", { body: { username: "Alice", password: PASSWORD } }),
      await call("POST", "login", { body: { username: "Alice", password: PASSWORD } }),
    ]) {
      const [cookie, legacy, ...rest] = res.headers.getSetCookie();
      expect(rest).toEqual([]);
      expect(COOKIE_NAME).toBe("__Host-teza_session");
      expect(cookie).toMatch(/^__Host-teza_session=[0-9a-f]{64}; /);
      const attrs = cookie.split("; ").slice(1);
      expect(attrs.sort()).toEqual(["HttpOnly", `Max-Age=${SESSION_TTL_S}`, "Path=/", "SameSite=Strict", "Secure"]);
      expect(cookie).not.toMatch(/domain/i);
      expect(legacy).toBe("teza_session=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0");
    }
    const token = tokenOf(await call("POST", "login", { body: { username: "Alice", password: PASSWORD } }));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.sessions.size).toBe(1);
    expect(store.sessions.has(token)).toBe(false);
  });

  it("still takes a session in the legacy teza_session cookie; the new cookie wins over it", async () => {
    const token = await register();
    const legacy = `${LEGACY_COOKIE_NAME}=${token}`;
    expect((await call("GET", "me", { rawCookie: legacy })).status).toBe(200);
    expect(await sessionKey(legacy, store, () => clock)).toBe("alice");
    expect(cookieToken(`${LEGACY_COOKIE_NAME}=${"b".repeat(64)}; ${COOKIE_NAME}=${token}`)).toBe(token);
    expect((await call("GET", "me", { rawCookie: `${LEGACY_COOKIE_NAME}=${"b".repeat(64)}; ${COOKIE_NAME}=${token}` })).status).toBe(200);
    expect((await call("GET", "me", { rawCookie: `${COOKIE_NAME}=${"b".repeat(64)}; ${LEGACY_COOKIE_NAME}=${token}` })).status).toBe(401);
  });

  it("logout expires both cookie names and deletes the sessions in either", async () => {
    const legacyToken = await register("Bob");
    const token = await register();
    const out = await call("POST", "logout", { rawCookie: `${COOKIE_NAME}=${token}; ${LEGACY_COOKIE_NAME}=${legacyToken}` });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toEqual([
      "__Host-teza_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      "teza_session=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0",
    ]);
    expect(store.sessions.size).toBe(0);
    const legacyOnly = await register("Carol");
    expect((await call("POST", "logout", { rawCookie: `${LEGACY_COOKIE_NAME}=${legacyOnly}` })).status).toBe(200);
    expect((await call("GET", "me", { rawCookie: `${LEGACY_COOKIE_NAME}=${legacyOnly}` })).status).toBe(401);
  });

  it("signing in ends the account's other sessions, and only that account's", async () => {
    const bob = await register("Bob");
    const first = await register();
    expect((await call("GET", "me", { cookie: first })).status).toBe(200);
    const second = tokenOf(await call("POST", "login", { body: { username: "alice", password: PASSWORD } }));
    expect((await call("GET", "me", { cookie: first })).status).toBe(401);
    expect((await call("GET", "me", { cookie: second })).status).toBe(200);
    expect((await call("GET", "me", { cookie: bob })).status).toBe(200);
    expect(store.sessions.size).toBe(2); // one per account

    const third = tokenOf(await call("POST", "login", { body: { username: "Alice", password: PASSWORD } }));
    expect((await call("GET", "me", { cookie: second })).status).toBe(401);
    expect((await call("GET", "me", { cookie: third })).status).toBe(200);
    // a failed login ends nothing
    expect((await call("POST", "login", { body: { username: "Alice", password: "wrong password!" } })).status).toBe(401);
    expect((await call("GET", "me", { cookie: third })).status).toBe(200);
    expect(store.sessions.size).toBe(2);
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

describe("account caps", () => {
  /** Adds accounts up to `n` in total without hashing a password for each, created at `at`. */
  function fill(n: number, at = clock): void {
    for (let i = store.accounts.size; i < n; i++) {
      store.insertAccount(`filler${i}`, { username: `filler${i}`, passwordHash: "x", createdAt: at, records: JSON.stringify({ vs: {} }) });
    }
  }
  const registerAs = (username: string) => call("POST", "register", { body: { username, password: PASSWORD } });

  it(`refuses a registration past ${MAX_REGISTRATIONS_PER_DAY} new accounts in 24 h with 503 and stores nothing; login still works`, async () => {
    await register();
    fill(MAX_REGISTRATIONS_PER_DAY);
    const sessions = store.sessions.size;
    const full = await registerAs("Bob");
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ error: "Registration is full right now." });
    expect(full.headers.get("Set-Cookie")).toBeNull();
    expect(store.accounts.size).toBe(MAX_REGISTRATIONS_PER_DAY);
    expect(store.account("bob")).toBeNull();
    expect(store.sessions.size).toBe(sessions);

    const login = await call("POST", "login", { body: { username: "Alice", password: PASSWORD } });
    expect(login.status).toBe(200);
    expect((await call("GET", "me", { cookie: tokenOf(login) })).status).toBe(200);
  });

  it("a script that fills the daily cap blocks sign-ups only until the window rolls", async () => {
    fill(MAX_REGISTRATIONS_PER_DAY); // the attack: the whole day's quota at once
    expect((await registerAs("Bob")).status).toBe(503);
    clock += REGISTRATION_WINDOW_MS; // the window is [now - 24 h, now]
    expect((await registerAs("Bob")).status).toBe(503);
    clock += 1; // the filler accounts are now older than the window
    expect((await registerAs("Bob")).status).toBe(201);
    expect(store.account("bob")).not.toBeNull();
  });

  it(`counts only accounts created in the window, up to the ${MAX_ACCOUNTS} storage backstop`, async () => {
    fill(MAX_ACCOUNTS - 1, clock - REGISTRATION_WINDOW_MS - 1); // all older than a day
    expect((await registerAs("Alice")).status).toBe(201);
    expect(store.accounts.size).toBe(MAX_ACCOUNTS);
    expect((await registerAs("Bob")).status).toBe(503);
    expect(store.accounts.size).toBe(MAX_ACCOUNTS);
  });

  it(`lets one IP register ${MAX_REGISTRATIONS_PER_IP} accounts per 24 h, then answers 429 with Retry-After`, async () => {
    const from = (username: string, ip: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) {
      expect((await from(`user${i}`, "203.0.113.7")).status).toBe(201);
      clock += 1000;
    }
    const sixth = await from("user5", "203.0.113.7");
    expect(sixth.status).toBe(429);
    const wait = Math.ceil((REGISTRATION_WINDOW_MS + 1 - MAX_REGISTRATIONS_PER_IP * 1000) / 1000);
    expect(sixth.headers.get("Retry-After")).toBe(String(wait));
    expect(await sixth.json()).toMatchObject({ retryAfter: wait });
    expect(store.account("user5")).toBeNull();
    expect((await from("other", "198.51.100.2")).status).toBe(201); // another IP is not affected
    expect([...store.registrations].map((r) => r.ipHash).some((h) => h.includes("203.0.113.7"))).toBe(false); // hashed

    clock += REGISTRATION_WINDOW_MS - MAX_REGISTRATIONS_PER_IP * 1000 + 1; // the first one is now older than the window
    expect((await from("user5", "203.0.113.7")).status).toBe(201);
    expect((await from("user6", "203.0.113.7")).status).toBe(429);
    expect(store.registrations.every((r) => r.at >= clock - REGISTRATION_WINDOW_MS)).toBe(true); // older rows pruned
  });

  it("counts IPv6 sign-ups per /64", async () => {
    const from = (username: string, ip: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) {
      expect((await from(`user${i}`, i % 2 ? "2001:db8:1:2:ffff::b" : "2001:db8:1:2::a")).status).toBe(201);
    }
    expect((await from("user5", "2001:db8:1:2::c")).status).toBe(429);
    expect((await from("user6", "2001:0DB8:0001:0002:0:0:0:d")).status).toBe(429); // the same /64, written longhand
    expect((await from("other", "2001:db8:1:3::a")).status).toBe(201); // the next /64
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address", async () => {
    const from = (username: string, ip: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) {
      expect((await from(`user${i}`, i % 2 ? "::ffff:203.0.113.7" : "203.0.113.7")).status).toBe(201);
    }
    expect((await from("user5", "::ffff:203.0.113.7")).status).toBe(429);
    expect((await from("user6", "203.0.113.7")).status).toBe(429);
  });

  it(`counts IPv6 sign-ups per /48 too, up to ${MAX_REGISTRATIONS_PER_PREFIX}`, async () => {
    const from = (username: string, ip: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip });
    for (let net = 0; net < MAX_REGISTRATIONS_PER_PREFIX / MAX_REGISTRATIONS_PER_IP; net++) {
      for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) {
        expect((await from(`user${net}_${i}`, `2001:db8:1:${net}::${i + 1}`)).status).toBe(201);
      }
    }
    expect((await from("fresh", "2001:db8:1:ff::1")).status).toBe(429); // a fresh /64 in the full /48
    expect(store.account("fresh")).toBeNull();
    expect((await from("other", "2001:db8:2::a")).status).toBe(201); // another /48
  });

  it("answers Retry-After with the longer of the /64 and /48 waits", async () => {
    const from = (username: string, ip: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_PREFIX - MAX_REGISTRATIONS_PER_IP; i++) {
      expect((await from(`early${i}`, `2001:db8:1:${1 + (i % 3)}::${i + 1}`)).status).toBe(201);
    }
    clock += 3_600_000;
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) expect((await from(`late${i}`, `2001:db8:1:a::${i + 1}`)).status).toBe(201);
    const prefixWait = Math.ceil((REGISTRATION_WINDOW_MS + 1 - 3_600_000) / 1000); // the /48 frees up first
    const sameNet = await from("sameNet", "2001:db8:1:a::99");
    expect(sameNet.headers.get("Retry-After")).toBe(String(Math.ceil((REGISTRATION_WINDOW_MS + 1) / 1000)));
    expect((await from("freshNet", "2001:db8:1:b::1")).headers.get("Retry-After")).toBe(String(prefixWait));
  });

  it("ipBuckets normalises addresses to their quota buckets", () => {
    const keys = (ip: string) => ipBuckets(ip).map((b) => `${b.key} ${b.limit}`);
    const v6 = (k64: string, k48: string) => [`${k64} ${MAX_REGISTRATIONS_PER_IP}`, `${k48} ${MAX_REGISTRATIONS_PER_PREFIX}`];
    expect(keys("203.0.113.7")).toEqual([`203.0.113.7 ${MAX_REGISTRATIONS_PER_IP}`]);
    expect(keys("2001:db8::1")).toEqual(v6("2001:0db8:0000:0000::/64", "2001:0db8:0000::/48"));
    expect(keys("2001:0DB8:0:0::1")).toEqual(keys("2001:db8::1"));
    expect(keys("2001:db8:1:2:3:4:5:6")).toEqual(v6("2001:0db8:0001:0002::/64", "2001:0db8:0001::/48"));
    expect(keys("::1")).toEqual(v6("0000:0000:0000:0000::/64", "0000:0000:0000::/48"));
    expect(keys("::")).toEqual(keys("::1"));
    expect(keys("2001:db8:1:2::")).toEqual(keys("2001:db8:1:2:3:4:5:6"));
    expect(keys("::ffff:203.0.113.7")).toEqual(keys("203.0.113.7"));
    expect(keys("::FFFF:cb00:7107")).toEqual(keys("203.0.113.7"));
    expect(keys("fe80::1%eth0")).toEqual(v6("fe80:0000:0000:0000::/64", "fe80:0000:0000::/48"));
    for (const bad of ["", "nope", "1.2.3", "1.2.3.256", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4::5:6:7:8", "12345::1", "::ffff:999.1.1.1", "::ffff:1.256.0.0"]) {
      expect(ipBuckets(bad), bad).toEqual([{ key: INVALID_IP_BUCKET, limit: MAX_REGISTRATIONS_PER_IP }]);
    }
  });

  it("checks the per-IP quota again after hashing", async () => {
    const from = (username: string) => call("POST", "register", { body: { username, password: PASSWORD }, ip: "203.0.113.7" });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_IP - 1; i++) expect((await from(`user${i}`)).status).toBe(201);
    const [a, b] = await Promise.all([from("Alice"), from("Bob")]);
    expect([a.status, b.status].sort()).toEqual([201, 429]);
  });

  it("checks the cap again after hashing, for registrations that overlap", async () => {
    fill(MAX_REGISTRATIONS_PER_DAY - 1);
    const [a, b] = await Promise.all([registerAs("Alice"), registerAs("Bob")]);
    expect([a.status, b.status].sort()).toEqual([201, 503]);
    expect(store.accounts.size).toBe(MAX_REGISTRATIONS_PER_DAY);
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

describe("ranked hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Until the registration's timeout is armed (the session lookup before it hashes with real async crypto). */
  async function timerArmed(): Promise<void> {
    // setInterval is left real (only setTimeout and clearTimeout are faked), so it yields to the event loop
    while (vi.getTimerCount() === 0) {
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          clearInterval(tick);
          resolve();
        }, 1);
      });
    }
  }

  /** Queue both, read the match, and rate it as a win for `a` at the test clock. */
  async function playRated(a: string, b: string): Promise<void> {
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    const status = await (await call("GET", "queue/status", { cookie: a })).json();
    expect(status.status).toBe("matched");
    await call("GET", "queue/status", { cookie: b });
    expect(rateRankedMatch(store, status.code, store.rankedMatch(status.code)!.keys[0], () => clock)).not.toBeNull();
  }

  it(`pairs the same two accounts at most ${MAX_PAIR_RATED} times in 24 h; a third account in range is paired instead`, async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    for (let i = 0; i < MAX_PAIR_RATED; i++) {
      await playRated(a, b);
      clock += 60_000;
    }
    expect(store.pairCount("bob", "alice", clock - PAIR_WINDOW_MS)).toBe(MAX_PAIR_RATED);

    // at the cap: both stay in the queue
    const before = rooms.length;
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toHaveLength(before);
    expect(queue.matchmaker.size).toBe(2);
    expect((await (await call("GET", "queue/status", { cookie: a })).json()).status).toBe("waiting");
    expect((await (await call("GET", "queue/status", { cookie: b })).json()).status).toBe("waiting");

    // a third account in range pairs with one of them
    const c = await register("Carol");
    await call("POST", "queue/join", { cookie: c });
    expect(rooms).toHaveLength(before + 1);
    expect(rooms[before].players).toContain("carol");
    expect(queue.matchmaker.size).toBe(1);
    await call("POST", "queue/leave", { cookie: a });
    await call("POST", "queue/leave", { cookie: b });
    await call("POST", "queue/leave", { cookie: c });

    // 24 h after the first of those matches, the pair is under the cap again
    clock += PAIR_WINDOW_MS - MAX_PAIR_RATED * 60_000 + 1;
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toHaveLength(before + 2);
    expect(rooms[before + 1].players.sort()).toEqual(["alice", "bob"]);
  });

  it("pairs a pair below the cap as before", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    for (let i = 0; i < MAX_PAIR_RATED - 1; i++) await playRated(a, b);
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    expect(rooms).toHaveLength(MAX_PAIR_RATED);
  });

  it("prunes pair records older than the window when a match is rated", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await playRated(a, b);
    clock += PAIR_WINDOW_MS + 1;
    await playRated(a, b);
    expect(store.pairs).toHaveLength(1);
  });

  it("a no-show drops the room unrated and cools the absent account down; the other can queue at once", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    const code = rooms[0].code;
    expect(reportNoShow(queue, store, "ZZZZZZ", "bob", () => clock)).toBe(false);
    expect(reportNoShow(queue, store, code, "mallory", () => clock)).toBe(false);
    expect(queue.cooldowns.size).toBe(0);
    expect(reportNoShow(queue, store, code, "bob", () => clock)).toBe(true);
    expect(store.rankedMatch(code)).toBeNull();
    expect(store.ratings.size).toBe(0);
    expect(reportNoShow(queue, store, code, "bob", () => clock)).toBe(false); // once

    const refused = await call("POST", "queue/join", { cookie: b });
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.retryAfter).toBe(NO_SHOW_COOLDOWN_MS / 1000);
    expect(typeof body.error).toBe("string");
    expect(refused.headers.get("Retry-After")).toBe(String(NO_SHOW_COOLDOWN_MS / 1000));
    expect((await call("POST", "queue/join", { cookie: a })).status).toBe(200);

    clock += NO_SHOW_COOLDOWN_MS - 1500;
    const later = await call("POST", "queue/join", { cookie: b });
    expect(later.status).toBe(429);
    expect((await later.json()).retryAfter).toBe(2); // rounded up
    clock += 1500;
    expect((await call("POST", "queue/join", { cookie: b })).status).toBe(200);
    expect(queue.cooldowns.size).toBe(0);
  });

  it("counts the pair's open rooms toward the cap: matching again and again opens at most 3, and at most 3 are rated", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    for (let i = 0; i < 5; i++) {
      await call("POST", "queue/join", { cookie: a });
      await call("POST", "queue/join", { cookie: b });
      await call("GET", "queue/status", { cookie: a });
      await call("GET", "queue/status", { cookie: b });
    }
    expect(rooms).toHaveLength(MAX_PAIR_RATED);
    expect(queue.matchmaker.size).toBe(2); // the rest wait for other opponents
    const rated = rooms.filter((r) => rateRankedMatch(store, r.code, "alice", () => clock) !== null);
    expect(rated).toHaveLength(MAX_PAIR_RATED);
  });

  it("rates at most MAX_PAIR_RATED of a pair's rooms however they were opened", async () => {
    await register("Alice");
    await register("Bob");
    for (const code of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"]) store.insertRankedMatch(code, { keys: ["alice", "bob"], createdAt: clock });
    const results = ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"].map((code) => rateRankedMatch(store, code, "bob", () => clock));
    expect(results.filter((r) => r !== null)).toHaveLength(MAX_PAIR_RATED);
    expect(store.ratings.get("bob")!.games).toBe(MAX_PAIR_RATED);
    expect(store.rankedMatch("DDDDDD")).toBeNull(); // dropped unrated
  });

  it("a dodger who re-joined before the no-show report is taken out of the queue and not paired until the cooldown ends", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    const c = await register("Carol");
    await call("POST", "queue/join", { cookie: a });
    await call("POST", "queue/join", { cookie: b });
    const code = rooms[0].code;
    await call("POST", "queue/leave", { cookie: a });
    await call("POST", "queue/join", { cookie: b }); // back in the queue before the lobby times out
    expect(reportNoShow(queue, store, code, "bob", () => clock)).toBe(true);

    await call("POST", "queue/join", { cookie: c });
    expect(rooms).toHaveLength(1); // carol is not paired with bob
    expect(await (await call("GET", "queue/status", { cookie: b })).json()).toEqual({ status: "none" });
    expect((await call("POST", "queue/join", { cookie: b })).status).toBe(429);

    // a cooling key is never paired, even if it got into the queue some other way
    queue.cooldowns.set("bob", clock + NO_SHOW_COOLDOWN_MS);
    queue.matchmaker.join({ key: "bob", username: "Bob" }, 12500);
    await call("GET", "queue/status", { cookie: c });
    expect(rooms).toHaveLength(1);
    queue.matchmaker.leave("bob");

    for (let t = 0; t < NO_SHOW_COOLDOWN_MS; t += 10_000) {
      clock += 10_000;
      await call("GET", "queue/status", { cookie: c }); // carol keeps her entry alive
    }
    expect((await call("POST", "queue/join", { cookie: b })).status).toBe(200);
    expect(rooms).toHaveLength(2);
    expect(rooms[1].players.sort()).toEqual(["bob", "carol"]);
  });

  it("bounds a hung room registration: join and status answer after the timeout, requeue, and pair later", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await call("POST", "queue/join", { cookie: a });
    roomsHang = true;
    let answered = false;
    const join = call("POST", "queue/join", { cookie: b }).then((r) => ((answered = true), r));
    await timerArmed();
    await vi.advanceTimersByTimeAsync(OPEN_ROOM_TIMEOUT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await join).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0); // the timeout timer is gone
    expect(queue.matchmaker.size).toBe(2); // requeued

    let polled = false;
    const poll = call("GET", "queue/status", { cookie: a }).then((r) => ((polled = true), r));
    await timerArmed();
    await vi.advanceTimersByTimeAsync(OPEN_ROOM_TIMEOUT_MS);
    expect(polled).toBe(true);
    expect((await (await poll).json()).status).toBe("waiting");

    roomsHang = false;
    const ok = await call("GET", "queue/status", { cookie: a });
    expect(vi.getTimerCount()).toBe(0); // cleared when the registration answered
    expect((await ok.json()).status).toBe("matched");
    expect(rooms).toHaveLength(1);
  });

  it("reads the session token from a Cookie header only when well-formed", () => {
    const token = "a".repeat(64);
    expect(cookieToken(`${COOKIE_NAME}=${token}`)).toBe(token);
    expect(cookieToken(`x=1; ${COOKIE_NAME}=${token}`)).toBe(token);
    expect(cookieToken(null)).toBeNull();
    expect(cookieToken("")).toBeNull();
    expect(cookieToken("other=1")).toBeNull();
    expect(cookieToken(`${COOKIE_NAME}=short`)).toBeNull();
    expect(cookieToken(`${COOKIE_NAME}=${"G".repeat(64)}`)).toBeNull();
    expect(cookieToken(`${LEGACY_COOKIE_NAME}=${token}`)).toBe(token);
    expect(cookieToken(`Host-teza_session=${token}`)).toBeNull();
  });
});
