// The online client (src/net/online.ts) against the real match server, over a simulated network
// with a fake clock: each direction of each socket has its own latency.
import { afterEach, describe, expect, it } from "vitest";
import { BOARD_W } from "../src/engine/constants";
import { Action, DEFAULT_HANDLING, Game } from "../src/engine/game";
import { stepTo } from "../src/engine/stepping";
import { JITTER_MS, OnlineClient, PACE_BURST, PING_MS } from "../src/net/online";
import { Conn, Envelope, INPUT_BURST, MATCH_HANDLING, MAX_INPUTS_PER_SECOND, MAX_REJECTED, MatchSession, Random, RECONNECT_GRACE_MS } from "../src/server/match";
import { FakeClock } from "./match-harness";

/** Packets in flight, delivered in time order (and send order at equal times). */
class Net {
  private q: { at: number; n: number; fn: () => void }[] = [];
  private n = 0;
  constructor(private clock: FakeClock) {}
  later(ms: number, fn: () => void): void {
    this.q.push({ at: this.clock.t + ms, n: this.n++, fn });
  }
  deliver(): void {
    for (;;) {
      const due = this.q.filter((p) => p.at <= this.clock.t).sort((a, b) => a.at - b.at || a.n - b.n)[0];
      if (!due) return;
      this.q.splice(this.q.indexOf(due), 1);
      due.fn();
    }
  }
}

interface Link {
  client: OnlineClient;
  conn: () => Conn;
  sent: Envelope[]; // what the client sent, as the server will read it
  arrived: number[]; // clock times the client's inputs reached the server
  heard: Envelope[]; // what the server sent the client
}

/** Uplink delay in ms: fixed, or asked per packet (the socket still keeps the order). */
type Delay = number | (() => number);

/** A client whose socket reaches `session` after `up` ms, and hears back after `down` ms. */
function link(session: MatchSession, net: Net, clock: FakeClock, up: Delay, down: number): Link {
  let conn: Conn | null = null;
  const sent: Envelope[] = [];
  const arrived: number[] = [];
  const heard: Envelope[] = [];
  let last = 0; // arrival time of the previous packet: a later one never overtakes it
  const upMs = () => {
    last = Math.max(last, clock.t + (typeof up === "number" ? up : up()));
    return last - clock.t;
  };
  const client = new OnlineClient({
    send: (data) => {
      const env: Envelope = JSON.parse(data);
      sent.push(env);
      net.later(upMs(), () => {
        if (env.t === "input") arrived.push(clock.t);
        session.message(conn!, data);
      });
    },
    close: () => net.later(upMs(), () => session.disconnect(conn!)),
  }, () => clock.now());
  net.later(upMs(), () => {
    conn = session.connect({
      send: (data) => net.later(down, () => {
        heard.push(JSON.parse(data));
        client.receive(data);
      }),
      close: () => net.later(down, () => client.closed()),
    });
  });
  return { client, conn: () => conn!, sent, arrived, heard };
}

let tokens = 0;
const fixed = (seed: number): Random => ({ seed: () => seed, token: () => (++tokens).toString(16).padStart(32, "0") });

function world(latency: [Delay, number, Delay, number] = [80, 80, 50, 130], seed = 4242, clock = new FakeClock()) {
  const session = new MatchSession(clock, fixed(seed));
  const net = new Net(clock);
  const a = link(session, net, clock, latency[0], latency[1]);
  const b = link(session, net, clock, latency[2], latency[3]);
  /** Let `ms` pass one millisecond at a time, delivering packets and calling `tick` about once a frame. */
  const run = (ms: number, tick?: () => void) => {
    for (let i = 0; i < ms; i++) {
      clock.advance(1);
      net.deliver();
      if (clock.t % 16 === 0) {
        a.client.update();
        b.client.update();
        tick?.();
      }
    }
  };
  run(400); // both welcomed and started
  return { clock, session, net, a, b, run };
}

/** Column heights and holes of a board's visible part. */
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

type Step = [Action, "press" | "release"] | "wait" | "blur";

/** Keys for a placement: rotate, tap sideways, hard drop. */
function keys(rot: number, dx: number): Step[] {
  const out: Step[] = [];
  const tap = (a: Action) => out.push([a, "press"], [a, "release"]);
  if (rot === 1) tap("cw");
  else if (rot === 2) tap("180");
  else if (rot === 3) tap("ccw");
  for (let i = 0; i < Math.abs(dx); i++) tap(dx < 0 ? "left" : "right");
  tap("hard");
  return out;
}

