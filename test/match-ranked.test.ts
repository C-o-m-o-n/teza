// Ranked matches: who may take a slot, and the one rating report a finished match makes.
import { describe, expect, it } from "vitest";
import { COOKIE_NAME, QueueHost, handleAccount, reportNoShow } from "../src/server/accounts";
import {
  IDLE_TIMEOUT_MS, LOBBY_TIMEOUT_MS, MatchSession, RANKED_LOBBY_TIMEOUT_MS, RECONNECT_GRACE_MS, REPORT_TIMEOUT_MS, RankedConfig,
  SlotIndex, SlotRating, admission,
} from "../src/server/match";
import { Matchmaker } from "../src/server/matchmaking";
import { MemoryStore } from "./account-store";
import { FakeClock, FakePeer, Player, input, join, lastError, setup } from "./match-harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Report = (winner: SlotIndex | null) => Promise<readonly [SlotRating, SlotRating] | null>;

const RATINGS: [SlotRating, SlotRating] = [{ tr: 13120, delta: 120 }, { tr: 11915, delta: -85 }];

function ranked(report: Report = async () => RATINGS, noShow: (absent: string) => Promise<unknown> = async () => true, clock = new FakeClock()) {
  const calls: (SlotIndex | null)[] = [];
  const noShows: string[] = [];
  const config: RankedConfig = {
    accounts: ["alice", "bob"],
    report: (winner) => {
      calls.push(winner);
      return report(winner);
    },
    noShow: (absent) => {
      noShows.push(absent);
      return noShow(absent);
    },
  };
  const session = new MatchSession(clock, undefined, config);
  const take = (account: string): Player => {
    const peer = new FakePeer();
    return { peer, conn: session.connect(peer, undefined, account) };
  };
  return { clock, session, calls, noShows, take };
}

/** p0 stacks hard drops until the server's engine tops out. */
function topOut(clock: FakeClock, session: MatchSession, p: Player): void {
  let frame = 0;
  for (let i = 0; i < 100 && !session.isOver; i++) {
    clock.advance(100);
    frame += 6;
    input(session, p, frame, "hard");
  }
}

describe("ranked: admission", () => {
  it("lets only the two registered accounts take a slot, once each", () => {
    const { session, take } = ranked();
    expect(admission(session, "ranked", null)).toMatchObject({ status: 401 });
    expect(admission(session, "ranked", "mallory")).toMatchObject({ status: 403 });
    expect(admission(session, "ranked", "bob")).toBeNull();
    const bob = take("bob");
    expect(bob.peer.of("welcome")[0].d).toMatchObject({ slot: 0 });
    expect(session.accountOf(0)).toBe("bob");
    expect(admission(session, "ranked", "bob")).toMatchObject({ status: 403 });

    // the session refuses too, if a socket ever got past the adapter's check
    const again = take("bob");
    expect(lastError(again)).toBe("not-yours");
    expect(again.peer.closed).not.toBeNull();
    const anon = join(session);
    expect(lastError(anon)).toBe("not-yours");

    const alice = take("alice");
    expect(alice.peer.of("start")).toHaveLength(1);
    expect(session.accountOf(1)).toBe("alice");
  });

  it("refuses create and join on a ranked room (409), and ranked on an unranked one (404)", () => {
    const { session } = ranked();
    expect(admission(session, "create", "alice")).toMatchObject({ status: 409 });
    expect(admission(session, "join", "alice")).toMatchObject({ status: 409 });

    const plain = new MatchSession(new FakeClock());
    expect(admission(plain, "ranked", "alice")).toMatchObject({ status: 404 });
    expect(admission(plain, "create", null)).toBeNull();
    expect(admission(plain, "join", null)).toMatchObject({ status: 404 });
    expect(admission(plain, "bogus", null)).toMatchObject({ status: 400 });
    expect(admission(plain, null, null)).toMatchObject({ status: 400 });
    join(plain);
    expect(admission(plain, "create", null)).toMatchObject({ status: 409 });
    expect(admission(plain, "join", null)).toBeNull();
    expect(plain.isRanked).toBe(false);
    expect(plain.mayTake("alice")).toBe(false);
  });
});

