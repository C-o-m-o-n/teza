import { BOARD_T, BOARD_W, BUFFER, Cell } from "../engine/constants";
import { Game } from "../engine/game";

type Move = "left" | "right" | "cw" | "ccw" | "180" | "hold" | "softdrop-to-floor";

interface Plan {
  moves: Move[];
  score: number;
}

const ROTATIONS: Move[][] = [[], ["cw"], ["180"], ["ccw"]];
const FINISHERS: Move[][] = [[], ["cw"], ["ccw"], ["180"], ["left"], ["right"], ["cw", "cw"], ["ccw", "ccw"]];

export interface BotProfile {
  name: string;
  pps: number;
  noise: number; // random jitter on evaluation, makes weaker bots misplay
  spins: boolean; // search soft-drop + spin finishes
}

export const BOT_PROFILES: BotProfile[] = [
  { name: "ROOKIE", pps: 0.9, noise: 6, spins: false },
  { name: "CASUAL", pps: 1.5, noise: 2.5, spins: false },
  { name: "RANKED", pps: 2.2, noise: 0.6, spins: true },
  { name: "PRO", pps: 3.2, noise: 0, spins: true },
];

/** Picks and executes one placement per call. */
export class Bot {
  private seq = 0;

  constructor(private game: Game, public profile: BotProfile) {}

  playPiece(): void {
    const g = this.game;
    if (g.over) return;
    const plan = this.best();
    for (const m of plan.moves) g.forceAction(m);
    g.forceAction("hard");
  }

  private best(): Plan {
    const g = this.game;
    let best: Plan = { moves: [], score: -Infinity };
    for (const useHold of [false, true]) {
      if (useHold && g.holdLocked) continue;
      for (const rot of ROTATIONS) {
        for (let dx = -6; dx <= 6; dx++) {
          const base: Move[] = [...(useHold ? (["hold"] as Move[]) : []), ...rot];
          const shift: Move = dx < 0 ? "left" : "right";
          for (let i = 0; i < Math.abs(dx); i++) base.push(shift);
          const finishers = this.profile.spins ? FINISHERS : [[]];
          for (const fin of finishers) {
            const moves = fin.length ? [...base, "softdrop-to-floor" as Move, ...fin] : base;
            const s = this.evaluate(moves);
            if (s !== null && s > best.score) best = { moves, score: s };
          }
        }
      }
    }
    return best;
  }

  /** Simulate moves + hard drop; null if the move list doesn't do what it says. */
  private evaluate(moves: Move[]): number | null {
    const sim = this.game.clone();
    for (const m of moves) {
      if (!sim.forceAction(m) && m !== "softdrop-to-floor") return null;
    }
    let attack = 0;
    let lines = 0;
    let spin = false;
    sim.on((e) => {
      if (e.type === "clear") {
        attack = e.info.attack;
        lines = e.info.lines;
        spin = e.info.spin === "normal";
      }
    });
    const btbBefore = this.game.stats.btb;
    const landing = sim.ghostY();
    sim.forceAction("hard");
    if (sim.result === "topout") return -1e9;
    const brokeB2B = lines > 0 && sim.stats.btb === 0 && btbBefore > 1;
    return this.score(sim.board, landing, lines, attack, spin, brokeB2B) + (Math.random() - 0.5) * this.profile.noise + 1e-6 * this.seq++;
  }

  private score(board: Cell[][], landing: number, lines: number, attack: number, spin: boolean, brokeB2B: boolean): number {
    const heights: number[] = [];
    let holes = 0;
    let colTransitions = 0;
    for (let x = 0; x < BOARD_W; x++) {
      let h = 0;
      let seen = false;
      for (let y = 0; y < BOARD_T; y++) {
        const filled = board[y][x] !== null;
        if (filled && !seen) {
          seen = true;
          h = BOARD_T - y;
        } else if (!filled && seen) holes++;
        if (y > 0 && filled !== (board[y - 1][x] !== null)) colTransitions++;
      }
      heights.push(h);
    }
    let rowTransitions = 0;
    for (let y = BUFFER; y < BOARD_T; y++) {
      let prev = true;
      for (let x = 0; x < BOARD_W; x++) {
        const f = board[y][x] !== null;
        if (f !== prev) rowTransitions++;
        prev = f;
      }
      if (!prev) rowTransitions++;
    }
    // One deep well is the plan (quads); any other well is a liability.
    let wellCol = 0;
    let wellDepth = -1;
    const depthAt = (x: number) =>
      Math.min(x === 0 ? 99 : heights[x - 1], x === BOARD_W - 1 ? 99 : heights[x + 1]) - heights[x];
    for (let x = 0; x < BOARD_W; x++) {
      const d = depthAt(x);
      if (d > wellDepth) {
        wellDepth = d;
        wellCol = x;
      }
    }
    let badWells = 0;
    let bump = 0;
    for (let x = 0; x < BOARD_W; x++) {
      if (x !== wellCol) {
        const d = depthAt(x);
        if (d > 1) badWells += d * d;
      }
      if (x < BOARD_W - 1 && x !== wellCol && x + 1 !== wellCol) bump += Math.abs(heights[x] - heights[x + 1]);
    }
    const agg = heights.reduce((a, b) => a + b, 0);
    const maxH = Math.max(...heights);
    const danger = maxH > 11 ? 1 : 0;
    const landingH = BOARD_T - landing;

    let s = 0;
    s -= 0.9 * landingH;
    s -= 0.35 * agg;
    s -= 1.0 * rowTransitions;
    s -= 2.2 * colTransitions;
    s -= 11 * holes;
    s -= 0.9 * bump;
    s -= 2.5 * badWells;
    s += Math.min(wellDepth, 4) * 1.2;
    s -= danger * 2.5 * (maxH - 11) * (maxH - 11);
    // Reward attack; discourage burning lines for nothing while the stack is safe.
    s += attack * 8;
    if (spin) s += 14;
    if (lines === 4) s += 12;
    if (lines > 0 && attack <= 1 && !spin && !danger) s -= 7 * lines;
    if (brokeB2B) s -= 14;
    if (lines > 0 && danger) s += lines * 10;
    return s;
  }
}
