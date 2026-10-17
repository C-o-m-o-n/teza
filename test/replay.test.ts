import { describe, expect, it, vi } from "vitest";
import { Bot, BotProfile } from "../src/ai/bot";
import { Action, Game, Handling } from "../src/engine/game";
import { Recorder, Replay, ReplayInput, ReplayPlayer, parseReplay, restFrame, stepTo } from "../src/engine/replay";
import { modeById } from "../src/modes";

const SEED = 4242;
const HANDLING: Handling = { das: 8.3, arr: 1.7, dcd: 1.2, sdf: 23, irs: true, ihs: true };
const TICK = 1.0371; // frames per animation frame: off the whole-frame grid, like a real display
const PLANNER: BotProfile = { name: "TEST", pps: 0, noise: 0, spins: false };

/** Drives a recorded 40 LINES game the way App does: animation-frame ticks, inputs on the clock. */
class Driver {
  readonly game = new Game(modeById("40l").options(SEED), HANDLING);
  readonly rec = new Recorder(this.game);
  private clock = 0;

  constructor() {
    this.game.trackFinesse = true;
  }

  wait(frames: number): void {
    const end = this.clock + frames;
    while (this.clock < end && !this.game.over) {
      this.clock = Math.min(end, this.clock + TICK);
      stepTo(this.game, restFrame(this.clock, false));
    }
  }

  input(input: ReplayInput): void {
    stepTo(this.game, restFrame(this.clock, true));
    this.rec.apply(input);
  }

  tap(action: Action, gap = 0.37): void {
    this.input({ type: "press", action });
    this.wait(gap);
    this.input({ type: "release", action });
  }

  hold(action: Action, frames: number): void {
    this.input({ type: "press", action });
    this.wait(frames);
    this.input({ type: "release", action });
  }
}

/** The bot's placement for the current piece, as key actions. */
function placement(game: Game): Action[] {
  const sim = game.clone();
  const moves: Action[] = [];
  sim.forceAction = function (this: Game, m) {
    if (this === sim) moves.push(m === "softdrop-to-floor" ? "soft" : m);
    return Game.prototype.forceAction.call(this, m);
  };
  new Bot(sim, { ...PLANNER }).playPiece();
  return moves.filter((m) => m !== "soft");
}

/** A full 40 LINES clear by key inputs: DAS holds, soft drop, rotations, hold, hard drops, a releaseAll. */
function recordClear(): Driver {
  const d = new Driver();
  for (let piece = 0; piece < 400 && !d.game.over; piece++) {
    d.wait(2.29 + (piece % 4) * 0.61);
    if (piece % 3 === 0) d.hold("soft", 4.6);
    if (piece % 5 === 1) d.hold(piece % 2 ? "left" : "right", 14.2); // past DAS, into ARR
    if (piece % 7 === 2) d.tap("hold");
    if (piece % 11 === 3) {
      d.input({ type: "press", action: "right" });
      d.wait(3.3);
      d.input({ type: "releaseAll" });
    }
    if (piece === 6) d.tap("180");
    for (const a of placement(d.game)) {
      d.tap(a);
      d.wait(0.53);
    }
  }
  return d;
}

function snapshot(g: Game) {
  return { frame: g.frame, stats: g.stats, board: g.board, result: g.result, over: g.over };
}

