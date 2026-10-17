import { describe, expect, it } from "vitest";
import { Action, Game } from "../src/engine/game";
import { stepToClock } from "../src/engine/stepping";
import { MATCH_HANDLING, matchOptions } from "../src/server/match";
import { input, setup } from "./match-harness";

type Kind = "press" | "release";

// Client clock (frames since GO) at each input: mostly off the 1/256-frame grid.
const SCRIPT: [number, Action, Kind][] = [
  // DAS into ARR, held across fractional ticks
  [3.37, "left", "press"], [18.81, "left", "release"], [20.13, "cw", "press"], [20.5, "cw", "release"],
  [22.9, "hard", "press"], [23.2, "hard", "release"],
  // lands on frame 30 and is released on 42: DAS 10 and one ARR 2 run out exactly on the release
  [30.0039, "right", "press"], [42, "right", "release"], [44.6, "hard", "press"], [44.7, "hard", "release"],
  // soft drop to the floor, then moves while the piece rests there in lock delay, until it locks
  [47.41, "soft", "press"], [126.77, "soft", "release"], [130.123, "ccw", "press"], [130.9, "ccw", "release"],
  [136.4567, "left", "press"], [136.7, "left", "release"],
  // the next piece: hold, a 180 and a soft drop held across ticks, then a hard drop off the grid
  [170.001, "hold", "press"], [171.3, "hold", "release"], [175.66, "180", "press"], [176.02, "180", "release"],
  [180.2, "soft", "press"], [191.97, "right", "press"], [205.333, "right", "release"], [206.5, "soft", "release"],
  [210.12345, "hard", "press"],
];

const SEED = 99;
const TICKS = [1.0371, 0.8313, 1.6667, 0.25, 2.003]; // frames per animation frame, irregular

/** A client game stepped as App does: a clock in display ticks, inputs at the clock. */
class Client {
  readonly game: Game;
  readonly landed: number[] = []; // game.frame at each input
  lockDelay = 0; // inputs applied while the piece rested on the floor in lock delay
  private clock = 0;
  private tick = 0;

  constructor(seed: number, private ticks = TICKS) {
    this.game = new Game(matchOptions(seed), MATCH_HANDLING);
  }

  input(at: number, action: Action, kind: Kind): void {
    while (this.clock < at) {
      this.clock = Math.min(at, this.clock + this.ticks[this.tick++ % this.ticks.length]);
      stepToClock(this.game, this.clock);
    }
    stepToClock(this.game, this.clock, true);
    if (this.game.piece.locking > 0) this.lockDelay++;
    this.landed.push(this.game.frame);
    if (kind === "press") this.game.press(action);
    else this.game.release(action);
  }
}

function state(g: Game) {
  return { frame: g.frame, board: g.board, piece: g.piece, hold: g.hold, queue: g.queue, stats: g.stats };
}

describe("stepping: client and server", () => {
  it("reach the same game from the same timed inputs", () => {
    let tokens = 0;
    const { clock, session, p0, p1 } = setup({ seed: () => SEED, token: () => `token-${++tokens}` });
    const startedAt = clock.now();
    const client = new Client((p0.peer.of("start")[0].d as { seed: number }).seed);
    for (const [at, action, kind] of SCRIPT) {
      client.input(at, action, kind);
      const now = startedAt + Math.ceil((at * 1000) / 60); // the input arrives just after it was made
      clock.advance(now - clock.now());
      input(session, p0, at, action, kind);
    }
    expect(p0.peer.of("error")).toEqual([]);
    expect(SCRIPT.filter(([at]) => (at * 256) % 1 !== 0).length).toBeGreaterThan(20);
    expect(client.lockDelay, "inputs during lock delay").toBeGreaterThanOrEqual(2);

    const server = session.game(0)!;
    expect(server.stats.pieces).toBe(client.game.stats.pieces);
    expect(server.stats.lines).toBe(client.game.stats.lines);
    expect(state(server)).toEqual(state(client.game));
    expect(server.stats.pieces).toBeGreaterThanOrEqual(4);
    // the opponent is told the grid frame each input landed on, the same as the client's
    expect(p1.peer.of("opponentInput").map((m) => (m.d as { frame: number }).frame)).toEqual(client.landed);
  });

  it("give the client the same game however its display ticks", () => {
    const a = new Client(SEED);
    const b = new Client(SEED, [0.37, 3.1, 0.999, 1.5]);
    for (const [at, action, kind] of SCRIPT) {
      a.input(at, action, kind);
      b.input(at, action, kind);
    }
    expect(state(b.game)).toEqual(state(a.game));
    expect(b.landed).toEqual(a.landed);
  });
});
