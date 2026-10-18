import { beforeEach, describe, expect, it } from "vitest";
import { COOKIE_NAME, handleAccount } from "../src/server/accounts";
import { handlePublic, isPublicRoute, LEADERBOARD_SIZE } from "../src/server/leaderboard";
import { tdisplay } from "../src/server/rating";
import { MemoryStore } from "./account-store";

const ORIGIN = "https://teza.example";
const JOINED = 1_700_000_000_000;

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

/** An account (no password needed here) with a rating row, or none when `rating` is null. */
function seed(username: string, rating: { r: number; rd: number; games: number } | null, createdAt = JOINED): void {
  const key = username.toLowerCase();
  store.insertAccount(key, { username, passwordHash: "pbkdf2-sha256$1$00$00", createdAt, records: JSON.stringify({ vs: {} }) });
  if (rating) store.ratings.set(key, { ...rating, vol: 0.06 });
}

function get(path: string, method = "GET"): Response {
  return handlePublic(new Request(`${ORIGIN}${path}`, { method }), store);
}

async function board(): Promise<{ rank: number; username: string; tr: number; games: number }[]> {
  const res = get("/api/leaderboard");
  expect(res.status).toBe(200);
  return (await res.json()).players;
}

describe("leaderboard", () => {
  it("is an empty list with no calibrated accounts", async () => {
    const res = get("/api/leaderboard");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"players":[]}');
    seed("Newbie", { r: 1700, rd: 250, games: 3 });
    seed("Unrated", null);
    expect(await board()).toEqual([]);
  });

  it("lists only RD <= 100, by TR, then more games, then username key, with consecutive ranks", async () => {
    seed("Low", { r: 1400, rd: 60, games: 40 });
    seed("High", { r: 1800, rd: 60, games: 40 });
    seed("Edge", { r: 1500, rd: 100, games: 20 }); // RD exactly 100 counts
    seed("Hidden", { r: 2500, rd: 100.5, games: 90 }); // the best r, but not calibrated
    seed("zed", { r: 1600, rd: 60, games: 30 });
    seed("Abe", { r: 1600, rd: 60, games: 30 });
    seed("More", { r: 1600, rd: 60, games: 31 });
    const players = await board();
    expect(players.map((p) => p.username)).toEqual(["High", "More", "Abe", "zed", "Edge", "Low"]);
    expect(players.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(players[1].tr).toBe(players[2].tr);
    expect(players[0]).toEqual({ rank: 1, username: "High", tr: tdisplay(1800, 60), games: 40 });
    for (let i = 1; i < players.length; i++) expect(players[i].tr).toBeLessThanOrEqual(players[i - 1].tr);
  });

  it(`is capped at ${LEADERBOARD_SIZE}`, async () => {
    for (let i = 0; i < 60; i++) seed(`player${String(i).padStart(2, "0")}`, { r: 1500 + i * 5, rd: 70, games: 20 });
    seed("Uncalibrated", { r: 3000, rd: 300, games: 2 });
    const players = await board();
    expect(players).toHaveLength(50);
    expect(players.map((p) => p.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(players[0].username).toBe("player59");
    expect(players[49].username).toBe("player10");
    expect(players.some((p) => p.username === "Uncalibrated")).toBe(false);
  });
});

describe("profile", () => {
  it("looks a name up in any case and answers with the original case", async () => {
    seed("MixedCase", { r: 1700, rd: 80, games: 25 }, JOINED + 5);
    for (const name of ["mixedcase", "MIXEDCASE", "MixedCase"]) {
      const res = get(`/api/profile/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
      expect(await res.json()).toEqual({ username: "MixedCase", joined: JOINED + 5, rating: { tr: tdisplay(1700, 80), games: 25 }, rank: 1 });
    }
  });

  it("gives tr and rank null while uncalibrated, and a rated games count", async () => {
    seed("Fresh", null);
    seed("Placing", { r: 1650, rd: 180, games: 6 });
    expect(await get("/api/profile/fresh").json()).toEqual({ username: "Fresh", joined: JOINED, rating: { tr: null, games: 0 }, rank: null });
    expect(await get("/api/profile/placing").json()).toEqual({ username: "Placing", joined: JOINED, rating: { tr: null, games: 6 }, rank: null });
  });

  it("returns a rank past the leaderboard's 50", async () => {
    for (let i = 0; i < 60; i++) seed(`player${String(i).padStart(2, "0")}`, { r: 1500 + i * 5, rd: 70, games: 20 });
    const body = await get("/api/profile/player00").json();
    expect(body.rank).toBe(60);
    expect(body.rating.tr).toBe(tdisplay(1500, 70));
    expect((await get("/api/profile/PLAYER09").json()).rank).toBe(51);
  });

  it("is 400 for a name that breaks the username rule and 404 for an unknown one", async () => {
    for (const path of ["/api/profile/a", "/api/profile/", "/api/profile/bad%20name", "/api/profile/a/b", "/api/profile/%E0%A4%A", `/api/profile/${"x".repeat(17)}`]) {
      const res = get(path);
      expect(res.status, path).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    const missing = get("/api/profile/nobody1");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No such player." });
  });

  it("answers only GET (405 with Allow: GET)", () => {
    seed("Alice", null);
    for (const path of ["/api/leaderboard", "/api/profile/alice"]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = get(path, method);
        expect(res.status).toBe(405);
        expect(res.headers.get("Allow")).toBe("GET");
      }
    }
  });

  it("routes only its two paths", () => {
    expect(isPublicRoute("/api/leaderboard")).toBe(true);
    expect(isPublicRoute("/api/profile/alice")).toBe(true);
    expect(isPublicRoute("/api/leaderboards")).toBe(false);
    expect(isPublicRoute("/api/account/me")).toBe(false);
    expect(get("/api/elsewhere").status).toBe(404);
  });
});

describe("leakage", () => {
  it("shows nothing private of an account with a password, a session and a 40L PB", async () => {
    const call = (method: string, route: string, body: unknown, cookie?: string) => handleAccount(new Request(`${ORIGIN}/api/account/${route}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: `${COOKIE_NAME}=${cookie}` } : {}) }, body: JSON.stringify(body),
    }), store, () => JOINED);
    const reg = await call("POST", "register", { username: "Secretive", password: "correct horse battery" });
    const token = /=([0-9a-f]+);/.exec(reg.headers.get("Set-Cookie")!)![1];
    const run = { value: 3000, pps: 2, apm: 50, pieces: 100, date: 1 };
    expect((await call("PUT", "records", { records: { "40l": run, blitz: { ...run, value: 90000 }, vs: { HARD: { wins: 9, losses: 0 } } } }, token)).status).toBe(200);
    expect(store.sessions.size).toBe(1);
    store.ratings.set("secretive", { r: 1750, rd: 55, vol: 0.059, games: 40 });

    const lb = await get("/api/leaderboard").json();
    const profile = await get("/api/profile/secretive").json();
    expect(lb.players).toHaveLength(1);
    for (const text of [JSON.stringify(lb), JSON.stringify(profile)]) {
      for (const banned of ["password", "pbkdf2", "hash", "records", "40l", "blitz", "vol", '"r"', '"rd"', "session", "username_key", "HARD", "3000", "90000"]) {
        expect(text, banned).not.toContain(banned);
      }
    }
    expect(Object.keys(lb.players[0]).sort()).toEqual(["games", "rank", "tr", "username"]);
    expect(Object.keys(profile).sort()).toEqual(["joined", "rank", "rating", "username"]);
    expect(Object.keys(profile.rating).sort()).toEqual(["games", "tr"]);
  });
});
