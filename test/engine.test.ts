import { describe, expect, it } from "vitest";
import { BOARD_W, Cell, PIECES } from "../src/engine/constants";
import { Game, rawAttack } from "../src/engine/game";
import { Rng } from "../src/engine/rng";

/** Fill the bottom of the board from strings, top line first. '#' = garbage, '.' = empty. */
function setBottom(game: Game, rows: string[]): void {
  const start = game.board.length - rows.length;
  rows.forEach((line, i) => {
    game.board[start + i] = [...line].map((ch) => (ch === "#" ? "g" : null)) as Cell[];
  });
}

function placeAt(game: Game, x: number, row: number): void {
  // y such that ceil(y) === row, like a naturally-falling piece
  game.piece.x = x;
  game.piece.y = row - 0.04;
  game.piece.hy = row;
}

describe("rng & bag", () => {
  it("matches the Park–Miller sequence", () => {
    const r = new Rng(1);
    expect([r.next(), r.next(), r.next()]).toEqual([16807, 282475249, 1622650073]);
  });

  it("deals every piece once per bag, deterministically by seed", () => {
    const a = new Game({ seed: 12345, nextcount: 14 });
    const b = new Game({ seed: 12345, nextcount: 14 });
    const seqA = [a.piece.type, ...a.queue.slice(0, 13)];
    const seqB = [b.piece.type, ...b.queue.slice(0, 13)];
    expect(seqA).toEqual(seqB);
    expect([...seqA.slice(0, 7)].sort()).toEqual([...PIECES].sort());
    expect([...seqA.slice(7, 14)].sort()).toEqual([...PIECES].sort());
  });
});

describe("spawn, gravity, locking", () => {
  it("spawns just above the visible field, left-centre", () => {
    const g = new Game();
    const cells = g.cellsOf(g.piece.type, g.piece.x, g.piece.y, g.piece.r);
    // bottom of every piece sits two rows above the visible field (row 20)
    expect(Math.max(...cells.map(([, y]) => y))).toBe(18);
    expect(g.piece.x).toBe(4);
  });

  it("falls one row every 50 frames at g=0.02", () => {
    const g = new Game();
    const row0 = Math.ceil(g.piece.y);
    g.advance(49.5);
    expect(Math.ceil(g.piece.y)).toBe(row0 + 1); // fractional y crosses a row boundary immediately after spawn offset
    g.advance(50);
    expect(Math.ceil(g.piece.y)).toBe(row0 + 2);
  });

  it("locks after 30 frames resting on the floor", () => {
    const g = new Game({ g: 0.02 });
    g.forceAction("softdrop-to-floor");
    const pieces = g.stats.pieces;
    g.advance(30);
    expect(g.stats.pieces).toBe(pieces);
    g.advance(1.5);
    expect(g.stats.pieces).toBe(pieces + 1);
  });
});

describe("handling", () => {
  it("DAS 10 / ARR 2: tap, then auto-repeat every 2 frames", () => {
    const g = new Game({ g: 0 }, { das: 10, arr: 2, dcd: 0, sdf: 6, irs: true, ihs: true });
    const x0 = g.piece.x;
    g.press("left");
    expect(g.piece.x).toBe(x0 - 1);
    g.advance(9);
    expect(g.piece.x).toBe(x0 - 1);
    g.advance(1);
    expect(g.piece.x).toBe(x0 - 2);
    g.advance(2);
    expect(g.piece.x).toBe(x0 - 3);
  });

  it("ARR 0 teleports to the wall once DAS charges", () => {
    const g = new Game({ g: 0 }, { das: 8, arr: 0, dcd: 0, sdf: 6, irs: true, ihs: true });
    g.press("right");
    g.advance(8);
    const cells = g.cellsOf(g.piece.type, g.piece.x, g.piece.y, g.piece.r);
    expect(Math.max(...cells.map(([x]) => x))).toBe(BOARD_W - 1);
  });

  it("latest direction wins and falls back to the still-held key", () => {
    const g = new Game({ g: 0 }, { das: 10, arr: 2, dcd: 0, sdf: 6, irs: true, ihs: true });
    const x0 = g.piece.x;
    g.press("left");
    g.press("right");
    expect(g.piece.x).toBe(x0);
    g.release("right");
    g.advance(10); // left has been charging the whole time? no — it only charges while active
    expect(g.piece.x).toBeLessThan(x0);
  });
});

