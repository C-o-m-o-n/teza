// Spectators of a live ranked match: who may watch (admission), what they are sent, that their
// boards (src/net/spectate.ts) replay the server's engines exactly, and that they change nothing.
import { describe, expect, it } from "vitest";
import { BOARD_W } from "../src/engine/constants";
import { Action, Game } from "../src/engine/game";
import { stepTo, stepToClock } from "../src/engine/stepping";
import { PING_MS } from "../src/net/online";
import { SpectatorClient } from "../src/net/spectate";
import {
  Conn, Envelope, IDLE_TIMEOUT_MS, MAX_REJECTED, MAX_SPECTATE_EVENTS, MAX_SPECTATORS, MatchSession, Random, RankedConfig, REPORT_TIMEOUT_MS,
  SPECTATE_JOIN_BURST, SPECTATE_JOINS_PER_SECOND, SlotRating, admission,
} from "../src/server/match";
import { FakeClock, FakePeer, Player, input, join, lastError, send, setup } from "./match-harness";

const NOT_LIVE = { status: 404, message: "No such live match" };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let tokens = 0;
const fixed = (seed: number): Random => ({ seed: () => seed, token: () => (++tokens).toString(16).padStart(32, "0") });

/** A ranked session for alice and bob; `lives` records the live callback's calls. */
function ranked(seed = 4242, report: RankedConfig["report"] = async () => null) {
  const clock = new FakeClock();
  const lives: boolean[] = [];
  const session = new MatchSession(clock, fixed(seed), {
    accounts: ["alice", "bob"], report, noShow: async () => true, live: (on) => void lives.push(on),
  });
  const take = (account: string): Player => {
    const peer = new FakePeer();
    return { peer, conn: session.connect(peer, undefined, account) };
  };
  return { clock, session, lives, take };
}

function started(seed?: number, report?: RankedConfig["report"]) {
  const r = ranked(seed, report);
  const p0 = r.take("alice");
  const p1 = r.take("bob");
  expect(p0.peer.of("start")).toHaveLength(1);
  return { ...r, p0, p1, startAt: r.clock.now() };
}

/** A SpectatorClient wired straight to the session (no latency), recording what it sends. */
function watch(session: MatchSession, clock: FakeClock) {
  const sent: string[] = [];
  const heard: Envelope[] = [];
  let conn: Conn | null = null;
  const client = new SpectatorClient({
    send: (data) => {
      sent.push(data);
      session.message(conn!, data);
    },
    close: () => session.disconnect(conn!),
  }, () => clock.now());
  conn = session.connectSpectator({
    send: (data) => {
      heard.push(JSON.parse(data));
      client.receive(data);
    },
    close: () => client.closed(),
  });
  return { client, conn, sent, heard };
}

/** A FakePeer spectator, for the raw protocol. */
function peek(session: MatchSession): Player {
  const peer = new FakePeer();
  return { peer, conn: session.connectSpectator(peer) };
}

/** Column heights and holes of a board's visible part (online.test.ts's greedy player). */
function shape(g: Game) {
  const heights: number[] = [];
  let holes = 0;
  for (let x = 0; x < BOARD_W; x++) {
    let top = -1;
    for (let y = 0; y < g.board.length; y++) {
      if (g.board[y][x] !== null) {
        if (top < 0) top = y;
      } else if (top >= 0) holes++;
    }
    heights.push(top < 0 ? 0 : g.board.length - top);
  }
  return { heights, holes };
}

type Key = [Action, "press" | "release"];

function keys(rot: number, dx: number): Key[] {
  const out: Key[] = [];
  const tap = (a: Action) => out.push([a, "press"], [a, "release"]);
  if (rot === 1) tap("cw");
  else if (rot === 2) tap("180");
  else if (rot === 3) tap("ccw");
  for (let i = 0; i < Math.abs(dx); i++) tap(dx < 0 ? "left" : "right");
  tap("hard");
  return out;
}

