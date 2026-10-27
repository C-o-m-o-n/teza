// Player accounts: register, login, logout, profile and records sync over JSON at
// /api/account/*. Runtime-independent: the `Accounts` Durable Object in worker/index.ts
// passes each request in with a SQLite-backed store, and the tests use an in-memory one.
//
// Passwords are stored only as PBKDF2-SHA-256 (random 16-byte salt, 100000 iterations,
// both kept inside the stored value). Sessions are a random 32-byte token in an HttpOnly
// `__Host-` cookie; only its SHA-256 is stored. Signing in ends the account's other sessions, and
// registration is capped per day (MAX_REGISTRATIONS_PER_DAY) and, as a storage backstop, in total (MAX_ACCOUNTS).
//
// Ratings (rating.ts) are kept per account; an account without a row has the default rating.
// The ranked queue (/api/account/queue/*, matchmaking.ts) pairs signed-in players, and each
// pairing's room is recorded so that its result can be rated once (`rateRankedMatch`).
//
// Hardening for a public ranked ladder: the same two accounts get at most MAX_PAIR_RATED rooms
// per PAIR_WINDOW_MS, counting rated matches and rooms still open (`pairAllowed`, checked again
// when a match is rated), an account that never connects to its ranked room is taken out of the
// queue and kept out for NO_SHOW_COOLDOWN_MS (`reportNoShow`), and registering a room with its
// `Match` object is bounded by OPEN_ROOM_TIMEOUT_MS.

import { mergeRecords, MAX_BOT_NAMES, passwordError, Records, recordsError, usernameError } from "../profile";
import { Matchmaker, QueuePlayer } from "./matchmaking";
import { newRoomCode } from "./match";
import { calcTR, DEFAULT_RATING, Rating, tdisplay, updateGlicko2 } from "./rating";

/** `__Host-`: the browser only takes it Secure, Path=/ and without Domain, so a sibling subdomain can't set or shadow it. */
export const COOKIE_NAME = "__Host-teza_session";
/** The name before `__Host-` (Path=/api). Read only, as a fallback; remove 30 days (SESSION_TTL_S) after the rename is deployed. */
export const LEGACY_COOKIE_NAME = "teza_session";
// Registration answers 503 once REGISTRATION_WINDOW_MS has seen MAX_REGISTRATIONS_PER_DAY new accounts, so
// filling the cap blocks sign-ups for one window at most, not for good; MAX_ACCOUNTS only bounds storage.
export const MAX_REGISTRATIONS_PER_DAY = 500;
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ACCOUNTS = 200_000;
// In front of the daily cap, each client IP (`CF-Connecting-IP`, set by Cloudflare) may register this many
// accounts per REGISTRATION_WINDOW_MS (429 past it), so one machine can't use up the whole day's quota.
// Only a SHA-256 of the IP is stored. Without the header (never on Cloudflare) the per-IP check is skipped.
export const MAX_REGISTRATIONS_PER_IP = 5;
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
export const PBKDF2_ITERATIONS = 100_000; // the Workers WebCrypto maximum
export const MAX_BODY_BYTES = 4096;
const SALT_BYTES = 16;
const TOKEN = /^[0-9a-f]{64}$/;
const LOGIN_FAILED = "Wrong username or password.";

export interface AccountRow {
  username: string; // original case
  passwordHash: string; // "pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>"
  createdAt: number; // ms
  records: string; // JSON Records
}

export interface SessionRow {
  key: string; // lower-cased username
  expiresAt: number; // ms
}

export interface RatingRow extends Rating {
  games: number; // ranked matches rated
}

/** A calibrated account (RD <= RD_HIDDEN) as the public leaderboard reads it (leaderboard.ts). */
export interface CalibratedRow {
  key: string; // lower-cased username
  username: string; // original case
  createdAt: number; // ms
  r: number;
  rd: number;
  games: number;
}

/** A room the matchmaker opened, until its result is rated. `keys` in pairing order. */
export interface RankedMatchRow {
  keys: [string, string];
  createdAt: number; // ms
}

