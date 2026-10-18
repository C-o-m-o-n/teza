// Same-origin calls to the accounts API (/api/account/*, see README "Accounts") and the public
// ranked pages (/api/leaderboard, /api/profile/<username>, README "Leaderboard and profiles"). Every call
// swallows network errors: without a server (offline, or the static dev server) the game
// just stays anonymous and keeps its records in localStorage. A request that hasn't answered
// within REQUEST_TIMEOUT_MS is aborted and counts as a network error.

import { parseRecords, Records } from "../profile";

/** What the server shows of a rating: the TR (null while hidden) and the ranked games played. */
export interface PublicRating {
  tr: number | null;
  games: number;
}

export interface Profile {
  username: string;
  records: Records;
  rating: PublicRating | null; // only `me` carries it
}

export const REQUEST_TIMEOUT_MS = 8000;

async function send(method: string, route: string, body?: unknown): Promise<Response | null> {
  return request(method, `/api/account/${route}`, body);
}

async function request(method: string, path: string, body?: unknown): Promise<Response | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const x: unknown = await res.json();
    return typeof x === "object" && x !== null ? (x as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toRating(x: unknown): PublicRating | null {
  if (typeof x !== "object" || x === null) return null;
  const { tr, games } = x as Record<string, unknown>;
  return (tr === null || finite(tr)) && finite(games) ? { tr, games } : null;
}

function toProfile(x: Record<string, unknown> | null): Profile | null {
  if (!x || typeof x.username !== "string") return null;
  return { username: x.username, records: parseRecords(x.records) ?? { vs: {} }, rating: toRating(x.rating) };
}

/** The signed-in profile, or null when signed out or the server can't be reached. */
export async function fetchMe(): Promise<Profile | null> {
  const res = await send("GET", "me");
  return res?.ok ? toProfile(await readJson(res)) : null;
}

export async function signIn(kind: "login" | "register", username: string, password: string): Promise<Profile | string> {
  const res = await send("POST", kind, { username, password });
  if (!res) return "Can't reach the account server. You can keep playing offline.";
  const body = await readJson(res);
  const profile = res.ok ? toProfile(body) : null;
  if (profile) return profile;
  if (body && typeof body.error === "string") return body.error;
  return res.status === 404 ? "Accounts aren't available on this server." : `Account server error (${res.status}).`;
}

/** The outcome of a sign-out step: 2xx, 401 (the session is already gone), or anything else. */
export type Outcome = "ok" | "expired" | "failed";

function outcome(res: Response | null): Outcome {
  if (res?.ok) return "ok";
  return res?.status === 401 ? "expired" : "failed";
}

/** "failed" on a network error or any status other than 2xx and 401. */
export async function signOut(): Promise<Outcome> {
  return outcome(await send("POST", "logout", {}));
}

/** The server keeps the better of its records and these. True when it answered 2xx. */
export async function putRecords(records: Records): Promise<boolean> {
  return (await uploadRecords(records)) === "ok";
}

async function uploadRecords(records: Records): Promise<Outcome> {
  return outcome(await send("PUT", "records", { records }));
}

/**
 * Uploads the records, then logs out; logout is only tried once the upload succeeded.
 * A 401 from either means the server session has already ended, so that counts as signed out.
 * False means the caller must stay signed in and keep its local records.
 */
export async function finishSession(records: Records): Promise<boolean> {
  const upload = await uploadRecords(records);
  if (upload !== "ok") return upload === "expired";
  return (await signOut()) !== "failed";
}

/** The ranked queue's answer to a poll (README "Ratings and ranked"). */
export type QueueState =
  | { status: "waiting"; waited: number; range: number }
  | { status: "matched"; code: string }
  | { status: "none" };

/** A 429 from queue/join: this account skipped its last ranked match and may search again in `retryAfter` seconds. */
export interface Cooldown {
  retryAfter: number;
}

export type JoinResult = "waiting" | "signed-out" | "unavailable" | Cooldown;

/**
 * Enter the ranked queue: "waiting", "signed-out" (401), a cooldown (429), or "unavailable" when
 * there is no game server here (the static servers answer 404 or 204) or it can't be reached.
 */
export async function joinQueue(): Promise<JoinResult> {
  const res = await send("POST", "queue/join", {});
  if (res?.status === 401) return "signed-out";
  if (res?.status === 429) {
    const retryAfter = (await readJson(res))?.retryAfter ?? Number(res.headers.get("Retry-After"));
    return { retryAfter: finite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 1 };
  }
  return res?.status === 200 && (await readJson(res))?.status === "waiting" ? "waiting" : "unavailable";
}

/** One poll of the queue (it also keeps the entry alive): the state, "signed-out", or null on a network or server error. */
export async function queueStatus(): Promise<QueueState | "signed-out" | null> {
  const res = await send("GET", "queue/status");
  if (res?.status === 401) return "signed-out";
  const x = res?.status === 200 ? await readJson(res) : null;
  if (x?.status === "none") return { status: "none" };
  if (x?.status === "matched" && typeof x.code === "string") return { status: "matched", code: x.code };
  if (x?.status === "waiting" && finite(x.waited) && finite(x.range)) return { status: "waiting", waited: x.waited, range: x.range };
  return null;
}

export async function leaveQueue(): Promise<void> {
  await send("POST", "queue/leave", {});
}

/** One row of the public leaderboard: only calibrated players are listed, so `tr` is never hidden. */
export interface LeaderboardPlayer {
  rank: number;
  username: string;
  tr: number;
  games: number;
}

/** A player's public profile. `rank` and `rating.tr` are null until the player is calibrated. */
export interface PlayerProfile {
  username: string;
  joined: number; // ms
  rating: PublicRating;
  rank: number | null;
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function toPlayer(x: unknown): LeaderboardPlayer | null {
  if (typeof x !== "object" || x === null) return null;
  const { rank, username, tr, games } = x as Record<string, unknown>;
  return count(rank) && rank > 0 && typeof username === "string" && finite(tr) && finite(games) ? { rank, username, tr, games } : null;
}

/** The top players by TR, or null when there is no server here or it can't be reached. Malformed rows are dropped. */
export async function fetchLeaderboard(): Promise<LeaderboardPlayer[] | null> {
  const res = await request("GET", "/api/leaderboard");
  const x = res?.status === 200 ? await readJson(res) : null;
  if (!x || !Array.isArray(x.players)) return null;
  return x.players.map(toPlayer).filter((p): p is LeaderboardPlayer => p !== null);
}

/** A player's profile, "not-found" for a 404, or null when it can't be read (no server, network, or a malformed answer). */
export async function fetchProfile(username: string): Promise<PlayerProfile | "not-found" | null> {
  const res = await request("GET", `/api/profile/${encodeURIComponent(username)}`);
  if (res?.status === 404 && (await readJson(res))?.error !== undefined) return "not-found";
  const x = res?.status === 200 ? await readJson(res) : null;
  const rating = toRating(x?.rating);
  if (!x || typeof x.username !== "string" || !finite(x.joined) || !rating) return null;
  if (x.rank !== null && !(count(x.rank) && x.rank > 0)) return null;
  return { username: x.username, joined: x.joined, rating, rank: x.rank };
}