/** The best placement for `g`'s piece by a small greedy score, as key taps. */
function best(g: Game): Key[] {
  let out = keys(0, 0);
  let top = -Infinity;
  for (let rot = 0; rot < 4; rot++) {
    for (let dx = -5; dx <= 5; dx++) {
      const t = g.clone();
      const lines = t.stats.lines;
      for (const [a, k] of keys(rot, dx)) (k === "press" ? t.press(a) : t.release(a));
      const cleared = t.stats.lines - lines;
      const { heights, holes } = shape(t);
      const bump = heights.slice(1).reduce((a, h, i) => a + Math.abs(h - heights[i]), 0);
      const score = cleared * cleared * 3 - heights.reduce((a, h) => a + h, 0) * 0.5 - holes * 4 - bump * 0.2 - (t.over ? 1000 : 0);
      if (score > top) {
        top = score;
        out = keys(rot, dx);
      }
    }
  }
  return out;
}

/**
 * Both players place a piece every `everyMs` (greedy, at a mid-frame clock), `pad` extra no-op
 * inputs each (a release of the unheld hold key), while `paused(slot, ms)` lets one go quiet.
 */
function play(m: ReturnType<typeof started>, ms: number, opts: { everyMs?: number; pad?: number; paused?: (slot: number, at: number) => boolean; tick?: () => void } = {}) {
  const { clock, session, p0, p1, startAt } = m;
  const every = opts.everyMs ?? 263;
  const end = clock.now() + ms;
  while (clock.now() < end && !session.isOver) {
    clock.advance(every);
    [p0, p1].forEach((p, slot) => {
      if (session.isOver || opts.paused?.(slot, clock.now() - startAt)) return;
      const frame = Math.floor(((clock.now() - startAt) * 60 * 256) / 1000) / 256;
      const g = session.game(slot as 0 | 1)!.clone();
      stepToClock(g, frame, true);
      if (g.over) return;
      for (let i = 0; i < (opts.pad ?? 0); i++) input(session, p, frame, "hold", "release");
      for (const [a, k] of best(g)) input(session, p, frame, a, k);
    });
    opts.tick?.();
  }
}

const rows = (g: Game) => g.board.map((r) => r.map((c) => c ?? ".").join("")).join("\n");

/** A spectator board against the server's engine: equal once both are brought to the later frame. */
function expectSameBoard(watched: Game, server: Game): void {
  expect(watched.frame).toBeLessThanOrEqual(server.frame); // it rests at its last event, never ahead
  const a = watched.clone();
  const b = server.clone();
  const f = Math.max(a.frame, b.frame);
  stepTo(a, f);
  stepTo(b, f);
  expect(rows(a)).toBe(rows(b));
  expect(a.queue).toEqual(b.queue);
  expect(a.hold).toBe(b.hold);
  expect(a.piece).toEqual(b.piece);
  expect(a.stats).toEqual(b.stats);
  expect(a.incoming).toEqual(b.incoming);
  expect(a.over).toBe(b.over);
}

function expectWatching(client: SpectatorClient, session: MatchSession): void {
  expect(client.boards).not.toBeNull();
  expectSameBoard(client.boards![0], session.game(0)!);
  expectSameBoard(client.boards![1], session.game(1)!);
}

describe("spectate: admission", () => {
  it("is open only on a started, unfinished ranked match, with one 404 for everything else", async () => {
    // a free code, an unranked room in its lobby and started, a ranked lobby
    expect(admission(new MatchSession(new FakeClock()), "spectate", null)).toEqual(NOT_LIVE);
    const lobby = new MatchSession(new FakeClock());
    join(lobby);
    expect(admission(lobby, "spectate", null)).toEqual(NOT_LIVE);
    const { session: plain } = setup();
    expect(plain.isLive).toBe(true);
    expect(admission(plain, "spectate", null)).toEqual(NOT_LIVE);
    expect(admission(plain, "spectate", "alice")).toEqual(NOT_LIVE);
    const r = ranked();
    r.take("alice");
    expect(admission(r.session, "spectate", null)).toEqual(NOT_LIVE);
    r.take("bob");
    expect(admission(r.session, "spectate", null)).toBeNull();
    expect(admission(r.session, "spectate", "mallory")).toBeNull(); // an account plays no part
    // finished: bob stops talking, the match ends idle
    r.clock.advance(IDLE_TIMEOUT_MS);
    expect(r.session.isOver).toBe(true);
    expect(admission(r.session, "spectate", null)).toEqual(NOT_LIVE);
    await flush();
  });

  it("refuses connectSpectator on anything but a live ranked match, so a socket past the adapter gets nothing", () => {
    const { session } = setup();
    const s = peek(session);
    expect(lastError(s)).toBe("not-live");
    expect(s.peer.closed?.code).toBe(1008);
    expect(s.peer.of("spectate")).toHaveLength(0);
    expect(session.spectatorCount).toBe(0);
  });
});

