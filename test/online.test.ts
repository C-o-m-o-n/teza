// The online client (src/net/online.ts) against the real match server, over a simulated network
// with a fake clock: each direction of each socket has its own latency.
import { afterEach, describe, expect, it } from "vitest";
import { BOARD_W } from "../src/engine/constants";
import { Action, DEFAULT_HANDLING, Game } from "../src/engine/game";
import { stepTo } from "../src/engine/stepping";
import { OnlineClient, PING_MS } from "../src/net/online";
import { Conn, Envelope, MATCH_HANDLING, MAX_INPUTS_PER_SECOND, MatchSession, Random, RECONNECT_GRACE_MS } from "../src/server/match";
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
}

/** A client whose socket reaches `session` after `up` ms, and hears back after `down` ms. */
function link(session: MatchSession, net: Net, clock: FakeClock, up: number, down: number): Link {
  let conn: Conn | null = null;
  const sent: Envelope[] = [];
  const client = new OnlineClient({
    send: (data) => {
      sent.push(JSON.parse(data));
      net.later(up, () => session.message(conn!, data));
    },
    close: () => net.later(up, () => session.disconnect(conn!)),
  }, () => clock.now());
  net.later(up, () => {
    conn = session.connect({
      send: (data) => net.later(down, () => client.receive(data)),
      close: () => net.later(down, () => client.closed()),
    });
  });
  return { client, conn: () => conn!, sent };
}

let tokens = 0;
const fixed = (seed: number): Random => ({ seed: () => seed, token: () => (++tokens).toString(16).padStart(32, "0") });

function world(latency: [number, number, number, number] = [80, 80, 50, 130], seed = 4242) {
  const clock = new FakeClock();
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

/** A small greedy player driving the client through real key presses, a step every third frame. */
class Driver {
  plan: Step[] = [];
  ticks = 0;
  blurAt: number;
  blurred = false;
  constructor(private client: OnlineClient, blurAt: number) {
    this.blurAt = blurAt;
  }
  tick(): void {
    const c = this.client;
    const g = c.player;
    if (!g || g.over || c.phase !== "playing" || this.ticks++ % 3) return;
    if (!this.plan.length) {
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
    for (let i = MAX_INPUTS_PER_SECOND; i < frames.length; i++) {
      expect(frames[i] - frames[i - MAX_INPUTS_PER_SECOND]).toBeGreaterThanOrEqual(60); // 60 per second of clock at most
    }
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
