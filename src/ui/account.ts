// Same-origin calls to the accounts API (/api/account/*, see README "Accounts"). Every call
// swallows network errors: without a server (offline, or the static dev server) the game
// just stays anonymous and keeps its records in localStorage. A request that hasn't answered
// within REQUEST_TIMEOUT_MS is aborted and counts as a network error.

import { parseRecords, Records } from "../profile";

export interface Profile {
  username: string;
  records: Records;
}

export const REQUEST_TIMEOUT_MS = 8000;

async function send(method: string, route: string, body?: unknown): Promise<Response | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`/api/account/${route}`, {
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

function toProfile(x: Record<string, unknown> | null): Profile | null {
  if (!x || typeof x.username !== "string") return null;
  return { username: x.username, records: parseRecords(x.records) ?? { vs: {} } };
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

/** True when the server answered 2xx, false on any other status or a network error. */
export async function signOut(): Promise<boolean> {
  const res = await send("POST", "logout", {});
  return res?.ok ?? false;
}

/** The server keeps the better of its records and these. True when it answered 2xx. */
export async function putRecords(records: Records): Promise<boolean> {
  const res = await send("PUT", "records", { records });
  return res?.ok ?? false;
}

/**
 * Uploads the records, then logs out; logout is only tried once the upload succeeded.
 * False means the caller must stay signed in and keep its local records.
 */
export async function finishSession(records: Records): Promise<boolean> {
  return (await putRecords(records)) && (await signOut());
}
