import { afterEach, describe, expect, it, vi } from "vitest";
import { PieceType } from "../src/engine/constants";
import { minInputs } from "../src/engine/finesse";
import { Action, DEFAULT_HANDLING, Game, Handling } from "../src/engine/game";
import { loadSettings } from "../src/settings";

/** A fresh game tracking finesse, whose current piece is `type` at its spawn. */
function gameWith(type: PieceType, allow180 = true, handling: Handling = DEFAULT_HANDLING): Game {
  const g = new Game({ seed: 1, allow180 }, handling);
  g.trackFinesse = true;
  g.piece.type = type;
  return g;
}

function tap(g: Game, action: Action): void {
  g.press(action);
  g.release(action);
}

function columns(g: Game): number[] {
  const p = g.piece;
  return [...new Set(g.cellsOf(p.type, p.x, p.y, p.r).map(([x]) => x))].sort((a, b) => a - b);
}

describe("finesse minimum (empty-board BFS)", () => {
  it("knows the classic cases", () => {
    const o = (x: number) => [[x, 38], [x + 1, 38], [x, 39], [x + 1, 39]] as [number, number][];
    expect(minInputs("o", o(4), true)).toBe(0); // spawn column
    expect(minInputs("o", o(0), true)).toBe(1); // slide to the left wall
    expect(minInputs("o", o(1), true)).toBe(2); // slide, tap back
    expect(minInputs("o", o(3), true)).toBe(1); // one tap
    // a T flat-side-up is one 180 when allowed, two rotations when not
    const t180 = [[3, 38], [4, 38], [5, 38], [4, 39]] as [number, number][];
    expect(minInputs("t", t180, true)).toBe(1);
    expect(minInputs("t", t180, false)).toBe(2);
  });

  it("matches symmetric orientations by cells, not rotation", () => {
    // I vertical: rotation 1 and rotation 3 at different x can cover the same column
    const col = (x: number) => [[x, 36], [x, 37], [x, 38], [x, 39]] as [number, number][];
    expect(minInputs("i", col(5), true)).toBe(1); // cw from spawn lands in column 5
    expect(minInputs("i", col(4), true)).toBe(1); // ccw from spawn lands in column 4
  });
});

describe("finesse faults", () => {
  it("O to the left wall with one DAS slide is 0 faults", () => {
    const g = gameWith("o");
    g.press("left");
    g.advance(30); // DAS 10 + ARR 2: well past the wall
    g.release("left");
    expect(columns(g)).toEqual([0, 1]);
    g.press("hard");
    expect(g.stats.pieces).toBe(1);
    expect(g.stats.finesse).toBe(0);
  });

  it("O moved 3 columns with 3 taps is 1 fault (minimum 2: slide left, tap right)", () => {
    const g = gameWith("o");
    tap(g, "left");
    tap(g, "left");
    tap(g, "left");
    expect(columns(g)).toEqual([1, 2]);
    g.press("hard");
    expect(g.stats.finesse).toBe(3 - 2);
  });

  it("T: cw twice to the 180 position is 1 fault when 180 is allowed; one 180 press is 0", () => {
    const twice = gameWith("t");
    tap(twice, "cw");
    tap(twice, "cw");
    expect(twice.piece.r).toBe(2);
    twice.press("hard");
    expect(twice.stats.finesse).toBe(1);

    const once = gameWith("t");
    tap(once, "180");
    expect(once.piece.r).toBe(2);
    once.press("hard");
    expect(once.stats.finesse).toBe(0);

    const no180 = gameWith("t", false);
    tap(no180, "cw");
    tap(no180, "cw");
    no180.press("hard");
    expect(no180.stats.finesse).toBe(0); // two rotations is the minimum without 180
  });

  it("a pure hard drop is 0 faults, and nothing is counted without trackFinesse", () => {
    const g = gameWith("t");
    g.press("hard");
    expect(g.stats.finesse).toBe(0);

    const off = gameWith("o");
    off.trackFinesse = false;
    for (let i = 0; i < 5; i++) tap(off, "left");
    off.press("hard");
    expect(off.stats.pieces).toBe(1);
    expect(off.stats.finesse).toBe(0);
  });

  it("does not count soft drop, hard drop or hold, and resets per piece", () => {
    const g = gameWith("o");
    tap(g, "soft");
    tap(g, "left");
    tap(g, "right"); // 2 inputs for a spawn-column drop: 2 faults
    g.press("hard");
    expect(g.stats.finesse).toBe(2);
    g.release("hard");
    g.press("hard"); // next piece, no inputs
    expect(g.stats.finesse).toBe(2);
  });

  it("measures a held piece from its own spawn", () => {
    const g = gameWith("o");
    tap(g, "left");
    tap(g, "hold"); // the taps before the hold don't count against the swapped-in piece
    g.press("hard");
    expect(g.stats.finesse).toBe(0);
  });
});