describe("replay", () => {
  const run = recordClear();
  const replay = run.rec.replay();

  it("records a full 40 LINES clear with every kind of input", () => {
    expect(run.game.result).toBe("clear");
    expect(run.game.stats.lines).toBeGreaterThanOrEqual(40);
    expect(replay.seed).toBe(SEED);
    expect(replay.handling).toEqual(HANDLING);
    expect(replay.frames).toBe(run.game.frame);
    const kinds = new Set(replay.events.map((e) => (e.type === "releaseAll" ? e.type : `${e.type}:${e.action}`)));
    for (const k of ["press:left", "press:right", "press:soft", "press:cw", "press:ccw", "press:180", "press:hold", "press:hard", "release:left", "releaseAll"]) {
      expect(kinds, k).toContain(k);
    }
    expect(replay.events.some((e) => e.frame % 1 !== 0), "fractional event frames").toBe(true);
  });

  it("reproduces the run exactly, through JSON", () => {
    const stored = parseReplay(JSON.stringify(replay), run.game.frame)!;
    expect(stored).toEqual(replay);
    const p = new ReplayPlayer(stored);
    p.advanceTo(stored.frames);
    expect(snapshot(p.game)).toEqual(snapshot(run.game));
    expect(p.game.frame).toBe(run.game.frame);
  });

  it("reproduces a top-out", () => {
    const d = new Driver();
    for (let i = 0; i < 200 && !d.game.over; i++) {
      d.wait(1.7 + (i % 3) * 0.45);
      d.tap(i % 2 ? "cw" : "hard", 0.2);
      d.tap("hard");
    }
    expect(d.game.result).toBe("topout");
    const p = new ReplayPlayer(d.rec.replay());
    p.advanceTo(d.game.frame);
    expect(snapshot(p.game)).toEqual(snapshot(d.game));
  });

  it("applies each event exactly once however it is stepped", () => {
    const p = new ReplayPlayer(replay);
    const calls = [vi.spyOn(p.game, "press"), vi.spyOn(p.game, "release"), vi.spyOn(p.game, "releaseAll")];
    for (let f = 0; f < replay.frames + 30; f += 0.37) {
      p.advanceTo(f);
      p.advanceTo(f); // repeating a frame applies nothing new
    }
    p.advanceTo(replay.frames + 30);
    expect(calls.reduce((n, c) => n + c.mock.calls.length, 0)).toBe(replay.events.length);
    expect(snapshot(p.game)).toEqual(snapshot(run.game));
  });

  it("ends in the same state from many small steps as from one large step", () => {
    const target = Math.floor(replay.frames / 2) + 0.75;
    const small = new ReplayPlayer(replay);
    for (let f = 0; f < target; f += 0.13) small.advanceTo(f);
    small.advanceTo(target);
    const big = new ReplayPlayer(replay);
    big.advanceTo(target);
    expect(snapshot(small.game)).toEqual(snapshot(big.game));
    expect(small.game.piece).toEqual(big.game.piece);
    expect(small.game.queue).toEqual(big.game.queue);
    // a whole frame is reached exactly
    const whole = new ReplayPlayer(replay);
    for (let f = 0; f <= 600; f += 0.29) whole.advanceTo(f);
    whole.advanceTo(600);
    expect(whole.game.frame).toBe(600);
  });
});

describe("parseReplay", () => {
  const valid: Replay = {
    seed: 7, handling: { das: 10, arr: 2, dcd: 2, sdf: 6, irs: true, ihs: false }, frames: 3600.5,
    events: [{ type: "press", action: "left", frame: 0 }, { type: "release", action: "left", frame: 12.25 }, { type: "releaseAll", frame: 12.25 }],
  };
  const json = (r: unknown) => JSON.stringify(r);

  it("accepts a stored replay of the PB", () => {
    expect(parseReplay(json(valid), 3600.5)).toEqual(valid);
  });

  it("rejects a missing key, no PB and malformed JSON", () => {
    expect(parseReplay(null, 3600.5)).toBeNull();
    expect(parseReplay(json(valid), undefined)).toBeNull();
    expect(parseReplay("{not json", 3600.5)).toBeNull();
    expect(parseReplay(json(valid).slice(0, -3), 3600.5)).toBeNull();
  });

  it("rejects the wrong shape", () => {
    const bad: unknown[] = [
      42, "str", [], null,
      { ...valid, seed: "7" },
      { ...valid, seed: 0 },
      { ...valid, seed: 1.5 },
      { ...valid, handling: undefined },
      { ...valid, handling: { ...valid.handling, irs: "yes" } },
      { ...valid, handling: { das: 10, arr: 2, dcd: 2, irs: true, ihs: true } },
      { ...valid, frames: "3600.5" },
      { ...valid, events: "none" },
      { ...valid, events: [{ type: "press", action: "jump", frame: 1 }] },
      { ...valid, events: [{ type: "tap", action: "left", frame: 1 }] },
      { ...valid, events: [{ type: "press", action: "left" }] },
      { ...valid, events: [{ type: "press", action: "left", frame: -1 }] },
      { ...valid, events: [{ type: "releaseAll", frame: 5 }, { type: "releaseAll", frame: 4 }] },
      { ...valid, events: [null] },
    ];
    for (const r of bad) expect(parseReplay(json(r), 3600.5), json(r)).toBeNull();
  });

  it("rejects a replay whose frames differ from the PB", () => {
    expect(parseReplay(json(valid), 3600)).toBeNull();
    expect(parseReplay(json({ ...valid, frames: 3599 }), 3600.5)).toBeNull();
  });
});