describe("spectate: the live callback", () => {
  it("is called with true once at start and false once at the end", async () => {
    for (const ending of ["idle", "disconnect", "topout"] as const) {
      const m = started();
      expect(m.lives).toEqual([true]);
      if (ending === "idle") m.clock.advance(IDLE_TIMEOUT_MS);
      else if (ending === "disconnect") {
        m.session.disconnect(m.p1.conn);
        m.clock.advance(60_000);
      } else {
        let frame = 0;
        for (let i = 0; i < 100 && !m.session.isOver; i++) {
          m.clock.advance(100);
          frame += 6;
          input(m.session, m.p0, frame, "hard");
        }
      }
      expect(m.session.isOver, ending).toBe(true);
      m.clock.advance(REPORT_TIMEOUT_MS);
      await flush();
      expect(m.lives, ending).toEqual([true, false]);
    }
  });

  it("never throws into the match when it fails", async () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock, fixed(1), {
      accounts: ["alice", "bob"], report: async () => null, noShow: async () => true,
      live: (on) => {
        if (on) throw new Error("rpc down");
        return Promise.reject(new Error("rpc down"));
      },
    });
    const a = new FakePeer();
    session.connect(a, undefined, "alice");
    session.connect(new FakePeer(), undefined, "bob");
    expect(a.of("start")).toHaveLength(1);
    clock.advance(IDLE_TIMEOUT_MS);
    await flush();
    expect(a.of("end")).toHaveLength(1);
  });

  it("is absent from an unranked match", () => {
    const { session } = setup();
    expect(session.isRanked).toBe(false);
  });
});

describe("spectate: the protocol", () => {
  it("sends spectate with start's data, the log so far and the wall frame, then specEvents in the envelope", () => {
    const m = started();
    const start = m.p0.peer.of("start")[0].d as Record<string, unknown>;
    m.clock.advance(500);
    input(m.session, m.p0, 30, "left");
    input(m.session, m.p0, 30, "left", "release");
    const s = peek(m.session);
    const [spectate] = s.peer.sent;
    expect(spectate.t).toBe("spectate");
    expect(spectate.s).toBe(1);
    expect(spectate.a).toBe(0);
    const d = spectate.d as Record<string, unknown>;
    expect(d.seed).toBe(start.seed);
    expect(d.options).toEqual(start.options);
    expect(d.handling).toEqual(start.handling);
    expect(d.elapsed).toBe(30);
    expect(d.events).toEqual([
      { k: "input", slot: 0, frame: 30, action: "left", kind: "press" },
      { k: "input", slot: 0, frame: 30, action: "left", kind: "release" },
    ]);
    m.clock.advance(100);
    input(m.session, m.p1, 35.5, "cw");
    expect(s.peer.last()).toEqual({ t: "specEvent", s: 2, a: 0, d: { k: "input", slot: 1, frame: 35.5, action: "cw", kind: "press" } });
    // the frame is the one the engine applied it at, as relayed to the opponent
    expect(m.p0.peer.of("opponentInput").pop()!.d).toEqual({ frame: 35.5, action: "cw", kind: "press" });
  });

  it("logs garbage with the receiving slot and the frame it landed at, in the order the players hear it", () => {
    const m = started();
    const s = peek(m.session);
    play(m, 30_000, { tick: () => undefined });
    const garbage = s.peer.of("specEvent").map((e) => e.d as Record<string, unknown>).filter((e) => e.k === "garbage");
    expect(garbage.length).toBeGreaterThan(0);
    for (const slot of [0, 1] as const) {
      const heard = (slot === 0 ? m.p0 : m.p1).peer.of("garbage").map((e) => e.d);
      expect(garbage.filter((e) => e.slot === slot).map(({ amount, frame }) => ({ amount, frame }))).toEqual(heard);
    }
  });
});

