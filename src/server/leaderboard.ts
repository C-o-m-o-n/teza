// The public ranked pages: GET /api/leaderboard (the top LEADERBOARD_SIZE calibrated accounts) and
// GET /api/profile/<username>. Runtime-independent like accounts.ts: the `Accounts` Durable Object
// passes each request in with its store. No session is needed, and only the fields built here
// leave the server: username, join date, TR, ranked games and rank.
//
// Only server-rated ranked results count. Self-reported data (solo personal bests, the bot W-L)
// is never read here: it comes from a client upload nothing verifies (README "Leaderboard and profiles").
//
// GET /api/live lists the ranked matches being played now, for WATCH LIVE. The `Accounts` object keeps
// them in memory (a `LiveMatches` map its ranked `Match` objects update over RPC, `matchLive`), joined
// here with `ranked_matches` for the two players. Only ranked rooms are listed: their two accounts are
// public on the leaderboard anyway, while an unranked room's code is the secret that lets anyone join it.

import { usernameError } from "../profile";
import { AccountStore, CalibratedRow } from "./accounts";
import { tdisplay } from "./rating";

export const LEADERBOARD_SIZE = 50;
const PROFILE_ROUTE = "/api/profile/";
export const LIVE_ROUTE = "/api/live";
export const LIVE_LIST_SIZE = 30; // matches GET /api/live lists, newest first
export const LIVE_MAX_AGE_MS = 30 * 60_000; // an entry this old is a match whose `false` never came: dropped

/** A live ranked match: when it started, and its two account keys by slot (board) index. */
export interface LiveEntry {
  startedAt: number; // ms
  keys: readonly [string, string];
}

/** The `Accounts` object's live ranked matches, by code. In memory only: a lost entry only hides a match from the list. */
export type LiveMatches = Map<string, LiveEntry>;

export interface LiveMatch {
  code: string;
  startedAt: number; // ms
  players: [{ username: string; tr: number | null }, { username: string; tr: number | null }]; // by slot
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  tr: number;
  games: number;
}

export interface PublicProfile {
  username: string;
  joined: number; // ms
  rating: { tr: number | null; games: number };
  rank: number | null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}, maxAge = 30): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store", ...headers },
  });
}

const fail = (status: number, message: string, headers?: Record<string, string>) => json(status, { error: message }, headers);

/** Every calibrated account with its TR, by TR (highest first), then more games, then username key. */
function ladder(store: AccountStore): (CalibratedRow & { tr: number })[] {
  const rows: (CalibratedRow & { tr: number })[] = [];
  for (const row of store.calibrated()) {
    const tr = tdisplay(row.r, row.rd);
    if (tr !== null) rows.push({ ...row, tr });
  }
  return rows.sort((a, b) => b.tr - a.tr || b.games - a.games || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Whether `path` is one of this module's routes, so the Durable Object can dispatch here. */
export function isPublicRoute(path: string): boolean {
  return path === "/api/leaderboard" || path.startsWith(PROFILE_ROUTE);
}

/** Handles GET /api/leaderboard and GET /api/profile/<username>; anything else is 404. */
export function handlePublic(request: Request, store: AccountStore): Response {
  const path = new URL(request.url).pathname;
  if (!isPublicRoute(path)) return fail(404, "Not found.");
  if (request.method !== "GET") return fail(405, "Method not allowed.", { Allow: "GET" });

  if (path === "/api/leaderboard") {
    const players: LeaderboardEntry[] = ladder(store).slice(0, LEADERBOARD_SIZE)
      .map((row, i) => ({ rank: i + 1, username: row.username, tr: row.tr, games: row.games }));
    return json(200, { players });
  }

  let username: string;
  try {
    username = decodeURIComponent(path.slice(PROFILE_ROUTE.length));
  } catch {
    return fail(400, "Bad username.");
  }
  const invalid = usernameError(username);
  if (invalid) return fail(400, invalid);
  const key = username.toLowerCase();
  const account = store.account(key);
  if (!account) return fail(404, "No such player.");
  const at = ladder(store).findIndex((row) => row.key === key);
  const rating = store.rating(key);
  const profile: PublicProfile = {
    username: account.username,
    joined: account.createdAt,
    rating: { tr: rating ? tdisplay(rating.r, rating.rd) : null, games: rating?.games ?? 0 },
    rank: at < 0 ? null : at + 1,
  };
  return json(200, profile);
}

/**
 * A ranked match `code` started (`on`) or finished. Only a code with a `ranked_matches` row is
 * recorded, with its players by slot when `slots` names the row's two accounts (else in row order).
 */
export function matchLive(live: LiveMatches, store: AccountStore, code: string, on: boolean, now: number, slots?: readonly unknown[]): void {
  if (!on) {
    live.delete(code);
    return;
  }
  const row = store.rankedMatch(code);
  if (!row) return;
  const [a, b] = row.keys;
  const bySlot = slots?.length === 2 && ((slots[0] === a && slots[1] === b) || (slots[0] === b && slots[1] === a));
  live.set(code, { startedAt: now, keys: bySlot ? [slots[0] as string, slots[1] as string] : [a, b] });
}

/**
 * GET /api/live: up to LIVE_LIST_SIZE live ranked matches, newest first, each with its two players'
 * usernames and TR (null while hidden) by slot. Entries older than LIVE_MAX_AGE_MS, or whose room is
 * no longer an unrated ranked match, are dropped; ones with a missing account are skipped.
 */
export function handleLive(request: Request, store: AccountStore, live: LiveMatches, now: number): Response {
  if (request.method !== "GET") return fail(405, "Method not allowed.", { Allow: "GET" });
  const matches: LiveMatch[] = [];
  for (const [code, entry] of [...live].sort((x, y) => y[1].startedAt - x[1].startedAt)) {
    if (now - entry.startedAt > LIVE_MAX_AGE_MS) {
      live.delete(code);
      continue;
    }
    if (matches.length >= LIVE_LIST_SIZE) continue; // past the list: no storage lookups
    if (!store.rankedMatch(code)) {
      live.delete(code);
      continue;
    }
    const players = entry.keys.map((key) => {
      const account = store.account(key);
      const rating = store.rating(key);
      return account && { username: account.username, tr: rating ? tdisplay(rating.r, rating.rd) : null };
    });
    if (players[0] && players[1]) matches.push({ code, startedAt: entry.startedAt, players: [players[0], players[1]] });
  }
  return json(200, { matches }, {}, 5);
}
