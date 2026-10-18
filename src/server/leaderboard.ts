// The public ranked pages: GET /api/leaderboard (the top LEADERBOARD_SIZE calibrated accounts) and
// GET /api/profile/<username>. Runtime-independent like accounts.ts: the `Accounts` Durable Object
// passes each request in with its store. No session is needed, and only the fields built here
// leave the server: username, join date, TR, ranked games and rank.
//
// Only server-rated ranked results count. Self-reported data (solo personal bests, the bot W-L)
// is never read here: it comes from a client upload nothing verifies (README "Leaderboard and profiles").

import { usernameError } from "../profile";
import { AccountStore, CalibratedRow } from "./accounts";
import { tdisplay } from "./rating";

export const LEADERBOARD_SIZE = 50;
const PROFILE_ROUTE = "/api/profile/";

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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? "public, max-age=30" : "no-store", ...headers },
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