describe("spectate: parity with the server's engines", () => {
  it("gives spectators joining at the start, mid-match and late both boards equal to the server's, garbage and catch-ups included", () => {
    const m = started(777);
    const early = watch(m.session, m.clock);
    let mid: ReturnType<typeof watch> | null = null;
    let late: ReturnType<typeof watch> | null = null;
    let midChecked = false;
    // bob goes quiet for 10 s twice: his engine is caught up (gravity, garbage at whole frames) by alice's messages
    const paused = (slot: number, at: number) => slot === 1 && ((at > 10_000 && at < 20_000) || (at > 28_000 && at < 38_000));
    play(m, 45_000, {
      paused,
      tick: () => {
        const at = m.clock.now() - m.startAt;
        if (!mid && at > 15_000) mid = watch(m.session, m.clock);
        if (!late && at > 40_000) late = watch(m.session, m.clock);
        if (mid && !midChecked && at > 20_000) {
          midChecked = true;
          expectWatching(mid.client, m.session);
          expectWatching(early.client, m.session);
        }
      },
    });
    expect(m.session.isOver).toBe(false);
    for (const slot of [0, 1] as const) {
      const g = m.session.game(slot)!;
      expect(g.stats.pieces).toBeGreaterThan(80);
      expect(g.stats.received).toBeGreaterThan(0);
    }
    const spectate = late!.heard[0].d as { events: unknown[] };
    expect(spectate.events.length).toBeGreaterThan(1000); // a long log, replayed on join
    const garbageCatchUp = early.heard.filter((e) => e.t === "specEvent" && (e.d as { k: string; frame: number }).k === "garbage"
      && Number.isInteger((e.d as { frame: number }).frame));
    expect(garbageCatchUp.length).toBeGreaterThan(0); // some garbage landed on a whole frame, between inputs
    for (const w of [early, mid!, late!]) {
      expect(w.client.phase).toBe("watching");
      expect(w.client.lastError).toBeNull();
      expectWatching(w.client, m.session);
    }
  });

  it("ends with the boards equal to the server's when the match ends by top-out, and the result by slot", async () => {
    const m = started(99);
    const w = watch(m.session, m.clock);
    let frame = 0;
    for (let i = 0; i < 200 && !m.session.isOver; i++) {
      m.clock.advance(100);
      frame += 6;
      input(m.session, m.p1, frame, "hard"); // bob only hard drops
      input(m.session, m.p0, frame, "hold", "release"); // alice only keeps talking
    }
    expect(m.session.isOver).toBe(true);
    expectWatching(w.client, m.session);
    expect(w.client.boards![1].over).toBe(true);
    m.clock.advance(REPORT_TIMEOUT_MS);
    await flush();
    expect(w.client.result).toEqual({ winner: 0, reason: "topout" });
    expect(w.client.phase).toBe("over");
  });
});