/** A small greedy player driving the client through real key presses, a step every `every`-th frame. */
class Driver {
  plan: Step[] = [];
  ticks = 0;
  blurAt: number;
  blurred = false;
  planned = -1; // pieces placed when the last plan was made
  constructor(private client: OnlineClient, blurAt: number, private every = 3) {
    this.blurAt = blurAt;
  }
  tick(): void {
    const c = this.client;
    const g = c.player;
    if (!g || g.over || c.phase !== "playing" || this.ticks++ % this.every) return;
    if (!this.plan.length) {
      if (g.stats.pieces === this.planned) return; // the last plan's inputs still wait for the budget
      this.planned = g.stats.pieces;
      if (!this.blurred && g.stats.pieces >= this.blurAt) {
        // hold left (DAS charges) and soft drop, then lose focus with both held
        this.blurred = true;
        this.plan = [["left", "press"], ["soft", "press"], ...Array<Step>(20).fill("wait"), "blur", ["hard", "press"], ["hard", "release"]];
      } else this.plan = this.best(g);
    }
    const step = this.plan.shift()!;
    if (step === "wait") return;
    if (step === "blur") return c.blur();
    if (step[1] === "press") c.press(step[0]);
    else c.release(step[0]);
  }
  private best(g: Game): Step[] {
    let best: Step[] = keys(0, 0);
    let bestScore = -Infinity;
    for (let rot = 0; rot < 4; rot++) {
      for (let dx = -5; dx <= 5; dx++) {
        const t = g.clone();
        const lines = t.stats.lines;
        for (const s of keys(rot, dx)) if (typeof s !== "string") s[1] === "press" ? t.press(s[0]) : t.release(s[0]);
        const cleared = t.stats.lines - lines;
        const { heights, holes } = shape(t);
        const bump = heights.slice(1).reduce((a, h, i) => a + Math.abs(h - heights[i]), 0);
        const score = cleared * cleared * 3 - heights.reduce((a, h) => a + h, 0) * 0.5 - holes * 4 - bump * 0.2 - (t.over ? 1000 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = keys(rot, dx);
        }
      }
    }
    return best;
  }
}

/** A board as text, for readable diffs. */
const rows = (g: Game) => g.board.map((r) => r.map((c) => c ?? ".").join("")).join("\n");

function expectOwnBoardMatches(client: OnlineClient, server: Game): void {
  const g = client.player!;
  // the client is ahead of the server's engine (at its last input); bring a copy up to it
  const s = server.clone();
  stepTo(s, g.frame);
  expect(s.frame).toBe(g.frame);
  expect(rows(g)).toBe(rows(s));
  expect(g.queue).toEqual(s.queue);
  expect(g.hold).toBe(s.hold);
  expect(g.piece).toEqual(s.piece);
  expect(g.stats).toEqual(s.stats);
  expect(g.incoming).toEqual(s.incoming);
}

function expectOpponentMatches(client: OnlineClient, server: Game): void {
  const o = client.opponent!;
  expect(o.frame).toBe(server.frame); // it rests at the last relayed frame
  expect(rows(o)).toBe(rows(server));
  expect(o.queue).toEqual(server.queue);
  expect(o.piece).toEqual(server.piece);
  expect(o.stats.lines).toBe(server.stats.lines);
  expect(o.stats.received).toBe(server.stats.received);
}

describe("online: joining", () => {
  it("is welcomed, starts with the server's rules and handling, and has no countdown", () => {
    const { session, a, b } = world();
    expect([a.client.slot, b.client.slot]).toEqual([1, 0]); // B's upgrade arrived first
    for (const c of [a.client, b.client]) {
      expect(c.phase).toBe("playing");
      expect(c.player!.handling).toEqual(MATCH_HANDLING);
      expect(c.player!.opts).toEqual(session.game(0)!.opts);
      expect(c.opponent!.opts).toEqual(session.game(0)!.opts);
    }
    // the clock started when `start` arrived: B's start took 130 ms, A's 80 ms
    expect(b.client.clock).toBeLessThan(a.client.clock);
  });
});

