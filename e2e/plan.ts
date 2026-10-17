// Plans a scripted run offline: the same engine and bot the game ships, driven on the same
// timeline the browser will see under Playwright's fake clock, so the browser run and this
// Node run make identical moves and reach identical results.
import { Bot, BotProfile } from "../src/ai/bot";
import { Action, Game } from "../src/engine/game";
import { stepToClock } from "../src/engine/stepping";
import { ModeId, modeById } from "../src/modes";
import { defaultSettings } from "../src/settings";

// Playwright's fake requestAnimationFrame fires on every multiple of 16 ms of fake time.
export const FRAME_MS = 16;
// app.ts: the countdown lasts START_AT seconds before the game starts advancing.
const START_AT = 1.5;
// The bot's own placement search, without soft-drop spin finishes (those have no single key).
const PLANNER: BotProfile = { name: "E2E", pps: 0, noise: 0, spins: false };

type Move = Parameters<Game["forceAction"]>[0];
type KeyMove = Exclude<Move, "softdrop-to-floor">; // every one of these is also a key Action

export interface Step {
  at: number; // fake-clock ms; never a multiple of FRAME_MS, so it can't tie with a frame
  codes: string[]; // KeyboardEvent.code values, each pressed and released in order
}

export interface Plan {
  steps: Step[];
  over: boolean;
  result: "clear" | "topout" | null;
  lines: number;
  pieces: number;
  score: number;
  frames: number;
}

/**
 * Mirror of App's session timing (app.ts `tickSession`, `startPlay`, `advanceTo`, key handlers),
 * with the same arithmetic so the game sees the same sequence of `advance()` calls.
 */
class Session {
  readonly game: Game;
  private t = 0;
  private started = false;
  private last: number;
  private nextFrame: number;
  private clock = 0; // the player rests on whole frames between inputs (stepping.ts)

  constructor(modeId: ModeId, seed: number, startedAt: number) {
    this.game = new Game(modeById(modeId).options(seed), defaultSettings().handling);
    this.last = startedAt;
    this.nextFrame = (Math.floor(startedAt / FRAME_MS) + 1) * FRAME_MS;
  }

  /** Run every animation frame before `at`, then catch up to `at` as the first keydown there does. */
  runTo(at: number): void {
    for (; this.nextFrame < at; this.nextFrame += FRAME_MS) this.tick(this.nextFrame);
    if (this.started) this.advanceTo(at, true);
  }

  private tick(now: number): void {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.t += dt;
    if (!this.started) {
      this.last = now;
      if (this.t >= START_AT) this.started = true;
      return;
    }
    this.advanceTo(now);
  }

  private advanceTo(now: number, input = false): void {
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.game.over) return;
    this.clock += dt * 60;
    stepToClock(this.game, this.clock, input);
  }

  /** A key press and release at `now`, as App's keydown/keyup handlers apply them. */
  key(now: number, action: Action): void {
    if (!this.started) throw new Error("key before the countdown ended");
    if (!this.game.over) {
      this.advanceTo(now, true);
      this.game.press(action);
    }
    this.advanceTo(now, true);
    this.game.release(action);
  }
}

/** The bot's placement for the current piece, as the list of actions it performs. */
function placement(game: Game): KeyMove[] {
  const sim = game.clone();
  const moves: Move[] = [];
  // Clones made during the bot's search inherit this override; only record the real moves.
  sim.forceAction = function (this: Game, m: Move) {
    if (this === sim) moves.push(m);
    return Game.prototype.forceAction.call(this, m);
  };
  new Bot(sim, PLANNER).playPiece();
  return moves.map((m) => {
    if (m === "softdrop-to-floor") throw new Error("planner used a soft-drop finish");
    return m;
  });
}

/**
 * Click the mode at `startedAt`, then one placement every `gapMs` from the end of the countdown
 * until the game ends. Every placement is checked against the bot's own simulation.
 */
export function planRun(modeId: ModeId, seed: number, startedAt: number, gapMs: number): Plan {
  if (gapMs % FRAME_MS !== 0) throw new Error("gapMs must be a whole number of frames");
  const keys = defaultSettings().keys;
  const session = new Session(modeId, seed, startedAt);
  const game = session.game;
  const steps: Step[] = [];
  let at = (Math.ceil((startedAt + START_AT * 1000) / FRAME_MS) + 1) * FRAME_MS + FRAME_MS / 2;
  while (steps.length < 5000) {
    session.runTo(at);
    if (game.over) break;
    const actions = placement(game);
    const expected = game.clone();
    for (const a of actions) expected.forceAction(a);
    for (const a of actions) session.key(at, a);
    if (JSON.stringify(game.board) !== JSON.stringify(expected.board) || game.stats.score !== expected.stats.score) {
      throw new Error(`keys for step ${steps.length} did not reproduce the bot's placement`);
    }
    steps.push({ at, codes: actions.map((a) => keys[a][0]) });
    at += gapMs;
  }
  return {
    steps, over: game.over, result: game.result,
    lines: game.stats.lines, pieces: game.stats.pieces, score: game.stats.score, frames: game.frame,
  };
}
