// GET /api/live (src/server/leaderboard.ts): the live ranked matches the Accounts object lists for WATCH LIVE.
import { beforeEach, describe, expect, it } from "vitest";
import { rateRankedMatch } from "../src/server/accounts";
import { handleLive, LIVE_LIST_SIZE, LIVE_MAX_AGE_MS, LiveMatches, matchLive } from "../src/server/leaderboard";
import { tdisplay } from "../src/server/rating";
import { MemoryStore } from "./account-store";

const ORIGIN = "https://teza.example";
const NOW = 1_800_000_000_000;

let store: MemoryStore;
let live: LiveMatches;

beforeEach(() => {
  store = new MemoryStore();
  live = new Map();
});

function seed(username: string, rating: { r: number; rd: number; games: number } | null = null): string {
  const key = username.toLowerCase();
  store.insertAccount(key, { username, passwordHash: "pbkdf2-sha256$1$00$00", createdAt: NOW - 1e9, records: JSON.stringify({ vs: {} }) });
  if (rating) store.ratings.set(key, { ...rating, vol: 0.06 });
  return key;
}

function room(code: string, a: string, b: string): void {
  store.insertRankedMatch(code, { keys: [a, b], createdAt: NOW - 60_000 });
}

async function list(now = NOW, method = "GET"): Promise<{ res: Response; body: { matches: Record<string, unknown>[] } }> {
  const res = handleLive(new Request(`${ORIGIN}/api/live`, { method }), store, live, now);
  return { res, body: res.status === 200 ? await res.json() : null };
}

describe("GET /api/live", () => {
  it("is an empty list with nothing live, cached for 5 s", async () => {
    const { res, body } = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(body).toEqual({ matches: [] });
  });

  it("lists a live ranked match with both usernames and TR (null while hidden), and no account key", async () => {
    const zuri = seed("Zuri", { r: 1800, rd: 60, games: 40 });
    const ben = seed("BenX", { r: 1500, rd: 250, games: 3 });
    room("ABCDEF", zuri, ben);
    matchLive(live, store, "ABCDEF", true, NOW - 1000, [ben, zuri]); // ben holds slot 0
    const { res, body } = await list();
    expect(body.matches).toEqual([
      { code: "ABCDEF", startedAt: NOW - 1000, players: [{ username: "BenX", tr: null }, { username: "Zuri", tr: tdisplay(1800, 60) }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('"benx"'); // the account keys stay in Accounts
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
  });

  it("keeps the row's order when the slots don't name its two accounts", async () => {
    const a = seed("Aa");
    const b = seed("Bb");
    room("ABCDEF", a, b);
    for (const slots of [undefined, [], [a, a], [a, "mallory"], [null, null], [b, a, "x"]]) {
      matchLive(live, store, "ABCDEF", true, NOW, slots);
      const { body } = await list();
      expect((body.matches[0].players as { username: string }[]).map((p) => p.username), JSON.stringify(slots)).toEqual(["Aa", "Bb"]);
    }
  });

  it("removes a match on matchLive(false) and once it is rated", async () => {
    const a = seed("Aa");
    const b = seed("Bb");
    room("ABCDEF", a, b);
    room("GHJKMN", a, b);
    matchLive(live, store, "ABCDEF", true, NOW);
    matchLive(live, store, "GHJKMN", true, NOW);
    expect((await list()).body.matches).toHaveLength(2);
    matchLive(live, store, "ABCDEF", false, NOW);
    expect((await list()).body.matches.map((m) => m.code)).toEqual(["GHJKMN"]);
    expect(rateRankedMatch(store, "GHJKMN", a, () => NOW)).not.toBeNull();
    expect((await list()).body.matches).toEqual([]);
    expect(live.size).toBe(0);
  });

  it("does not record a code without a ranked_matches row", async () => {
    seed("Aa");
    matchLive(live, store, "ABCDEF", true, NOW, ["aa", "bb"]);
    expect(live.size).toBe(0);
    expect((await list()).body.matches).toEqual([]);
  });

  it(`drops entries older than ${LIVE_MAX_AGE_MS / 60_000} minutes, and skips one whose account is gone`, async () => {
    const a = seed("Aa");
    const b = seed("Bb");
    room("ABCDEF", a, b);
    room("GHJKMN", a, "ghost");
    matchLive(live, store, "ABCDEF", true, NOW);
    matchLive(live, store, "GHJKMN", true, NOW);
    expect((await list(NOW + LIVE_MAX_AGE_MS)).body.matches.map((m) => m.code)).toEqual(["ABCDEF"]);
    expect(live.has("GHJKMN")).toBe(true); // skipped, not dropped: its room is still open
    expect((await list(NOW + LIVE_MAX_AGE_MS + 1)).body.matches).toEqual([]);
    expect(live.size).toBe(0);
  });

  it(`lists at most ${LIVE_LIST_SIZE}, newest first`, async () => {
    const a = seed("Aa");
    const b = seed("Bb");
    const codes = Array.from({ length: 40 }, (_, i) => `ABCD${"ABCDEFGHJKMNPQRSTUVWXYZ23456789"[i % 31]}${"23456789"[Math.floor(i / 31)]}`);
    codes.forEach((code, i) => {
      room(code, a, b);
      matchLive(live, store, code, true, NOW - 1000 * (40 - i)); // the last code started last
    });
    const lookup = store.rankedMatch.bind(store);
    let lookups = 0;
    store.rankedMatch = (code) => (lookups++, lookup(code));
    const { body } = await list();
    expect(lookups).toBe(LIVE_LIST_SIZE); // none for the entries past the list
    expect(body.matches).toHaveLength(LIVE_LIST_SIZE);
    expect(body.matches.map((m) => m.code)).toEqual(codes.slice(10).reverse());
    expect(live.size).toBe(40); // the rest stay live, just not listed
  });

  it("answers anything but GET with 405 and Allow: GET", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const { res } = await list(NOW, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
