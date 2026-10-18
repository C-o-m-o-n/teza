import { describe, expect, it } from "vitest";
import {
  INITIAL_RANGE, MATCHED_TTL_MS, Matchmaker, QUEUE_STALE_MS, RANGE_EXPAND, RANGE_EXPAND_MS, formatRange, rangeAfter,
} from "../src/server/matchmaking";

function setup() {
  const clock = { t: 5_000_000 };
  const mm = new Matchmaker(() => clock.t);
  const advance = (ms: number) => (clock.t += ms);
  return { clock, mm, advance };
}

const alice = { key: "alice", username: "Alice" };
const bob = { key: "bob", username: "Bob" };
const carol = { key: "carol", username: "Carol" };

describe("matchmaking: range", () => {
  it("keeps the v1.0.0 values: ±500, widening by 500 every 10 s", () => {
    expect([INITIAL_RANGE, RANGE_EXPAND, RANGE_EXPAND_MS]).toEqual([500, 500, 10000]);
    expect(rangeAfter(0)).toBe(500);
    expect(rangeAfter(9999)).toBe(500);
    expect(rangeAfter(10_000)).toBe(1000);
    expect(rangeAfter(25_000)).toBe(1500);
  });
});

describe("matchmaking: pairing", () => {
  it("does not pair a 501 TR gap at 0 s, and pairs it at 10 s (±1000)", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12500);
    mm.join(bob, 13001);
    expect(mm.pair()).toEqual([]);
    const first = mm.status("alice");
    expect(first).toEqual({ status: "waiting", waited: 0, range: 500 });
    expect(formatRange((first as { range: number }).range)).toBe("±500");

    for (let t = 2000; t < 10_000; t += 2000) {
      advance(2000);
      mm.status("alice");
      mm.status("bob");
      expect(mm.pair()).toEqual([]);
    }
    advance(2000); // 10 s
    const later = mm.status("alice");
    expect(later).toEqual({ status: "waiting", waited: 10, range: 1000 });
    expect(formatRange((later as { range: number }).range)).toBe("±1000");
    mm.status("bob");
    const pairs = mm.pair();
    expect(pairs.map((p) => p.players.map((x) => x.key))).toEqual([["alice", "bob"]]);
    expect(mm.size).toBe(0);
  });

  it("pairs a 500 gap at once, and uses the wider of the two ranges", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12000);
    mm.join(bob, 12500);
    expect(mm.pair()).toHaveLength(1);

    mm.join(alice, 12000);
    advance(10_000);
    mm.status("alice");
    mm.join(carol, 13000); // fresh: ±500, but alice has waited 10 s (±1000)
    expect(mm.pair().map((p) => p.players.map((x) => x.key))).toEqual([["alice", "carol"]]);
  });

  it("pairs oldest first", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12500);
    advance(1000);
    mm.join(bob, 12500);
    advance(1000);
    mm.join(carol, 12500);
    expect(mm.pair().map((p) => p.players.map((x) => x.key))).toEqual([["alice", "bob"]]);
    expect(mm.status("carol")).toMatchObject({ status: "waiting" });
  });

  it("never pairs an account with itself: joining again replaces the entry", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12500);
    advance(3000);
    mm.join(alice, 12500);
    expect(mm.size).toBe(1);
    expect(mm.pair()).toEqual([]);
    expect(mm.status("alice")).toEqual({ status: "waiting", waited: 0, range: 500 });
  });

  it("delivers matched to both players, once each", () => {
    const { mm } = setup();
    mm.join(alice, 12500);
    mm.join(bob, 12500);
    const [pair] = mm.pair();
    expect(mm.status("alice")).toMatchObject({ status: "waiting" }); // still waiting while the room opens
    mm.matchedTo(pair, "ABCDEF");
    expect(mm.status("bob")).toEqual({ status: "matched", code: "ABCDEF" });
    expect(mm.status("alice")).toEqual({ status: "matched", code: "ABCDEF" });
    expect(mm.status("alice")).toEqual({ status: "none" });
    expect(mm.status("bob")).toEqual({ status: "none" });
  });

  it("forgets an unread match after 30 s", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12500);
    mm.join(bob, 12500);
    const [pair] = mm.pair();
    mm.matchedTo(pair, "ABCDEF");
    advance(MATCHED_TTL_MS - 1);
    expect(mm.status("alice")).toEqual({ status: "matched", code: "ABCDEF" });
    advance(1);
    expect(mm.status("bob")).toEqual({ status: "none" });
  });

  it("puts a pairing back when its room could not be opened, but not a player who left", () => {
    const { mm } = setup();
    mm.join(alice, 12500);
    mm.join(bob, 12500);
    const [pair] = mm.pair();
    mm.leave("bob");
    mm.requeue(pair);
    expect(mm.size).toBe(1);
    expect(mm.status("alice")).toMatchObject({ status: "waiting" });
    expect(mm.status("bob")).toEqual({ status: "none" });
  });
});

describe("matchmaking: keep-alive", () => {
  it("drops an entry not polled for 15 s", () => {
    const { mm, advance } = setup();
    mm.join(alice, 12500);
    advance(QUEUE_STALE_MS - 1);
    expect(mm.status("alice")).toMatchObject({ status: "waiting", waited: 14 });
    advance(QUEUE_STALE_MS - 1);
    expect(mm.status("alice")).toMatchObject({ status: "waiting" }); // the poll before kept it
    advance(QUEUE_STALE_MS);
    mm.join(bob, 12500);
    expect(mm.pair()).toEqual([]); // alice went stale, so bob waits alone
    expect(mm.status("alice")).toEqual({ status: "none" });
    expect(mm.size).toBe(1);
  });

  it("leave removes the entry, and is fine when there is none", () => {
    const { mm } = setup();
    mm.join(alice, 12500);
    mm.leave("alice");
    mm.leave("alice");
    mm.leave("nobody");
    expect(mm.status("alice")).toEqual({ status: "none" });
  });
});

describe("matchmaking: pair veto", () => {
  it("skips a vetoed pair (both keep waiting) and pairs each with someone else", () => {
    const clock = { t: 5_000_000 };
    const capped = new Set(["alice|bob"]);
    const mm = new Matchmaker(() => clock.t, (a, b) => !capped.has([a, b].sort().join("|")));
    mm.join(alice, 12500);
    mm.join(bob, 12500);
    expect(mm.pair()).toEqual([]);
    expect(mm.size).toBe(2);
    mm.join(carol, 12500);
    expect(mm.pair().map((p) => p.players.map((x) => x.key))).toEqual([["alice", "carol"]]);
    expect(mm.status("bob")).toMatchObject({ status: "waiting" });

    capped.clear(); // the cap lifted (24 h on): they pair again
    mm.join(alice, 12500);
    expect(mm.pair().map((p) => p.players.map((x) => x.key))).toEqual([["bob", "alice"]]);
  });
});