describe("spectate: spectators are inert", () => {
  it("answers spectator input with error spectator, and the engines never see it", () => {
    const m = started();
    m.clock.advance(1000);
    input(m.session, m.p0, 50, "left");
    const s = peek(m.session);
    const before = [m.session.game(0)!.clone(), m.session.game(1)!.clone()];
    for (const action of ["hard", "left", "cw"]) send(m.session, s, "input", { frame: 55, action, kind: "press" });
    expect(lastError(s)).toBe("spectator");
    expect(s.peer.of("error")).toHaveLength(3);
    for (const slot of [0, 1] as const) {
      const g = m.session.game(slot)!;
      expect(g.frame).toBe(before[slot].frame);
      expect(rows(g)).toBe(rows(before[slot]));
      expect(g.piece).toEqual(before[slot].piece);
      expect(g.stats).toEqual(before[slot].stats);
    }
    expect(m.p0.peer.of("opponentInput")).toHaveLength(0);
    expect(m.p1.peer.of("opponentInput")).toHaveLength(1);
    expect(s.peer.of("specEvent")).toHaveLength(0);
  });

  it("answers ping with pong s:0 a:0, and pings never keep a silent match from ending idle", async () => {
    const m = started();
    const s = peek(m.session);
    for (let t = 5000; t < IDLE_TIMEOUT_MS; t += 5000) {
      m.clock.advance(5000);
      send(m.session, s, "ping");
    }
    expect(s.peer.of("pong")).toHaveLength(11);
    expect(s.peer.of("pong")[0]).toEqual({ t: "pong", s: 0, a: 0 });
    expect(m.session.isOver).toBe(false);
    m.clock.advance(5000); // IDLE_TIMEOUT_MS after the start, the last player message
    expect(m.session.isOver).toBe(true);
    m.clock.advance(REPORT_TIMEOUT_MS);
    await flush();
    expect(m.p0.peer.of("end")[0].d).toMatchObject({ winner: null, reason: "idle" });
  });

  it(`takes ${MAX_SPECTATORS} spectators, then answers busy and closes`, () => {
    const m = started();
    const all = Array.from({ length: MAX_SPECTATORS }, () => {
      m.clock.advance(1000 / SPECTATE_JOINS_PER_SECOND); // within the join rate
      return peek(m.session);
    });
    expect(all.every((s) => s.peer.of("spectate").length === 1 && s.peer.closed === null)).toBe(true);
    const extra = peek(m.session);
    expect(lastError(extra)).toBe("busy");
    expect(extra.peer.closed?.code).toBe(1008);
    expect(extra.peer.of("spectate")).toHaveLength(0);
    // one leaves: there is room again
    m.session.disconnect(all[0].conn);
    m.clock.advance(1000);
    expect(peek(m.session).peer.of("spectate")).toHaveLength(1);
  });

  it("meters joins per match: rapid open/close cycles get busy, and the players' inputs keep being accepted", () => {
    const m = started();
    m.clock.advance(1000);
    let frame = 0;
    let joined = 0;
    let busy = 0;
    // 1000 sockets opened and closed as fast as possible, 5 per millisecond, while both players keep playing (40 inputs each)
    for (let i = 0; i < 1000; i++) {
      const s = peek(m.session);
      if (s.peer.of("spectate").length) joined++;
      else if (lastError(s) === "busy") {
        busy++;
        expect(s.peer.sent).toHaveLength(1); // refused before any log is sent
        expect(s.peer.closed?.code).toBe(1008);
      }
      m.session.disconnect(s.conn);
      if (i % 5 === 4) m.clock.advance(1);
      if (i % 50 === 49) {
        frame = Math.floor(((m.clock.now() - m.startAt) * 60 * 256) / 1000) / 256;
        input(m.session, m.p0, frame, "left");
        input(m.session, m.p0, frame, "left", "release");
        input(m.session, m.p1, frame, "right");
        input(m.session, m.p1, frame, "right", "release");
      }
    }
    // 200 ms of cycles: the burst, plus the rate's share of 0.2 s
    expect(joined).toBe(SPECTATE_JOIN_BURST);
    expect(busy).toBe(1000 - SPECTATE_JOIN_BURST);
    expect(m.session.spectatorCount).toBe(0);
    for (const p of [m.p0, m.p1]) expect(p.peer.of("error")).toEqual([]); // no frame-late, no rate-limit: every input applied
    expect(m.p1.peer.of("opponentInput")).toHaveLength(40);
    // after a second the rate lets new spectators in again
    m.clock.advance(1000);
    expect(peek(m.session).peer.of("spectate")).toHaveLength(1);
  });

  it(`closes a spectator with 1008 after ${MAX_REJECTED} rejected messages`, () => {
    const m = started();
    const s = peek(m.session);
    for (let i = 0; i < MAX_REJECTED; i++) {
      m.session.message(s.conn, i % 2 ? "{nope" : JSON.stringify({ t: "resume", s: 1, a: 0, d: { token: "0".repeat(32), peerAck: 0 } }));
    }
    expect(s.peer.closed).toBeNull();
    expect(s.peer.of("error").map((e) => (e.d as { code: string }).code)).toContain("bad-json");
    expect(s.peer.of("error").map((e) => (e.d as { code: string }).code)).toContain("bad-type");
    m.session.message(s.conn, "x".repeat(2000)); // too large
    expect(s.peer.closed).toEqual({ code: 1008, reason: "too-large" });
    expect(m.session.spectatorCount).toBe(0);
  });

  it("never changes hasPlayers, the slots or whether a third player is told full", () => {
    const m = started();
    expect(m.session.hasPlayers).toBe(true);
    const specs = Array.from({ length: 5 }, () => peek(m.session));
    expect(m.session.hasPlayers).toBe(true);
    // a socket for a slot is still refused the same way: both slots are held
    expect(admission(m.session, "ranked", "mallory")).toMatchObject({ status: 403 });
    for (const s of specs) m.session.disconnect(s.conn);
    expect(m.session.hasPlayers).toBe(true);
    expect(m.p0.peer.closed).toBeNull();
    expect(m.p1.peer.closed).toBeNull();

    // an unranked room: a third player gets full, with spectators or without (they can't be there)
    const { session } = setup();
    peek(session);
    const third = join(session);
    expect(lastError(third)).toBe("full");
    // and with a player away, the free slot still waits for its resume, not a spectator
    const r = started();
    r.session.disconnect(r.p1.conn);
    const s = peek(r.session);
    expect(s.peer.of("spectate")).toHaveLength(1);
    expect(r.session.hasPlayers).toBe(true);
    expect(r.p0.peer.of("opponentDisconnected")).toHaveLength(1);
    expect(r.p0.peer.of("opponentReconnected")).toHaveLength(0);
  });

  it("sends spectators end with winner and reason but no rating, closes them with 1000 ended, and refuses new ones", async () => {
    const RATINGS: [SlotRating, SlotRating] = [{ tr: 13120, delta: 120 }, { tr: 11915, delta: -85 }];
    const m = started(4242, async () => RATINGS);
    const s = peek(m.session);
    m.session.disconnect(m.p1.conn);
    m.clock.advance(16_000); // bob forfeits
    expect(m.session.isOver).toBe(true);
    expect(peek(m.session).peer.closed?.code).toBe(1008); // between finish and end: no longer live
    await flush();
    expect(m.p0.peer.of("end")[0].d).toEqual({ winner: 0, reason: "disconnect", rating: RATINGS[0] });
    expect(s.peer.of("end")).toHaveLength(1);
    expect(s.peer.of("end")[0].d).toEqual({ winner: 0, reason: "disconnect" });
    expect(s.peer.closed).toEqual({ code: 1000, reason: "ended" });
    expect(m.session.spectatorCount).toBe(0);
    const after = peek(m.session);
    expect(lastError(after)).toBe("not-live");
    expect(admission(m.session, "spectate", null)).toEqual(NOT_LIVE);
  });
});