/** Accounts are keyed by the lower-cased username, which makes names unique regardless of case. */
export interface AccountStore {
  account(key: string): AccountRow | null;
  /** False (and nothing written) if `key` is taken. */
  insertAccount(key: string, row: AccountRow): boolean;
  accountCount(): number;
  /** Accounts created at or after `since` (ms). */
  accountsCreatedSince(since: number): number;
  /** When accounts were registered from the IP hash `ipHash` at or after `since` (ms), oldest first. */
  registrationsFrom(ipHash: string, since: number): number[];
  /** Records a registration from `ipHash` at `at`, and deletes records older than REGISTRATION_WINDOW_MS. */
  insertRegistration(ipHash: string, at: number): void;
  setRecords(key: string, records: string): void;
  session(tokenHash: string): SessionRow | null;
  insertSession(tokenHash: string, row: SessionRow): void;
  deleteSession(tokenHash: string): void;
  /** Every session of the account `key`. */
  deleteSessionsFor(key: string): void;
  deleteExpiredSessions(now: number): void;
  /** Null for an account that has never been rated. */
  rating(key: string): RatingRow | null;
  /** Read-only: every account whose rating has RD <= RD_HIDDEN, in no particular order. */
  calibrated(): CalibratedRow[];
  rankedMatch(code: string): RankedMatchRow | null;
  insertRankedMatch(code: string, row: RankedMatchRow): void;
  /** False if there was no such match. */
  deleteRankedMatch(code: string): boolean;
  deleteRankedMatchesBefore(createdAt: number): void;
  /**
   * In one transaction: delete the ranked match `code`, write the new ratings, record the pair of
   * accounts as rated at `at`, and prune pair records older than PAIR_WINDOW_MS. False (and
   * nothing written) if the match is no longer there, so a match is rated at most once.
   */
  rateMatch(code: string, ratings: [string, RatingRow][], at: number): boolean;
  /** Rated matches between the two accounts (either order) at or after `since`. */
  pairCount(keyA: string, keyB: string, since: number): number;
  /** Unrated ranked matches between the two accounts (either order) created at or after `since`. */
  openMatchCount(keyA: string, keyB: string, since: number): number;
}

export const RANKED_MATCH_TTL_MS = 6 * 60 * 60 * 1000; // an unrated ranked room is forgotten after this
const ROOM_ATTEMPTS = 3; // codes tried before a pairing goes back into the queue
export const OPEN_ROOM_TIMEOUT_MS = 3000; // one room registration (RPC to `Match`) may take this long
export const MAX_PAIR_RATED = 3; // rated matches the same two accounts may play per PAIR_WINDOW_MS
export const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NO_SHOW_COOLDOWN_MS = 120_000; // an account that skipped its ranked room waits this long to queue again

/** How the accounts API reaches the ranked queue and the match rooms (the Accounts Durable Object). */
export interface QueueHost {
  matchmaker: Matchmaker;
  /** Register `code` as a ranked room for the two players. False if that code is already in use. */
  openRoom(code: string, players: [QueuePlayer, QueuePlayer]): Promise<boolean>;
  /** Account key to the time (ms) its no-show cooldown ends. In memory: a restart forgets it. */
  cooldowns: Map<string, number>;
}

const ROUTES: Record<string, string> = {
  register: "POST", login: "POST", logout: "POST", me: "GET", records: "PUT",
  "queue/join": "POST", "queue/status": "GET", "queue/leave": "POST",
};

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  return new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

/** Constant-time comparison of the derived key against the stored one. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !salt || !hash) return false;
  return equalBytes(await pbkdf2(password, unhex(salt), Number(iterations)), unhex(hash));
}

// Unknown usernames are checked against this, so they take as long as a wrong password.
let dummyHash: Promise<string> | null = null;

async function sha256(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))));
}

/** `headers` may repeat a name (two `Set-Cookie`s). */
function json(status: number, body: unknown, headers: [string, string][] | Record<string, string> = {}): Response {
  const h = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const [name, value] of Array.isArray(headers) ? headers : Object.entries(headers)) h.append(name, value);
  return new Response(JSON.stringify(body), { status, headers: h });
}

