import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, fetchMe, finishSession, joinQueue, putRecords, queueStatus, signOut } from "../src/ui/account";
import { Records } from "../src/profile";
import { onlineAvailable } from "../src/ui/rooms";

const records: Records = { "40l": { value: 2500, pps: 2, apm: 60, pieces: 100, date: 0 }, vs: { ROOKIE: { wins: 1, losses: 4 } } };

type Answer = number | "network" | "hang";

/** Stubs fetch: each call takes the next answer (a status, a thrown TypeError, or never answering until aborted). */
function stubFetch(...answers: Answer[]): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    const answer = answers.shift();
    if (answer === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (answer === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return Promise.resolve(new Response(null, { status: answer ?? 500 }));
  });
  return calls;
}

describe("account client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("putRecords is true only for 2xx; signOut tells 2xx, 401, 400 and other failures apart", async () => {
    stubFetch(204, 401, 400, 500, "network");
    expect(await signOut()).toBe("ok");
    expect(await signOut()).toBe("expired");
    expect(await signOut()).toBe("invalid");
    expect(await signOut()).toBe("failed");
    expect(await signOut()).toBe("failed");
    stubFetch(200, 400, 401, 503, "network");
    expect(await putRecords(records)).toBe(true);
    expect(await putRecords(records)).toBe(false);
    expect(await putRecords(records)).toBe(false);
    expect(await putRecords(records)).toBe(false);
    expect(await putRecords(records)).toBe(false);
  });

  it("finishSession uploads then logs out", async () => {
    const calls = stubFetch(200, 204);
    expect(await finishSession(records)).toBe(true);
    expect(calls).toEqual(["PUT /api/account/records", "POST /api/account/logout"]);
  });

  it("a failed records upload fails sign-out and never logs out", async () => {
    for (const answer of [500, 503, 403, "network"] as Answer[]) {
      const calls = stubFetch(answer, 204);
      expect(await finishSession(records)).toBe(false);
      expect(calls).toEqual(["PUT /api/account/records"]);
    }
  });

  it("records the server refuses as invalid (400) are dropped: sign-out goes on to log out", async () => {
    let calls = stubFetch(400, 200);
    expect(await finishSession(records)).toBe(true);
    expect(calls).toEqual(["PUT /api/account/records", "POST /api/account/logout"]);
    calls = stubFetch(400, 401);
    expect(await finishSession(records)).toBe(true);
    for (const answer of [500, 400, "network"] as Answer[]) {
      calls = stubFetch(400, answer);
      expect(await finishSession(records)).toBe(false);
      expect(calls).toEqual(["PUT /api/account/records", "POST /api/account/logout"]);
    }
  });

  it("a failed logout fails sign-out", async () => {
    for (const answer of [500, 403, 400, "network"] as Answer[]) {
      const calls = stubFetch(200, answer);
      expect(await finishSession(records)).toBe(false);
      expect(calls).toEqual(["PUT /api/account/records", "POST /api/account/logout"]);
    }
  });

  it("a 401 from the records upload counts as signed out and skips logout", async () => {
    const calls = stubFetch(401, 500);
    expect(await finishSession(records)).toBe(true);
    expect(calls).toEqual(["PUT /api/account/records"]);
  });

  it("a 401 from logout counts as signed out", async () => {
    const calls = stubFetch(200, 401);
    expect(await finishSession(records)).toBe(true);
    expect(calls).toEqual(["PUT /api/account/records", "POST /api/account/logout"]);
  });

  it("a hanging request is aborted after the timeout and fails sign-out", async () => {
    stubFetch("hang");
    let done: boolean | undefined;
    const upload = finishSession(records).then((ok) => (done = ok));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await upload;
    expect(done).toBe(false);

    stubFetch(200, "hang");
    done = undefined;
    const logout = finishSession(records).then((ok) => (done = ok));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await logout;
    expect(done).toBe(false);
  });
});

describe("ranked queue client", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubJson(...answers: [number, unknown][]): string[] {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url} ${(init.headers as Record<string, string>)["Content-Type"] ?? ""}`.trim());
      const [status, body] = answers.shift() ?? [500, null];
      return Promise.resolve(new Response(body === null || status === 204 ? null : JSON.stringify(body), { status }));
    });
    return calls;
  }

  it("joinQueue tells waiting, signed out and no game server apart", async () => {
    const calls = stubJson([200, { status: "waiting" }], [401, { error: "Not signed in." }], [404, null], [204, null], [500, null]);
    expect(await joinQueue()).toBe("waiting");
    expect(await joinQueue()).toBe("signed-out");
    expect(await joinQueue()).toBe("unavailable"); // npm start
    expect(await joinQueue()).toBe("unavailable"); // the e2e server
    expect(await joinQueue()).toBe("unavailable");
    expect(calls[0]).toBe("POST /api/account/queue/join application/json");
  });

  it("queueStatus reads waiting, matched and none, and nothing malformed", async () => {
    stubJson(
      [200, { status: "waiting", waited: 12, range: 1000 }], [200, { status: "matched", code: "ABCDEF" }], [200, { status: "none" }],
      [401, {}], [200, { status: "waiting", range: "500" }], [500, null],
    );
    expect(await queueStatus()).toEqual({ status: "waiting", waited: 12, range: 1000 });
    expect(await queueStatus()).toEqual({ status: "matched", code: "ABCDEF" });
    expect(await queueStatus()).toEqual({ status: "none" });
    expect(await queueStatus()).toBe("signed-out");
    expect(await queueStatus()).toBeNull();
    expect(await queueStatus()).toBeNull();
  });

  it("fetchMe keeps the public rating, if well formed", async () => {
    stubJson(
      [200, { username: "Alice", records: { vs: {} }, rating: { tr: null, games: 3 } }],
      [200, { username: "Alice", records: { vs: {} }, rating: { tr: "x", games: 3 } }],
    );
    expect((await fetchMe())?.rating).toEqual({ tr: null, games: 3 });
    expect((await fetchMe())?.rating).toBeNull();
  });
});

describe("rooms client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("onlineAvailable asks GET /api/room and takes only the Worker's 200 {online: true}", async () => {
    const calls: string[] = [];
    const answers: [number, unknown][] = [[200, { online: true }], [204, null], [404, null], [201, { code: "ABCDEF" }], [200, { online: "yes" }]];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      const [status, body] = answers.shift()!;
      return Promise.resolve(new Response(body === null ? null : JSON.stringify(body), { status }));
    });
    expect(await onlineAvailable()).toBe(true);
    expect(await onlineAvailable()).toBe(false); // the e2e server
    expect(await onlineAvailable()).toBe(false); // npm start
    expect(await onlineAvailable()).toBe(false);
    expect(await onlineAvailable()).toBe(false);
    expect(new Set(calls)).toEqual(new Set(["GET /api/room"]));
  });
});