describe("online: convergence", () => {
  const handling = { ...MATCH_HANDLING };
  afterEach(() => Object.assign(MATCH_HANDLING, handling));

  const play = (seed?: number) => {
    const w = world(undefined, seed);
    const da = new Driver(w.a.client, 12);
    const db = new Driver(w.b.client, 20);
    w.run(40_000, () => {
      da.tick();
      db.tick();
    });
    w.run(1000); // hands off: the last packets land
    return w;
  };

  const check = ({ session, a, b }: ReturnType<typeof world>) => {
    for (const c of [a.client, b.client]) {
      expect(c.lastError).toBeNull();
      expect(c.player!.stats.pieces).toBeGreaterThan(40);
      expect(c.player!.stats.sent).toBeGreaterThan(0); // line clears attacked
      expect(c.player!.stats.received).toBeGreaterThan(0);
      expect(c.rewinds).toBeGreaterThan(0); // garbage landed behind the client's own frame
    }
    for (const c of [a.client, b.client]) {
      expect(c.result).toBeNull(); // still playing
      expectOwnBoardMatches(c, session.game(c.slot!)!);
      expectOpponentMatches(c, session.game(c.slot === 0 ? 1 : 0)!);
    }
  };

  it("keeps both clients' boards equal to the server's engines through attacks, rewinds and a blur", () => {
    const w = play();
    check(w);
    // the blur released left and soft on the server too, one by one
    for (const l of [w.a, w.b]) {
      const inputs = l.sent.filter((m) => m.t === "input").map((m) => m.d as { action: string; kind: string });
      expect(inputs.some((d, i) => d.action === "left" && d.kind === "release" && inputs[i + 1]?.action === "soft" && inputs[i + 1]?.kind === "release")).toBe(true);
    }
  });

  it("builds its games from start.handling, not the defaults or local settings", () => {
    // a server whose handling differs from the client's defaults: the client must follow it
    Object.assign(MATCH_HANDLING, { das: 7, arr: 0, dcd: 1, sdf: 20, irs: false, ihs: false });
    expect(MATCH_HANDLING).not.toEqual(DEFAULT_HANDLING);
    const w = play();
    expect(w.a.client.player!.handling).toEqual(MATCH_HANDLING);
    expect(w.a.client.opponent!.handling).toEqual(MATCH_HANDLING);
    check(w);
  });
});

describe("online: inputs", () => {
  it("never sends more than the server accepts per second, nor a frame lower than the last", () => {
    const { a, run } = world();
    let n = 0;
    run(3000, () => {
      for (let i = 0; i < 3; i++) a.client.press(n++ % 2 ? "cw" : "ccw"); // 180 inputs a second
    });
    run(2000);
    const inputs = a.sent.filter((m) => m.t === "input");
    const frames = inputs.map((m) => (m.d as { frame: number }).frame);
    expect(frames).toEqual([...frames].sort((x, y) => x - y));
    // a burst of PACE_BURST, then 60 a second (one a frame of clock): j - i + 1 inputs span frames[i]..frames[j]
    let worst = -Infinity;
    for (let i = 0; i < frames.length; i++) {
      for (let j = i; j < frames.length; j++) worst = Math.max(worst, j - i + 1 - (frames[j] - frames[i]));
    }
    expect(worst).toBeLessThanOrEqual(PACE_BURST + 1e-9);
    expect(worst).toBeGreaterThan(PACE_BURST - 1); // and it does use the burst
    expect(a.client.lastError).toBeNull(); // the server rejected none
  });

  it("releases on blur only what is held, and a later keyup sends nothing", () => {
    const { a, run } = world();
    a.client.press("left");
    a.client.press("soft");
    run(100);
    a.client.blur();
    a.client.release("left"); // the key comes up after the window got focus back
    const inputs = a.sent.filter((m) => m.t === "input").map((m) => m.d as { action: string; kind: string });
    expect(inputs.map((d) => `${d.kind} ${d.action}`)).toEqual(["press left", "press soft", "release left", "release soft"]);
  });

  it("pings when nothing else was sent for 10 s", () => {
    const { a, run } = world();
    run(PING_MS * 3);
    expect(a.sent.filter((m) => m.t === "ping").length).toBe(3);
  });
});

