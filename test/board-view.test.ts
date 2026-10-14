import { describe, expect, it } from "vitest";
import { Cell } from "../src/engine/constants";
import { Game } from "../src/engine/game";
import { BoardView, COLORS } from "../src/render/renderer";

/** Fill the bottom of the board from strings, top line first. '#' = garbage, '.' = empty. */
function setBottom(game: Game, rows: string[]): void {
  const start = game.board.length - rows.length;
  rows.forEach((line, i) => {
    game.board[start + i] = [...line].map((ch) => (ch === "#" ? "g" : null)) as Cell[];
  });
}

function view(game: Game, bounciness = 1, reduceMotion = false): BoardView {
  const v = new BoardView(game, { accent: "#fff", mode: "zen" });
  v.bounciness = bounciness;
  v.reduceMotion = reduceMotion;
  return v;
}

/** A vertical I dropped into the left column clears the bottom row: a plain single. */
function single(v: BoardView): void {
  const g = v.game;
  g.piece.type = "i";
  g.piece.r = 1;
  g.piece.x = -1;
  setBottom(g, [".#########"]);
  g.press("hard");
  expect(g.stats.lines).toBe(1);
  v.update(1 / 60);
}

/** T-spin double, as in engine.test.ts. */
function tspinDouble(v: BoardView): void {
  const g = v.game;
  g.piece.type = "t";
  setBottom(g, [
    "...#......",
    "###...####",
    "####.#####",
  ]);
  g.piece.r = 1;
  g.piece.x = 4;
  g.piece.y = 38 - 0.04;
  g.piece.hy = 38;
  g.press("cw");
  g.press("hard");
  expect(g.stats.clears["SPIN DOUBLE"]).toBe(1);
  v.update(1 / 60);
}

describe("BoardView physics", () => {
  it("shatters cleared cells into fragments coloured like the cells", () => {
    const v = view(new Game({ seed: 1, g: 0 }));
    single(v);
    expect(v.fragments.length).toBeGreaterThan(0);
    const colours = new Set(v.fragments.map((f) => f.color));
    expect(colours).toEqual(new Set([COLORS.g, COLORS.i]));
    // fragments fall under gravity and fade out
    const vy0 = v.fragments.map((f) => f.vy);
    for (let i = 0; i < 10; i++) v.update(1 / 60);
    expect(v.fragments.every((f, i) => f.vy > vy0[i])).toBe(true);
    for (let i = 0; i < 120; i++) v.update(1 / 60);
    expect(v.fragments.length).toBe(0);
  });

  it("spawns no fragments at bounciness 0", () => {
    const v = view(new Game({ seed: 1, g: 0 }), 0);
    single(v);
    expect(v.fragments.length).toBe(0);
    expect(v.squash.s).toBe(0);
    expect(v.spring).toEqual({ x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 });
  });

  it("spawns no fragments, shockwave or movement with reduced motion", () => {
    const v = view(new Game({ seed: 1, g: 0 }), 1, true);
    tspinDouble(v);
    expect(v.fragments.length).toBe(0);
    expect(v.shockwaves.length).toBe(0);
    expect(v.squash.s).toBe(0);
    expect(v.spring).toEqual({ x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 });
    expect(v.flashes.length).toBe(1); // static feedback stays
    expect(v.texts.length).toBeGreaterThan(0);
  });

  it("sends a shockwave on a spin or B2B clear but not a plain single", () => {
    const plain = view(new Game({ seed: 1, g: 0 }));
    single(plain);
    expect(plain.shockwaves.length).toBe(0);

    const spin = view(new Game({ seed: 1, g: 0 }));
    tspinDouble(spin);
    expect(spin.shockwaves.length).toBe(1);

    // B2B: two quads in a row, the second has btb 2
    const b2b = view(new Game({ seed: 1, g: 0 }));
    for (let i = 0; i < 2; i++) {
      const g = b2b.game;
      g.piece.type = "i";
      g.piece.r = 1;
      g.piece.x = -1;
      setBottom(g, Array(4).fill(".#########"));
      g.press("hard");
      expect(g.stats.lines).toBe(4 * (i + 1));
      b2b.update(1 / 60);
      expect(b2b.shockwaves.length).toBe(i);
    }
    expect(b2b.game.stats.btb).toBe(2);
  });

  it("squashes and stretches on hard drop", () => {
    const v = view(new Game({ seed: 1, g: 0 }));
    v.game.press("hard");
    v.update(1 / 60);
    expect(v.squash.s).toBeGreaterThan(0); // stretch first
    let min = 0;
    for (let i = 0; i < 30; i++) {
      v.update(1 / 60);
      min = Math.min(min, v.squash.s);
    }
    expect(min).toBeLessThan(0); // then squash
  });

  it("recoils sideways when garbage arrives", () => {
    const v = view(new Game({ seed: 1, g: 0, hasgarbage: true }));
    v.game.receive(3);
    v.update(1 / 60);
    expect(Math.abs(v.spring.x)).toBeGreaterThan(0);
    expect(v.spring.y).toBe(0);

    const still = view(new Game({ seed: 1, g: 0, hasgarbage: true }), 0);
    still.game.receive(3);
    still.update(1 / 60);
    expect(still.spring.x).toBe(0);
  });

  it("beats only when danger is high", () => {
    const v = view(new Game({ seed: 1, g: 0 }));
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      v.update(1 / 60);
      peak = Math.max(peak, Math.abs(v.heartbeat));
    }
    expect(peak).toBe(0);
    setBottom(v.game, Array(19).fill("#########."));
    for (let i = 0; i < 90; i++) {
      v.update(1 / 60);
      peak = Math.max(peak, v.heartbeat);
    }
    expect(v.danger).toBeGreaterThan(0.5);
    expect(peak).toBeGreaterThan(0);
  });
});