describe("spectate: the log cap", () => {
  it(`stops at ${MAX_SPECTATE_EVENTS} events: new spectators get too-long, existing ones keep getting specEvents`, () => {
    const m = started(31337);
    const w = watch(m.session, m.clock);
    // a piece every 500 ms with 14 padding inputs: at most 56 inputs a second each, under the rate limit
    play(m, 400_000, {
      everyMs: 500, pad: 14,
      tick: () => {
        if (w.heard.length > MAX_SPECTATE_EVENTS + 200) m.session.disconnect(m.p1.conn); // enough: stop the match soon
      },
    });
    const events = w.heard.filter((e) => e.t === "specEvent").length;
    expect(events).toBeGreaterThan(MAX_SPECTATE_EVENTS);
    expect(w.client.lastError).toBeNull();
    expectWatching(w.client, m.session);
  });

  it("refuses a spectator once the log is full", () => {
    const m = started(31337);
    const w = watch(m.session, m.clock);
    let refused: Player | null = null;
    play(m, 400_000, {
      everyMs: 500, pad: 14,
      tick: () => {
        const n = w.heard.filter((e) => e.t === "specEvent").length;
        if (!refused && n >= MAX_SPECTATE_EVENTS + 50) {
          refused = peek(m.session);
          m.session.disconnect(m.p1.conn);
        }
      },
    });
    expect(refused).not.toBeNull();
    expect(lastError(refused!)).toBe("too-long");
    expect(refused!.peer.closed?.code).toBe(1008);
    expect(refused!.peer.of("spectate")).toHaveLength(0);
  });
});