describe("online: jitter at the input cap", () => {
  /** An uplink that holds every packet sent in the first `stall` ms of each `period`, then lets them all through. */
  const stalls = (clock: FakeClock, period: number, stall: number, base: number, times = Infinity) => {
    const t0 = clock.t + 400; // the world's start-up isn't stalled
    return () => {
      const since = clock.t - t0;
      const phase = since % period;
      return since >= 0 && since < period * times && phase < stall ? base + stall - phase : base;
    };
  };

  /** The greedy driver taking a step every frame: about 62 inputs a second, just over the cap. */
  const drive = (w: ReturnType<typeof world>, ms: number) => {
    const da = new Driver(w.a.client, Infinity, 1);
    const db = new Driver(w.b.client, Infinity, 1);
    w.run(ms, () => {
      da.tick();
      db.tick();
    });
    w.run(3000); // hands off: the queues drain and the last packets land
  };

  const boardsMatch = ({ session, a, b }: ReturnType<typeof world>) => {
    for (const c of [a.client, b.client]) {
      expect(c.result).toBeNull();
      expectOwnBoardMatches(c, session.game(c.slot!)!);
      expectOpponentMatches(c, session.game(c.slot === 0 ? 1 : 0)!);
    }
  };

  /** The most inputs that reached the server at one instant, and within any `ms`. */
  const bunch = (arrived: number[], ms = 0) => Math.max(...arrived.map((t) => arrived.filter((x) => x <= t && x > t - ms - 0.5).length));

  it("bunched by 900 ms stalls, every input still fits the server's bucket and the boards match", () => {
    expect(JITTER_MS).toBe(1000);
    const clock = new FakeClock();
    const w = world([stalls(clock, 2000, 900, 40), 60, stalls(clock, 2000, 900, 70), 90], undefined, clock);
    drive(w, 20_000);
    for (const l of [w.a, w.b]) {
      const inputs = l.sent.filter((m) => m.t === "input").length;
      expect(inputs).toBeGreaterThan(20 * 58); // at the cap, about 60 a second
      expect(bunch(l.arrived)).toBeGreaterThan(50); // a stall's worth at once
      expect(bunch(l.arrived)).toBeLessThanOrEqual(INPUT_BURST);
      expect(bunch(l.arrived, 1000)).toBeGreaterThan(MAX_INPUTS_PER_SECOND); // more in a second than a 60-a-second window takes
      expect(l.client.lastError).toBeNull(); // the server refused none
      expect(l.client.refused).toBe(0);
    }
    boardsMatch(w);
  });

  it("takes back the inputs the server refuses when a stall outlasts the jitter budget, and still matches", () => {
    const clock = new FakeClock();
    const w = world([stalls(clock, 6000, 1250, 40, 2), 60, 50, 130], undefined, clock);
    drive(w, 10_000);
    const a = w.a.client;
    expect(a.lastError?.code).toBe("rate-limit");
    expect(a.refused).toBeGreaterThan(0);
    expect(a.refused).toBeLessThanOrEqual(MAX_REJECTED); // the socket stays open
    expect(w.b.client.refused).toBe(0);
    // both kinds were refused: presses were dropped, releases sent again (the server holds no key the client doesn't)
    const refusedS = new Set(w.a.heard.filter((m) => m.t === "error").map((m) => (m.d as { s: number }).s));
    const kinds = w.a.sent.filter((m) => m.t === "input" && refusedS.has(m.s)).map((m) => (m.d as { kind: string }).kind);
    expect(kinds.length).toBe(a.refused);
    expect(new Set(kinds)).toEqual(new Set(["press", "release"]));
    boardsMatch(w);
  });
});

describe("online: ending", () => {
  it("takes the outcome from the server's end, after a local top-out freezes input", () => {
    const { a, b, run } = world();
    let ends = 0;
    a.client.events.end = () => ends++;
    // A only hard drops: it tops out, then waits for the server
    run(20_000, () => {
      if (!a.client.player!.over) a.client.press("hard");
    });
    expect(a.client.player!.over).toBe(true);
    expect(a.client.result).toEqual({ outcome: "lose", reason: "topout" });
    expect(b.client.result).toEqual({ outcome: "win", reason: "topout" });
    expect(ends).toBe(1);
    expect(a.client.phase).toBe("over");
  });

  it("reports the opponent's disconnect, then the win by forfeit", () => {
    const { a, b, run } = world();
    const away: (number | null)[] = [];
    a.client.events.opponentAway = (ms) => away.push(ms);
    b.client.leave();
    run(1000);
    expect(away).toEqual([RECONNECT_GRACE_MS]);
    expect(a.client.result).toBeNull();
    run(RECONNECT_GRACE_MS);
    expect(a.client.result).toEqual({ outcome: "win", reason: "disconnect" });
  });

  it("ends as a lost connection when the socket closes before end", () => {
    const { a } = world();
    a.client.closed();
    expect(a.client.result).toEqual({ outcome: "lost", reason: "connection" });
  });
});