describe("IRS and IHS", () => {
  const h = (irs: boolean, ihs: boolean): Handling => ({ ...DEFAULT_HANDLING, irs, ihs });

  it("defaults both on", () => {
    expect(DEFAULT_HANDLING.irs).toBe(true);
    expect(DEFAULT_HANDLING.ihs).toBe(true);
  });

  it("IRS: cw held across a lock spawns the next piece in rotation 1, without an input", () => {
    const g = new Game({ seed: 1 }, h(true, true));
    g.press("cw");
    g.press("hard");
    expect(g.stats.pieces).toBe(1);
    expect(g.piece.r).toBe(1);
    expect(g.stats.inputs).toBe(2); // cw and hard; the IRS adds nothing

    const off = new Game({ seed: 1 }, h(false, true));
    off.press("cw");
    off.press("hard");
    expect(off.piece.r).toBe(0);
    expect(off.stats.inputs).toBe(2);
  });

  it("IRS uses the most recent rotate key still held", () => {
    const g = new Game({ seed: 1 }, h(true, true));
    g.press("cw");
    g.press("ccw");
    g.press("hard");
    expect(g.piece.r).toBe(3);
    g.release("hard");
    g.release("ccw"); // cw is still down
    g.press("hard");
    expect(g.piece.r).toBe(1);
  });

  it("IRS ignores a held 180 when 180 is not allowed, and a released key", () => {
    const g = new Game({ seed: 1, allow180: false }, h(true, true));
    g.press("180");
    g.press("hard");
    expect(g.stats.pieces).toBe(1);
    expect(g.piece.r).toBe(0);

    const released = new Game({ seed: 1 }, h(true, true));
    released.press("cw");
    released.release("cw");
    released.press("hard");
    expect(released.piece.r).toBe(0);

    const all = new Game({ seed: 1 }, h(true, true));
    all.press("cw");
    all.releaseAll();
    all.press("hard");
    expect(all.piece.r).toBe(0);
  });

  it("IHS: hold held across a lock holds the piece that spawned", () => {
    const g = new Game({ seed: 1 }, h(true, true));
    const [spawned, after] = g.queue;
    g.holdLocked = true; // so pressing hold only marks the key as held
    g.press("hold");
    expect(g.hold).toBeNull();
    g.press("hard");
    expect(g.piece.type).toBe(after);
    expect(g.hold).toBe(spawned);
    expect(g.stats.holds).toBe(1); // one initial hold, no chained second hold
    expect(g.holdLocked).toBe(true);
    expect(g.stats.inputs).toBe(2);

    const off = new Game({ seed: 1 }, h(true, false));
    off.holdLocked = true;
    off.press("hold");
    off.press("hard");
    expect(off.piece.type).toBe(spawned);
    expect(off.hold).toBeNull();
    expect(off.stats.holds).toBe(0);
  });

  it("IHS then IRS rotates the swapped-in piece", () => {
    const g = new Game({ seed: 1 }, h(true, true));
    const after = g.queue[1];
    g.holdLocked = true;
    g.press("hold");
    g.press("cw");
    g.press("hard");
    expect(g.piece.type).toBe(after);
    expect(g.piece.r).toBe(1);
  });

  it("does not apply to the first piece or to a wipe", () => {
    const g = new Game({ seed: 1 }, h(true, true));
    g.press("cw");
    g.release("cw");
    g.press("180"); // held, but a wipe is not a lock
    g.wipe();
    expect(g.piece.r).toBe(0);
  });
});

describe("loadSettings handling fields", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives an old save without irs/ihs both on", () => {
    const saved = JSON.stringify({ handling: { das: 8, arr: 0, dcd: 1, sdf: 41 } });
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: () => {} });
    const s = loadSettings();
    expect(s.handling).toEqual({ das: 8, arr: 0, dcd: 1, sdf: 41, irs: true, ihs: true });
  });

  it("keeps saved irs/ihs values", () => {
    const saved = JSON.stringify({ handling: { irs: false, ihs: false } });
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: () => {} });
    expect(loadSettings().handling).toMatchObject({ irs: false, ihs: false });
  });
});
