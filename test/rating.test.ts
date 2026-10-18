import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATING, EPSILON, GLICKO_SCALE, GLICKO_TAU, RD_HIDDEN, RD_INITIAL, RD_MIN, R_INITIAL, VOL_INITIAL, calcTR,
  tdisplay, updateGlicko2,
} from "../src/server/rating";

describe("rating: constants", () => {
  it("keeps the v1.0.0 values", () => {
    expect([GLICKO_TAU, GLICKO_SCALE, R_INITIAL, RD_INITIAL, RD_MIN, RD_HIDDEN, VOL_INITIAL, EPSILON])
      .toEqual([0.6, 173.7178, 1500, 350, 30, 100, 0.06, 1e-6]);
    expect(DEFAULT_RATING).toEqual({ r: 1500, rd: 350, vol: 0.06 });
  });
});

describe("rating: TR", () => {
  it("is 12500 at r 1500, at any RD", () => {
    expect(calcTR(1500, 350)).toBe(12500);
    for (const rd of [30, 60, 100, 200, 350]) expect(calcTR(1500, rd)).toBeCloseTo(12500, 9);
  });

  it("rises with r and stays within 0 .. 25000", () => {
    for (const rd of [30, 100, 350]) {
      let last = -1;
      for (let r = 0; r <= 3000; r += 50) {
        const tr = calcTR(r, rd);
        expect(tr).toBeGreaterThan(last);
        expect(tr).toBeGreaterThanOrEqual(0);
        expect(tr).toBeLessThanOrEqual(25000);
        last = tr;
      }
    }
  });

  it("is hidden while RD is above 100", () => {
    expect(tdisplay(1500, 100.01)).toBeNull();
    expect(tdisplay(1500, 350)).toBeNull();
    expect(tdisplay(1500, 100)).toBe(12500);
    expect(typeof tdisplay(1700, 100)).toBe("number");
    expect(Number.isInteger(tdisplay(1712.3, 64.2))).toBe(true);
  });
});

describe("rating: Glicko-2 update", () => {
  it("moves equal new players apart by the same amount and narrows both RDs", () => {
    const a = { r: 1500, rd: 350, vol: 0.06 };
    const won = updateGlicko2(a, a, 1);
    const lost = updateGlicko2(a, a, 0);
    expect(won.r).toBeGreaterThan(1500);
    expect(lost.r).toBeLessThan(1500);
    expect(won.r - 1500).toBeCloseTo(1500 - lost.r, 9);
    for (const x of [won, lost]) {
      expect(x.rd).toBeLessThan(350);
      expect(x.rd).toBeGreaterThanOrEqual(RD_MIN);
      expect(Number.isFinite(x.vol)).toBe(true);
    }
  });

  it("leaves equal players' r unchanged on a draw", () => {
    const a = { r: 1500, rd: 350, vol: 0.06 };
    expect(updateGlicko2(a, a, 0.5).r).toBeCloseTo(1500, 9);
    const b = { r: 1800, rd: 80, vol: 0.06 };
    expect(updateGlicko2(b, b, 0.5).r).toBeCloseTo(1800, 9);
  });

  it("never takes RD below 30, over many games", () => {
    let a = { ...DEFAULT_RATING };
    let b = { ...DEFAULT_RATING };
    for (let i = 0; i < 300; i++) {
      const winA = i % 2 === 0;
      [a, b] = [updateGlicko2(a, b, winA ? 1 : 0), updateGlicko2(b, a, winA ? 0 : 1)];
      expect(a.rd).toBeGreaterThanOrEqual(RD_MIN);
      expect(b.rd).toBeGreaterThanOrEqual(RD_MIN);
    }
    expect(a.rd).toBeLessThanOrEqual(RD_HIDDEN);
  });

  it("raises r and narrows RD after a win over a lower-rated, settled opponent", () => {
    const x = updateGlicko2({ r: 1500, rd: 200, vol: 0.06 }, { r: 1400, rd: 30, vol: 0.06 }, 1);
    expect(x.r).toBeGreaterThan(1500);
    expect(x.rd).toBeLessThan(200);
    expect(x.vol).toBeCloseTo(0.06, 3);
  });
});
