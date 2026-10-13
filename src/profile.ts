// Profile data shared by the client (localStorage) and the accounts server (src/server/accounts.ts):
// the records shape, its validator, the better-wins merge, and the username/password rules.

export interface RunRecord {
  value: number; // frames for 40L, score for blitz
  pps: number;
  apm: number;
  pieces: number;
  date: number;
}

export interface Records {
  "40l"?: RunRecord;
  blitz?: RunRecord;
  vs: Record<string, { wins: number; losses: number }>;
}

export const MAX_BOT_NAMES = 20;
export const MAX_BOT_NAME_LENGTH = 32;
export const MAX_40L_FRAMES = 1e7;

const RUN_KEYS = ["value", "pps", "apm", "pieces", "date"];

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function count(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function runError(x: unknown, name: string): string | null {
  if (!isObject(x)) return `${name} must be an object`;
  for (const k of Object.keys(x)) if (!RUN_KEYS.includes(k)) return `${name} has unknown key ${JSON.stringify(k)}`;
  for (const k of RUN_KEYS) if (!count(x[k])) return `${name}.${k} must be a finite number >= 0`;
  return null;
}

/** Null if `x` is a valid `Records`, else a message saying why not. `vs` may be omitted. */
export function recordsError(x: unknown): string | null {
  if (!isObject(x)) return "records must be an object";
  for (const k of Object.keys(x)) if (k !== "40l" && k !== "blitz" && k !== "vs") return `records has unknown key ${JSON.stringify(k)}`;
  if (x["40l"] !== undefined) {
    const e = runError(x["40l"], "40l");
    if (e) return e;
    const frames = (x["40l"] as RunRecord).value;
    if (frames < 1 || frames > MAX_40L_FRAMES) return `40l.value must be between 1 and ${MAX_40L_FRAMES}`;
  }
  if (x.blitz !== undefined) {
    const e = runError(x.blitz, "blitz");
    if (e) return e;
  }
  if (x.vs !== undefined) {
    if (!isObject(x.vs)) return "vs must be an object";
    const names = Object.keys(x.vs);
    if (names.length > MAX_BOT_NAMES) return `vs has more than ${MAX_BOT_NAMES} bot names`;
    for (const name of names) {
      if (name.length > MAX_BOT_NAME_LENGTH) return `bot names must be at most ${MAX_BOT_NAME_LENGTH} characters`;
      const wl = x.vs[name];
      if (!isObject(wl)) return `vs.${name} must be an object`;
      for (const k of Object.keys(wl)) if (k !== "wins" && k !== "losses") return `vs.${name} has unknown key ${JSON.stringify(k)}`;
      if (!count(wl.wins) || !count(wl.losses)) return `vs.${name} wins and losses must be finite numbers >= 0`;
    }
  }
  return null;
}

/** `x` as Records if valid (with `vs` defaulted to {}), else null. Copies, so the result shares nothing with `x`. */
export function parseRecords(x: unknown): Records | null {
  if (recordsError(x) !== null) return null;
  return mergeRecords({ vs: {} }, x as Records);
}

function better(a: RunRecord | undefined, b: RunRecord | undefined, lower: boolean): RunRecord | undefined {
  if (!a) return b && { ...b };
  if (!b) return { ...a };
  const bWins = lower ? b.value < a.value : b.value > a.value;
  return { ...(bWins ? b : a) };
}

/** Better wins per mode: fewer frames for 40L, higher score for Blitz, larger wins and losses per bot. */
export function mergeRecords(a: Records, b: Records): Records {
  const out: Records = { vs: {} };
  const sprint = better(a["40l"], b["40l"], true);
  const blitz = better(a.blitz, b.blitz, false);
  if (sprint) out["40l"] = sprint;
  if (blitz) out.blitz = blitz;
  const av = a.vs ?? {};
  const bv = b.vs ?? {};
  const names = new Set([...Object.keys(av), ...Object.keys(bv)]);
  // fromEntries defines own properties, so a name like "__proto__" can't touch the prototype
  out.vs = Object.fromEntries([...names].map((name) => {
    const x = Object.hasOwn(av, name) ? av[name] : { wins: 0, losses: 0 };
    const y = Object.hasOwn(bv, name) ? bv[name] : { wins: 0, losses: 0 };
    return [name, { wins: Math.max(x.wins, y.wins), losses: Math.max(x.losses, y.losses) }];
  }));
  return out;
}

export const USERNAME = /^[A-Za-z0-9_-]{3,16}$/;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export function usernameError(x: unknown): string | null {
  if (typeof x !== "string" || !USERNAME.test(x)) return "Username must be 3-16 characters: letters, digits, _ or -.";
  return null;
}

export function passwordError(x: unknown): string | null {
  if (typeof x !== "string" || x.length < MIN_PASSWORD || x.length > MAX_PASSWORD) {
    return `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.`;
  }
  return null;
}
