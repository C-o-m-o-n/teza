// Player accounts: register, login, logout, profile and records sync over JSON at
// /api/account/*. Runtime-independent: the `Accounts` Durable Object in worker/index.ts
// passes each request in with a SQLite-backed store, and the tests use an in-memory one.
//
// Passwords are stored only as PBKDF2-SHA-256 (random 16-byte salt, 100000 iterations,
// both kept inside the stored value). Sessions are a random 32-byte token in an HttpOnly
// cookie; only its SHA-256 is stored.

import { mergeRecords, MAX_BOT_NAMES, passwordError, Records, recordsError, usernameError } from "../profile";

export const COOKIE_NAME = "teza_session";
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

/** Accounts are keyed by the lower-cased username, which makes names unique regardless of case. */
export interface AccountStore {
  account(key: string): AccountRow | null;
  /** False (and nothing written) if `key` is taken. */
  insertAccount(key: string, row: AccountRow): boolean;
  setRecords(key: string, records: string): void;
  session(tokenHash: string): SessionRow | null;
  insertSession(tokenHash: string, row: SessionRow): void;
  deleteSession(tokenHash: string): void;
  deleteExpiredSessions(now: number): void;
}

const ROUTES: Record<string, string> = { register: "POST", login: "POST", logout: "POST", me: "GET", records: "PUT" };

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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

const fail = (status: number, message: string, headers?: Record<string, string>) => json(status, { error: message }, headers);

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${SESSION_TTL_S}`;
}

const CLEAR_COOKIE = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`;

function cookieToken(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE_NAME && value !== undefined && TOKEN.test(value)) return value;
  }
  return null;
}

/** The body as text, or null if it is over MAX_BODY_BYTES. Stops reading once over the limit. */
async function readBody(request: Request): Promise<string | null> {
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

/** Handles one request to /api/account/<route>. `now` is the clock in ms. */
export async function handleAccount(request: Request, store: AccountStore, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.startsWith("/api/account/") ? url.pathname.slice("/api/account/".length) : "";
  if (!Object.hasOwn(ROUTES, route)) return fail(404, "Not found.");
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
    store.deleteExpiredSessions(now());
    store.insertSession(await sha256(token), { key, expiresAt: now() + SESSION_TTL_S * 1000 });
    return json(status, profile(store.account(key)!), { "Set-Cookie": sessionCookie(token) });
  };

  /** The signed-in account's key, or null. Expired sessions are deleted. */
  const currentKey = async (): Promise<string | null> => {
    const token = cookieToken(request);
    if (!token) return null;
    const tokenHash = await sha256(token);
    const session = store.session(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      store.deleteSession(tokenHash);
      return null;
    }
    return store.account(session.key) ? session.key : null;
  };

  switch (route) {
    case "register":
    case "login": {
      const { username, password } = body;
      const invalid = usernameError(username) ?? passwordError(password);
      if (invalid) return fail(400, invalid);
      const key = (username as string).toLowerCase();
      if (route === "register") {
        if (store.account(key)) return fail(409, "That username is taken.");
        const row = { username: username as string, passwordHash: await hashPassword(password as string), createdAt: now(), records: JSON.stringify({ vs: {} }) };
        // checked again on insert: another register may have finished while this one was hashing
        if (!store.insertAccount(key, row)) return fail(409, "That username is taken.");
        return signIn(key, 201);
      }
      const row = store.account(key);
      dummyHash ??= hashPassword("not a real password");
      const ok = await verifyPassword(password as string, row ? row.passwordHash : await dummyHash);
      if (!row || !ok) return fail(401, LOGIN_FAILED);
      return signIn(key, 200);
    }
    case "logout": {
      const token = cookieToken(request);
      if (token) store.deleteSession(await sha256(token));
      return json(200, {}, { "Set-Cookie": CLEAR_COOKIE });
    }
    case "me": {
      const key = await currentKey();
      if (!key) return fail(401, "Not signed in.");
      return json(200, profile(store.account(key)!));
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