describe("SpectatorClient", () => {
  const OPTIONS = { seed: 7, hasgarbage: true };
  const spectate = (events: unknown[] = []) => JSON.stringify({ t: "spectate", s: 1, a: 0, d: { seed: 7, options: OPTIONS, handling: {}, events, elapsed: 0 } });

  function client(now = () => 0) {
    const sent: string[] = [];
    let closes = 0;
    const c = new SpectatorClient({ send: (d) => sent.push(d), close: () => closes++ }, now);
    return { c, sent, closes: () => closes };
  }

  it("ignores malformed JSON, unknown types and events before spectate", () => {
    const { c } = client();
    for (const data of ["{", "null", "[]", '"x"', JSON.stringify({ t: 5 }), JSON.stringify({ t: "welcome", d: { slot: 0 } }),
      JSON.stringify({ t: "specEvent", s: 1, d: { k: "input", slot: 0, frame: 1, action: "hard", kind: "press" } })]) {
      c.receive(data);
    }
    expect(c.phase).toBe("connecting");
    expect(c.boards).toBeNull();
    // a spectate without its parts is ignored too
    c.receive(JSON.stringify({ t: "spectate", s: 1, d: { options: OPTIONS, handling: {} } }));
    expect(c.phase).toBe("connecting");
    c.receive(spectate());
    expect(c.phase).toBe("watching");
    c.receive(spectate([{ k: "input", slot: 0, frame: 1, action: "hard", kind: "press" }])); // a second one changes nothing
    expect(c.boards![0].stats.pieces).toBe(0);
  });

  it("applies the log and live events by slot, skipping malformed entries, and fires garbage only for live ones", () => {
    const { c } = client();
    const garbage: [number, number][] = [];
    let starts = 0;
    c.events = { start: () => starts++, garbage: (slot, n) => garbage.push([slot, n]) };
    c.receive(spectate([
      { k: "input", slot: 1, frame: 10.5, action: "hard", kind: "press" },
      { k: "garbage", slot: 0, amount: 2, frame: 12 },
      { k: "input", slot: 2, frame: 13, action: "hard", kind: "press" },
      { k: "input", slot: 0, frame: 13, action: "jump", kind: "press" },
      { k: "input", slot: 0, frame: "13", action: "hard", kind: "press" },
      { k: "garbage", slot: 0, amount: "9", frame: 14 },
      "junk",
    ]));
    expect(starts).toBe(1);
    const [a, b] = c.boards!;
    expect(b.stats.pieces).toBe(1);
    expect(b.frame).toBe(10.5);
    expect(a.stats.received).toBe(2);
    expect(a.frame).toBe(12);
    expect(garbage).toEqual([]);
    c.receive(JSON.stringify({ t: "specEvent", s: 2, a: 0, d: { k: "garbage", slot: 1, amount: 3, frame: 20 } }));
    expect(garbage).toEqual([[1, 3]]);
    expect(b.stats.received).toBe(3);
    expect(b.frame).toBe(20); // rests at its last event
  });

  it("sets result and phase over on end, once", () => {
    const { c } = client();
    const ends: unknown[] = [];
    c.events.end = (r) => ends.push(r);
    c.receive(spectate());
    c.receive(JSON.stringify({ t: "end", s: 2, a: 0, d: { winner: 1, reason: "topout", rating: { tr: 1, delta: 1 } } }));
    expect(c.result).toEqual({ winner: 1, reason: "topout" });
    expect(c.phase).toBe("over");
    c.receive(JSON.stringify({ t: "end", s: 3, a: 0, d: { winner: 0, reason: "idle" } }));
    expect(ends).toEqual([{ winner: 1, reason: "topout" }]);
    const draw = client().c;
    draw.receive(spectate());
    draw.receive(JSON.stringify({ t: "end", s: 2, a: 0, d: { winner: null, reason: "idle" } }));
    expect(draw.result).toEqual({ winner: null, reason: "idle" });
  });

  it("reports closed when the socket closes before spectate, and records errors", () => {
    const { c } = client();
    let closed = 0;
    const errors: string[] = [];
    c.events = { closed: () => closed++, error: (code) => errors.push(code) };
    c.receive(JSON.stringify({ t: "error", s: 1, a: 0, d: { code: "busy", message: "too many spectators" } }));
    expect(errors).toEqual(["busy"]);
    expect(c.lastError).toEqual({ code: "busy", message: "too many spectators" });
    c.closed();
    expect(closed).toBe(1);
    expect(c.phase).toBe("over");
    c.closed();
    expect(closed).toBe(1);
  });

  it("never sends anything but ping, every PING_MS", () => {
    let t = 0;
    const { c, sent, closes } = client(() => t);
    for (; t < PING_MS * 3 + 1; t += 16) {
      c.update();
      if (t === 1000) c.receive(spectate());
    }
    expect(sent.map((d) => JSON.parse(d).t)).toEqual(["ping", "ping", "ping"]);
    c.leave();
    expect(closes()).toBe(1);
    for (t = PING_MS * 4; t < PING_MS * 6; t += 16) c.update();
    expect(sent).toHaveLength(3);
  });
});
