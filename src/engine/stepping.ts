// Canonical stepping: where a game may stop between `advance` calls. Every client mode, the bot,
// the replay player and the match server step through here, so the same inputs give the same game.
//
// Game.advance takes its steps between whole frames and the points where it was asked to stop, and
// lock delay, gravity and DAS resolve at the end of each step, so stopping mid-frame changes the
// run. A game therefore rests only on whole frames and at its inputs, which sit on a 1/256-frame
// grid so the frame arithmetic is exact. Two games that stop at the same points take the same
// steps, however the calls bringing them there are chunked.
import { Game } from "./game";

export const SUBFRAMES = 256;

/**
 * Where a game may rest, given a clock in frames: the last whole frame between inputs, or the
 * 1/256-frame grid point at an input.
 */
export function restFrame(clock: number, input: boolean): number {
  return input ? Math.floor(clock * SUBFRAMES) / SUBFRAMES : Math.floor(clock);
}

/**
 * Advance `game` to `frame` if it is behind it. `advance` splits its steps at every whole frame
 * on the way, so `frame` must be a rest point (see `restFrame`) for the result to be canonical.
 */
export function stepTo(game: Game, frame: number): void {
  if (frame > game.frame) game.advance(frame - game.frame);
}

/**
 * Bring `game` to where it rests at `clock`: the whole frame before it, and for an input
 * (`input`) on to the grid point the input lands on.
 */
export function stepToClock(game: Game, clock: number, input = false): void {
  stepTo(game, restFrame(clock, false));
  if (input) stepTo(game, restFrame(clock, true));
}