describe("spins & kicks", () => {
  it("detects a T-spin double rotated into a slot", () => {
    const g = new Game({ seed: 1, g: 0 });
    // force the current piece to be a T
    g.piece.type = "t";
    setBottom(g, [
      "...#......",
      "###...####",
      "####.#####",
    ]);
    g.piece.r = 1;
    placeAt(g, 4, 38);
    expect(g.isLegal("t", 4, g.piece.y, 1)).toBe(true);
    const events: string[] = [];
    let attack = -1;
    g.on((e) => {
      events.push(e.type);
      if (e.type === "clear") attack = e.info.attack;
    });
    g.press("cw");
    expect(g.piece.r).toBe(2);
    expect(g.piece.spin).toBe("normal");
    g.press("hard");
    expect(g.stats.lines).toBe(2);
    expect(g.stats.clears["SPIN DOUBLE"]).toBe(1);
    expect(attack).toBe(4);
  });

  it("uses the SRS+ I kicks off the floor", () => {
    const g = new Game({ g: 0 });
    g.piece.type = "i";
    g.forceAction("softdrop-to-floor");
    // vertical I at the right wall must kick to rotate back
    expect(g.forceAction("cw")).toBe(true);
    for (let i = 0; i < 6; i++) g.forceAction("right");
    expect(g.forceAction("ccw")).toBe(true);
  });

  it("allows 180 rotation", () => {
    const g = new Game({ g: 0 });
    g.piece.type = "t";
    g.press("180");
    expect(g.piece.r).toBe(2);
  });
});

describe("attack table (matches official client)", () => {
  it("base clears", () => {
    expect(rawAttack(1, "none", 0, 1, false)).toBe(0);
    expect(rawAttack(2, "none", 0, 1, false)).toBe(1);
    expect(rawAttack(3, "none", 0, 1, false)).toBe(2);
    expect(rawAttack(4, "none", 1, 1, false)).toBe(4);
    expect(rawAttack(1, "normal", 1, 1, false)).toBe(2);
    expect(rawAttack(2, "normal", 1, 1, false)).toBe(4);
    expect(rawAttack(3, "normal", 1, 1, false)).toBe(6);
    expect(rawAttack(2, "mini", 1, 1, false)).toBe(1);
  });

  it("back-to-back", () => {
    expect(rawAttack(4, "none", 2, 1, false)).toBe(5);
    expect(rawAttack(2, "normal", 2, 1, false)).toBe(5);
    // B2B chaining (league): x1 = +1, grows logarithmically
    expect(Math.floor(rawAttack(4, "none", 2, 1, true))).toBe(5);
    expect(Math.floor(rawAttack(4, "none", 4, 1, true))).toBe(6);
    expect(Math.floor(rawAttack(4, "none", 9, 1, true))).toBe(7);
  });

  it("combo multiplier table for singles and quads", () => {
    const singles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((c) => Math.floor(rawAttack(1, "none", 0, c, false)));
    expect(singles).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(Math.floor(rawAttack(4, "none", 1, 2, false))).toBe(5);
    expect(Math.floor(rawAttack(2, "none", 0, 5, false))).toBe(2);
  });
});

describe("garbage", () => {
  it("waits garbagespeed frames, then tanks on a non-clearing lock", () => {
    const g = new Game({ hasgarbage: true, g: 0 });
    g.receive(3);
    g.press("hard"); // immediately: not ready yet
    expect(g.board.filter((r) => r.includes("g")).length).toBe(0);
    g.advance(21);
    g.press("hard");
    const rows = g.board.filter((r) => r.includes("g"));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.filter((c) => c === null).length === 1)).toBe(true);
  });

  it("caps at 8 lines per piece", () => {
    const g = new Game({ hasgarbage: true, g: 0 });
    g.receive(12);
    g.advance(25);
    g.press("hard");
    expect(g.board.filter((r) => r.includes("g")).length).toBe(8);
    expect(g.pendingGarbage()).toBe(4);
  });

  it("outgoing attack cancels incoming first", () => {
    const g = new Game({ hasgarbage: true, g: 0 });
    let sent = 0;
    g.onAttack = (n) => (sent += n);
    g.receive(2);
    g.piece.type = "i";
    g.piece.r = 1;
    setBottom(g, Array(4).fill(".#########"));
    placeAt(g, -1, 37);
    g.press("hard");
    expect(g.stats.lines).toBe(4);
    expect(g.pendingGarbage()).toBe(0);
    expect(sent).toBe(2 + 10); // quad 4 - 2 cancelled = 2, plus all-clear 10
  });
});

describe("modes", () => {
  it("40 lines finishes on the 40th line", () => {
    const g = new Game({ objective: { type: "lines", count: 4 }, g: 0 });
    g.piece.type = "i";
    g.piece.r = 1;
    setBottom(g, Array(4).fill(".#########"));
    placeAt(g, -1, 37);
    g.press("hard");
    expect(g.over).toBe(true);
    expect(g.result).toBe("clear");
  });

  it("blitz timer ends the game", () => {
    const g = new Game({ objective: { type: "timed", frames: 120 }, g: 0 });
    g.advance(119);
    expect(g.over).toBe(false);
    g.advance(2);
    expect(g.result).toBe("clear");
  });
});