describe("ranked: reporting", () => {
  it("reports a top-out once with the winner, and sends each player their own rating in end", async () => {
    const { clock, session, calls, take } = ranked();
    const a = take("alice");
    const b = take("bob");
    topOut(clock, session, a);
    expect(session.isOver).toBe(true);
    expect(calls).toEqual([1]);
    expect(a.peer.of("end")).toEqual([]); // held back until the report lands
    await flush();
    expect(a.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout", rating: RATINGS[0] } })]);
    expect(b.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout", rating: RATINGS[1] } })]);
    expect(a.peer.closed).toMatchObject({ code: 1000 });
    expect(b.peer.closed).toMatchObject({ code: 1000 });
    expect(clock.pending).toBe(0);
    clock.advance(RECONNECT_GRACE_MS * 2);
    expect(calls).toEqual([1]);
  });

  it("reports a disconnect forfeit as a loss for the player who left", async () => {
    const { clock, session, calls, take } = ranked();
    const a = take("alice");
    const b = take("bob");
    session.disconnect(a.conn);
    clock.advance(RECONNECT_GRACE_MS);
    expect(calls).toEqual([1]);
    await flush();
    expect(b.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "disconnect", rating: RATINGS[1] } })]);
    clock.advance(IDLE_TIMEOUT_MS * 2);
    expect(calls).toEqual([1]);
  });

  it("reports an idle match as a draw", async () => {
    const { clock, calls, take } = ranked();
    const a = take("alice");
    take("bob");
    clock.advance(IDLE_TIMEOUT_MS);
    expect(calls).toEqual([null]);
    await flush();
    expect(a.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: null, reason: "idle", rating: RATINGS[0] } })]);
  });

  it("rates nothing when the opponent never joins (the lobby's no-opponent reset)", async () => {
    const { clock, calls, take } = ranked();
    const a = take("alice");
    clock.advance(LOBBY_TIMEOUT_MS);
    expect(lastError(a)).toBe("no-opponent");
    await flush();
    expect(calls).toEqual([]);
  });

  it("still ends the match without ratings when report fails, throws or answers nonsense", async () => {
    const reports: Report[] = [
      async () => {
        throw new Error("accounts down");
      },
      () => {
        throw new Error("sync throw");
      },
      async () => null,
      async () => [{ tr: "12000", delta: null }, { tr: null, delta: null }] as unknown as [SlotRating, SlotRating],
      async () => [{ tr: 1.5, delta: null }, { tr: null, delta: null }],
    ];
    for (const report of reports) {
      const { clock, session, calls, take } = ranked(report);
      const a = take("alice");
      const b = take("bob");
      topOut(clock, session, a);
      await flush();
      expect(calls).toEqual([1]);
      for (const p of [a, b]) {
        expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout" } })]);
        expect(p.peer.closed).toMatchObject({ code: 1000 });
      }
      expect(clock.pending).toBe(0);
    }
  });

  it("sends end without ratings after REPORT_TIMEOUT_MS, and ignores a report that lands later", async () => {
    let land: (r: readonly [SlotRating, SlotRating]) => void = () => {};
    const { clock, session, calls, take } = ranked(() => new Promise((resolve) => (land = resolve)));
    const a = take("alice");
    const b = take("bob");
    topOut(clock, session, a);
    clock.advance(REPORT_TIMEOUT_MS - 1);
    await flush();
    expect(a.peer.of("end")).toEqual([]);
    clock.advance(1);
    for (const p of [a, b]) expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout" } })]);
    land(RATINGS);
    await flush();
    expect(a.peer.of("end")).toHaveLength(1);
    expect(calls).toEqual([1]);
    expect(clock.pending).toBe(0);
  });

  it("never reports an unranked match, and its end has no rating", () => {
    const { clock, session, p0, p1 } = setup();
    expect(session.isRanked).toBe(false);
    topOut(clock, session, p0);
    for (const p of [p0, p1]) expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout" } })]);
  });
});

