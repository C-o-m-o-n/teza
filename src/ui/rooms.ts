// Same-origin calls that open an online room (README "Game server") or list the live ranked matches
// (GET /api/live, for WATCH LIVE). Like account.ts, every call swallows network errors: without the
// Worker (npm start, the e2e server, offline) online play is just unavailable. The match socket itself
// is opened by App (app.ts), and driven by src/net/online.ts (or src/net/spectate.ts to watch).

import { ROOM_CODE } from "../server/match";
import { REQUEST_TIMEOUT_MS } from "./account";

async function send(method: string, path: string): Promise<Response | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(path, { method, credentials: "same-origin", signal: abort.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A fresh room code from `POST /api/room` (201 `{code}`), or null when there is no game server here. */
export async function newRoom(): Promise<string | null> {
  const res = await send("POST", "/api/room");
  if (res?.status !== 201) return null;
  try {
    const x: unknown = await res.json();
    const code = typeof x === "object" && x !== null ? (x as Record<string, unknown>).code : null;
    return typeof code === "string" && ROOM_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Whether online play is served here. A browser can't read the status of a refused WebSocket
 * upgrade, so JOIN asks first with `GET /api/room`, which only the Worker answers 200 `{online: true}`
 * and which reserves nothing (`POST /api/room` reserves a code for its caller to create).
 */
export async function onlineAvailable(): Promise<boolean> {
  const res = await send("GET", "/api/room");
  if (res?.status !== 200) return false;
  try {
    const x: unknown = await res.json();
    return typeof x === "object" && x !== null && (x as Record<string, unknown>).online === true;
  } catch {
    return false;
  }
}

/** A player in a live ranked match: username and TR (null while hidden). */
export interface LivePlayer {
  username: string;
  tr: number | null;
}

/** A live ranked match from GET /api/live: its code, start time (ms) and players by board (slot). */
export interface LiveMatch {
  code: string;
  startedAt: number;
  players: [LivePlayer, LivePlayer];
}

function livePlayer(x: unknown): LivePlayer | null {
  if (typeof x !== "object" || x === null) return null;
  const { username, tr } = x as Record<string, unknown>;
  if (typeof username !== "string" || username === "") return null;
  return tr === null || (typeof tr === "number" && Number.isFinite(tr)) ? { username, tr } : null;
}

function liveMatch(x: unknown): LiveMatch | null {
  if (typeof x !== "object" || x === null) return null;
  const { code, startedAt, players } = x as Record<string, unknown>;
  if (typeof code !== "string" || !ROOM_CODE.test(code) || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (!Array.isArray(players) || players.length !== 2) return null;
  const [a, b] = players.map(livePlayer);
  return a && b ? { code, startedAt, players: [a, b] } : null;
}

/** The live ranked matches (malformed rows dropped, only known fields kept), or null when there is no server or it answers strangely. */
export async function fetchLive(): Promise<LiveMatch[] | null> {
  const res = await send("GET", "/api/live");
  if (res?.status !== 200) return null;
  try {
    const x: unknown = await res.json();
    const matches = typeof x === "object" && x !== null ? (x as Record<string, unknown>).matches : null;
    if (!Array.isArray(matches)) return null;
    return matches.map(liveMatch).filter((m): m is LiveMatch => m !== null);
  } catch {
    return null;
  }
}