const fail = (status: number, message: string, headers?: Record<string, string>) => json(status, { error: message }, headers);

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`;
}

const CLEAR_COOKIE = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
const CLEAR_LEGACY_COOKIE = `${LEGACY_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`;

/** The well-formed token in the cookie `name` of a `Cookie` header, or null. */
function cookieValue(cookie: string | null, name: string): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name && value !== undefined && TOKEN.test(value)) return value;
  }
  return null;
}

/**
 * The well-formed session token in a `Cookie` header, or null: `__Host-teza_session`, else the legacy
 * `teza_session`. The Worker uses it to refuse a ranked socket without a session before calling the
 * `Accounts` object.
 */
export function cookieToken(cookie: string | null): string | null {
  return cookieValue(cookie, COOKIE_NAME) ?? cookieValue(cookie, LEGACY_COOKIE_NAME);
}

/** The body as text, or null if it is over MAX_BODY_BYTES. Stops reading once over the limit. */
export async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function profile(row: AccountRow) {
  return { username: row.username, createdAt: row.createdAt, records: JSON.parse(row.records) as Records };
}

/**
 * The account key a `Cookie` header's session belongs to, or null. Expired sessions are deleted.
 * Shared by the accounts API and the Worker's ranked-socket check (worker/index.ts).
 */
export async function sessionKey(cookie: string | null, store: AccountStore, now: () => number = Date.now): Promise<string | null> {
  const token = cookieToken(cookie);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const session = store.session(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= now()) {
    store.deleteSession(tokenHash);
    return null;
  }
  return store.account(session.key) ? session.key : null;
}

function ratingOf(store: AccountStore, key: string): RatingRow {
  return store.rating(key) ?? { ...DEFAULT_RATING, games: 0 };
}

/** What a client may see of a rating: the TR (null while hidden) and the games count, never r/RD/vol. */
export function publicRating(row: RatingRow): { tr: number | null; games: number } {
  return { tr: tdisplay(row.r, row.rd), games: row.games };
}

/** One player's side of a rated match: the TR after it (null if hidden) and the change, if both TRs are visible. */
export interface RatingChange {
  key: string;
  tr: number | null;
  delta: number | null;
}

/**
 * Rate the result of ranked match `code`: `winnerKey` won (score 1, the other 0), or null for a
 * draw (0.5 each). Each player is updated against the other's pre-match rating. Null if `code`
 * is not an unrated ranked match or `winnerKey` is not one of its players; nothing changes then.
 */
export function rateRankedMatch(
  store: AccountStore, code: string, winnerKey: string | null, now: () => number = Date.now,
): [RatingChange, RatingChange] | null {
  const match = store.rankedMatch(code);
  if (!match || (winnerKey !== null && !match.keys.includes(winnerKey))) return null;
  if (store.pairCount(match.keys[0], match.keys[1], now() - PAIR_WINDOW_MS) >= MAX_PAIR_RATED) {
    store.deleteRankedMatch(code); // over the pair cap however the room was opened: nobody is rated
    return null;
  }
  const before = match.keys.map((k) => ratingOf(store, k));
  const after = match.keys.map((k, i): RatingRow => {
    const score = winnerKey === null ? 0.5 : winnerKey === k ? 1 : 0;
    return { ...updateGlicko2(before[i], before[1 - i], score), games: before[i].games + 1 };
  });
  if (!store.rateMatch(code, match.keys.map((k, i): [string, RatingRow] => [k, after[i]]), now())) return null;
  const change = (i: number): RatingChange => {
    const was = tdisplay(before[i].r, before[i].rd);
    const tr = tdisplay(after[i].r, after[i].rd);
    return { key: match.keys[i], tr, delta: was !== null && tr !== null ? tr - was : null };
  };
  return [change(0), change(1)];
}

/**
 * The matchmaker's pair predicate (`Matchmaker`'s `mayPair`): false while either account is on a
 * no-show cooldown, or once the two accounts' rated matches in the last PAIR_WINDOW_MS plus their
 * rooms still open reach MAX_PAIR_RATED (so opening rooms faster than they are rated can't pass it).
 */
export function pairAllowed(
  store: AccountStore, cooldowns: Map<string, number>, now: () => number = Date.now,
): (a: string, b: string) => boolean {
  const cooling = (key: string) => (cooldowns.get(key) ?? 0) > now();
  return (a, b) => !cooling(a) && !cooling(b) &&
    store.pairCount(a, b, now() - PAIR_WINDOW_MS) + store.openMatchCount(a, b, now() - RANKED_MATCH_TTL_MS) < MAX_PAIR_RATED;
}

/**
 * RPC from a ranked `Match` whose lobby timed out with only one of its accounts connected: forget
 * the room without rating anyone, take the absent account out of the queue (it may have joined
 * again meanwhile) and keep it out for NO_SHOW_COOLDOWN_MS. False (nothing changes) if `code` is
 * not an unrated ranked match or `absentKey` is not one of its players.
 */
export function reportNoShow(host: QueueHost, store: AccountStore, code: string, absentKey: string, now: () => number = Date.now): boolean {
  const match = store.rankedMatch(code);
  if (!match || !match.keys.includes(absentKey)) return false;
  if (!store.deleteRankedMatch(code)) return false;
  host.cooldowns.set(absentKey, now() + NO_SHOW_COOLDOWN_MS);
  host.matchmaker.leave(absentKey);
  return true;
}

/** `promise`, or a rejection once `ms` pass first. The timer is cleared when the promise settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let clear = () => {};
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    clear = () => clearTimeout(timer);
  });
  return Promise.race([promise, timeout]).finally(clear);
}

/**
 * Open a room for every pairing the queue has now; a pairing without a room goes back into the
 * queue. A registration that throws or takes over OPEN_ROOM_TIMEOUT_MS ends the pairing's attempts.
 */
async function openPairings(host: QueueHost, store: AccountStore, now: () => number): Promise<void> {
  for (const pairing of host.matchmaker.pair()) {
    let code: string | null = null;
    for (let i = 0; i < ROOM_ATTEMPTS && code === null; i++) {
      const candidate = newRoomCode();
      try {
        if (await withTimeout(host.openRoom(candidate, pairing.players), OPEN_ROOM_TIMEOUT_MS)) code = candidate;
      } catch {
        break;
      }
    }
    if (code === null) {
      host.matchmaker.requeue(pairing);
      continue;
    }
    store.deleteRankedMatchesBefore(now() - RANKED_MATCH_TTL_MS);
    store.insertRankedMatch(code, { keys: [pairing.players[0].key, pairing.players[1].key], createdAt: now() });
    host.matchmaker.matchedTo(pairing, code);
  }
}

/** Handles one request to /api/account/<route>. `now` is the clock in ms; `queue` hosts the ranked queue (404 without). */
export async function handleAccount(
  request: Request, store: AccountStore, now: () => number = Date.now, queue?: QueueHost,
): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.startsWith("/api/account/") ? url.pathname.slice("/api/account/".length) : "";
  if (!Object.hasOwn(ROUTES, route) || (route.startsWith("queue/") && !queue)) return fail(404, "Not found.");
  const method = ROUTES[route];
  if (request.method !== method) return fail(405, "Method not allowed.", { Allow: method });

  let body: Record<string, unknown> = {};
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return fail(403, "Cross-origin request refused.");
    const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return fail(415, "Content-Type must be application/json.");
    const text = await readBody(request);
    if (text === null) return fail(413, `Body must be at most ${MAX_BODY_BYTES} bytes.`);
    if (route !== "logout") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail(400, "Body must be JSON.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail(400, "Body must be a JSON object.");
      body = parsed as Record<string, unknown>;
    }
  }

  const signIn = async (key: string, status: number): Promise<Response> => {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256(token);
    store.deleteExpiredSessions(now());
    store.deleteSessionsFor(key); // signing in ends the account's other sessions, so it has one at most
    store.insertSession(tokenHash, { key, expiresAt: now() + SESSION_TTL_S * 1000 });
    return json(status, profile(store.account(key)!), [["Set-Cookie", sessionCookie(token)], ["Set-Cookie", CLEAR_LEGACY_COOKIE]]);
  };

  /** The signed-in account's key, or null. Expired sessions are deleted. */
  const currentKey = () => sessionKey(request.headers.get("Cookie"), store, now);

  switch (route) {
    case "register":
    case "login": {
      const { username, password } = body;
      const invalid = usernameError(username) ?? passwordError(password);
      if (invalid) return fail(400, invalid);
      const key = (username as string).toLowerCase();
      if (route === "register") {
        const full = () => fail(503, "Registration is full right now.");
        const isFull = () => store.accountsCreatedSince(now() - REGISTRATION_WINDOW_MS) >= MAX_REGISTRATIONS_PER_DAY ||
          store.accountCount() >= MAX_ACCOUNTS;
        const ip = request.headers.get("CF-Connecting-IP");
        const ipHash = ip === null ? null : await sha256(ip);
        /** Seconds until this IP may register again, or null if it may now. */
        const ipWait = (): number | null => {
          if (ipHash === null) return null;
          const times = store.registrationsFrom(ipHash, now() - REGISTRATION_WINDOW_MS);
          if (times.length < MAX_REGISTRATIONS_PER_IP) return null;
          // the window is [now - 24 h, now]: a registration stops counting 1 ms after it is 24 h old
          return Math.ceil((times[times.length - MAX_REGISTRATIONS_PER_IP] + REGISTRATION_WINDOW_MS + 1 - now()) / 1000);
        };
        const refused = (): Response | null => {
          const wait = ipWait();
          if (wait !== null) {
            return json(429, { error: "Too many new accounts from this network today. Try again later.", retryAfter: wait }, { "Retry-After": String(wait) });
          }
          return isFull() ? full() : null;
        };
        const before = refused();
        if (before) return before;
        if (store.account(key)) return fail(409, "That username is taken.");
        const row = { username: username as string, passwordHash: await hashPassword(password as string), createdAt: now(), records: JSON.stringify({ vs: {} }) };
        // checked again on insert: another register may have finished while this one was hashing
        const after = refused();
        if (after) return after;
        if (!store.insertAccount(key, row)) return fail(409, "That username is taken.");
        if (ipHash !== null) store.insertRegistration(ipHash, now());
        return signIn(key, 201);
      }
      const row = store.account(key);
      dummyHash ??= hashPassword("not a real password");
      const ok = await verifyPassword(password as string, row ? row.passwordHash : await dummyHash);
      if (!row || !ok) return fail(401, LOGIN_FAILED);
      return signIn(key, 200);
    }
    case "logout": {
      for (const name of [COOKIE_NAME, LEGACY_COOKIE_NAME]) {
        const token = cookieValue(request.headers.get("Cookie"), name);
        if (token) store.deleteSession(await sha256(token));
      }
      return json(200, {}, [["Set-Cookie", CLEAR_COOKIE], ["Set-Cookie", CLEAR_LEGACY_COOKIE]]);
    }
    case "me": {
      const key = await currentKey();
      if (!key) return fail(401, "Not signed in.");
      return json(200, { ...profile(store.account(key)!), rating: publicRating(ratingOf(store, key)) });
    }
    case "queue/join":
    case "queue/status":
    case "queue/leave": {
      const key = await currentKey();
      if (!key) return fail(401, "Not signed in.");
      const mm = queue!.matchmaker;
      if (route === "queue/leave") {
        mm.leave(key);
        return json(200, { status: "none" });
      }
      if (route === "queue/join") {
        const until = queue!.cooldowns.get(key) ?? 0;
        if (until > now()) {
          const retryAfter = Math.ceil((until - now()) / 1000);
          return json(429, { error: `You missed a ranked match. You can search again in ${retryAfter} s.`, retryAfter }, {
            "Retry-After": String(retryAfter),
          });
        }
        queue!.cooldowns.delete(key);
        // the internal TR, hidden or not, so new players are matched too
        const r = ratingOf(store, key);
        mm.join({ key, username: store.account(key)!.username }, calcTR(r.r, r.rd));
        await openPairings(queue!, store, now);
        return json(200, { status: "waiting" });
      }
      mm.touch(key); // the poll keeps the entry alive before the pairing pass drops stale ones
      await openPairings(queue!, store, now);
      return json(200, mm.status(key));
    }
    default: { // records
      const key = await currentKey();
      if (!key) return fail(401, "Not signed in.");
      const invalid = recordsError(body.records);
      if (invalid) return fail(400, invalid);
      const merged = mergeRecords(profile(store.account(key)!).records, body.records as Records);
      if (Object.keys(merged.vs).length > MAX_BOT_NAMES) return fail(400, `vs has more than ${MAX_BOT_NAMES} bot names`);
      store.setRecords(key, JSON.stringify(merged));
      return json(200, { records: merged });
    }
  }
}
