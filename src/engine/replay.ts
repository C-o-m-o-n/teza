// Recorded 40 LINES runs: the seed, the handling in effect and every input at the frame it landed,
// enough to rebuild the run exactly (the PB ghost). No DOM.
//
// A recorded game rests only on whole frames and at its inputs, on the 1/256-frame grid
// (stepping.ts). A replay stops at the same points and so takes the same steps.
import { modeById } from "../modes";
import { Action, Game, Handling } from "./game";
import { stepTo } from "./stepping";

export type ReplayInput =
  | { type: "press"; action: Action }
  | { type: "release"; action: Action }
  | { type: "releaseAll" };

/** An input and the game's `frame` when it was applied. */
export type ReplayEvent = ReplayInput & { frame: number };

export interface Replay {
  seed: number;
  handling: Handling;
  frames: number; // game.frame at the end of the run
  events: ReplayEvent[];
}

const ACTIONS: readonly Action[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];
function apply(game: Game, input: ReplayInput): void {
  if (input.type === "press") game.press(input.action);
  else if (input.type === "release") game.release(input.action);
  else game.releaseAll();
}

/** Applies inputs to a game and records each one at the game's frame. */
export class Recorder {
  readonly events: ReplayEvent[] = [];

  constructor(readonly game: Game) {}

  apply(input: ReplayInput): void {
    if (!this.game.over) this.events.push({ ...input, frame: this.game.frame });
    apply(this.game, input);
  }

  replay(): Replay {
    const g = this.game;
    return { seed: g.opts.seed, handling: { ...g.handling }, frames: g.frame, events: this.events.slice() };
  }
}

/** Rebuilds a recorded 40 LINES run on a fresh game, with the replay's seed and handling. */
export class ReplayPlayer {
  readonly game: Game;
  private next = 0;

  constructor(readonly replay: Replay) {
    this.game = new Game(modeById("40l").options(replay.seed), replay.handling);
    this.game.trackFinesse = true; // the recorded game counted finesse, so its stats did too
  }

  /**
   * Apply every event due by `frame` at its recorded frame, in order, and advance to `frame`. Like
   * the recorded game it stops only on whole frames and event frames, so any sequence of calls
   * gives the same state; for a fractional `frame` that is the last such point before it.
   */
  advanceTo(frame: number): void {
    const g = this.game;
    const events = this.replay.events;
    while (this.next < events.length && events[this.next].frame <= frame) {
      const e = events[this.next++];
      stepTo(g, e.frame);
      apply(g, e);
    }
    stepTo(g, Math.floor(frame));
  }
}

function isHandling(h: unknown): h is Handling {
  if (typeof h !== "object" || h === null) return false;
  const o = h as Record<string, unknown>;
  return ["das", "arr", "dcd", "sdf"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= 0)
    && typeof o.irs === "boolean" && typeof o.ihs === "boolean";
}

function isEvent(e: unknown): e is ReplayEvent {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.frame !== "number" || !Number.isFinite(o.frame) || o.frame < 0) return false;
  if (o.type === "releaseAll") return true;
  return (o.type === "press" || o.type === "release") && ACTIONS.includes(o.action as Action);
}

/**
 * The stored replay if it is one, and is the run of the current PB (`pbFrames`): a PB from another
 * device or from a build without recordings has no replay to race. Null otherwise.
 */
export function parseReplay(raw: string | null, pbFrames: number | undefined): Replay | null {
  if (!raw || pbFrames === undefined) return null;
  let r: unknown;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (!Number.isInteger(o.seed) || (o.seed as number) < 1 || (o.seed as number) > 2147483646) return null;
  if (!isHandling(o.handling) || typeof o.frames !== "number" || !Array.isArray(o.events)) return null;
  if (!o.events.every(isEvent)) return null;
  const events = o.events as ReplayEvent[];
  if (events.some((e, i) => i > 0 && e.frame < events[i - 1].frame)) return null;
  if (o.frames !== pbFrames) return null;
  return { seed: o.seed as number, handling: o.handling, frames: o.frames, events };
}
