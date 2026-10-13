// Same-origin calls to the accounts API (/api/account/*, see README "Accounts"). Every call
// swallows network errors: without a server (offline, or the static dev server) the game
// just stays anonymous and keeps its records in localStorage.

import { parseRecords, Records } from "../profile";

export interface Profile {
  username: string;
  records: Records;
}

async function send(method: string, route: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(`/api/account/${route}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return null;
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

export async function signOut(): Promise<void> {
  await send("POST", "logout", {});
}

/** Fire-and-forget: the server keeps the better of its records and these. */
export async function putRecords(records: Records): Promise<void> {
  await send("PUT", "records", { records });
}