describe("ranked: no-shows", () => {
  const ORIGIN = "https://teza.example";

  /** Accounts alice and bob with sessions, a queue host, and a ranked room registered for them as the matchmaker would. */
  async function world(clock: FakeClock) {
    const store = new MemoryStore();
    const host: QueueHost = { matchmaker: new Matchmaker(() => clock.t), openRoom: async () => true, cooldowns: new Map() };
    const call = (method: string, route: string, cookie?: string, body?: unknown) => handleAccount(new Request(`${ORIGIN}/api/account/${route}`, {
      method,
      headers: { ...(cookie ? { Cookie: `${COOKIE_NAME}=${cookie}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), store, () => clock.t, host);
    const tokens: Record<string, string> = {};
    for (const name of ["alice", "bob"]) {
      const res = await call("POST", "register", undefined, { username: name, password: "correct horse battery" });
      tokens[name] = /=([0-9a-f]+);/.exec(res.headers.get("Set-Cookie")!)![1];
    }
    store.insertRankedMatch("ABCDEF", { keys: ["alice", "bob"], createdAt: clock.t });
    const join = (name: string) => call("POST", "queue/join", tokens[name], {});
    return { store, host, join };
  }

  it("after 30 s with only A there: A gets no-opponent, B is reported once, nobody is rated, and B cools down 120 s", async () => {
    const clock = new FakeClock();
    const w = await world(clock);
    const { calls, noShows, take } = ranked(undefined, async (absent) => reportNoShow(w.store, w.host.cooldowns, "ABCDEF", absent, () => clock.t), clock);
    const a = take("alice");
    clock.advance(RANKED_LOBBY_TIMEOUT_MS - 1);
    expect(lastError(a)).toBeUndefined();
    clock.advance(1);
    expect(lastError(a)).toBe("no-opponent");
    expect(a.peer.closed).toMatchObject({ code: 1000, reason: "no-opponent" });
    expect(noShows).toEqual(["bob"]);
    await flush();
    expect(calls).toEqual([]);
    expect(w.store.ratings.size).toBe(0);
    expect(w.store.rankedMatch("ABCDEF")).toBeNull();

    const refused = await w.join("bob");
    expect(refused.status).toBe(429);
    expect((await refused.json()).retryAfter).toBeGreaterThan(0);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await w.join("alice")).status).toBe(200); // the present player may search again at once

    clock.advance(120_000);
    expect((await w.join("bob")).status).toBe(200);
    clock.advance(LOBBY_TIMEOUT_MS * 2);
    expect(noShows).toEqual(["bob"]);
  });

  it("reports nobody when neither account connects, or when the one there left before the timeout", async () => {
    const { clock, noShows, session, take } = ranked();
    clock.advance(LOBBY_TIMEOUT_MS * 2);
    expect(noShows).toEqual([]);
    const a = take("alice");
    session.disconnect(a.conn);
    clock.advance(RANKED_LOBBY_TIMEOUT_MS);
    expect(noShows).toEqual([]);
  });

  it("ignores a report that fails or throws", async () => {
    for (const noShow of [async () => Promise.reject(new Error("down")), () => {
      throw new Error("sync");
    }]) {
      const { clock, noShows, take } = ranked(undefined, noShow as () => Promise<unknown>);
      const a = take("bob");
      clock.advance(RANKED_LOBBY_TIMEOUT_MS);
      await flush();
      expect(noShows).toEqual(["alice"]);
      expect(lastError(a)).toBe("no-opponent");
    }
  });

  it("an ordinary room still waits 120 s for its opponent", () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const p0 = join(session);
    clock.advance(RANKED_LOBBY_TIMEOUT_MS);
    expect(lastError(p0)).toBeUndefined();
    clock.advance(LOBBY_TIMEOUT_MS - RANKED_LOBBY_TIMEOUT_MS - 1);
    expect(lastError(p0)).toBeUndefined();
    clock.advance(1);
    expect(lastError(p0)).toBe("no-opponent");
  });
});
