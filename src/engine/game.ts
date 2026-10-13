import {
  ATTACK, BOARD_T, BOARD_W, BUFFER, Cell, DEFAULT_OPTIONS, GameOptions, I_KICKS, KICKS,
  PIECES, PieceType, Rotation, SCORING, SHAPES, T_CORNERS,
} from "./constants";
import { Rng } from "./rng";

export type Spin = "none" | "mini" | "normal";
export type Action = "left" | "right" | "soft" | "hard" | "cw" | "ccw" | "180" | "hold";

export interface Handling {
  das: number; // frames
  arr: number; // frames, 0 = instant
  dcd: number; // frames
  sdf: number; // soft drop factor, 41 = instant
}

export const DEFAULT_HANDLING: Handling = { das: 10, arr: 2, dcd: 2, sdf: 6 };

export interface Falling {
  type: PieceType;
  x: number;
  y: number; // fractional; occupied row = ceil(y + row - dy)
  r: Rotation;
  hy: number; // lowest row reached, for lock-reset accounting
  locking: number;
  lockresets: number;
  rotresets: number;
  spin: Spin;
  kick: number; // index of the kick used by the last rotation, -1 for none
  hitWall: boolean;
  forceLock: boolean;
}

export interface ClearInfo {
  lines: number;
  spin: Spin;
  piece: PieceType;
  btb: number; // back-to-back counter after this clear (>1 means bonus applied)
  combo: number;
  attack: number;
  allClear: boolean;
  btbBroken: number; // chain length that was just lost, 0 if none
}

export type GameEvent =
  | { type: "move" }
  | { type: "wall" }
  | { type: "rotate"; spin: Spin }
  | { type: "hold" }
  | { type: "harddrop"; x: number; y: number; piece: PieceType; r: Rotation }
  | { type: "lock"; piece: PieceType }
  | { type: "clear"; info: ClearInfo; rows: number[] }
  | { type: "spinlock"; spin: Spin; piece: PieceType } // spin with no lines
  | { type: "garbage-in"; amount: number }
  | { type: "garbage-tank"; amount: number }
  | { type: "garbage-cancel"; amount: number }
  | { type: "attack"; amount: number }
  | { type: "levelup"; level: number }
  | { type: "topout" }
  | { type: "finish" };

interface Shift {
  dir: -1 | 1;
  held: boolean;
  das: number;
  arr: number;
}

interface Incoming {
  id: number;
  amount: number;
  readyAt: number; // frame when it may enter the board
  column: number;
}

export interface Stats {
  pieces: number;
  inputs: number;
  lines: number;
  score: number;
  level: number;
  levelLines: number;
  levelLinesNeeded: number;
  attack: number; // total attack generated (before cancelling)
  sent: number;
  received: number;
  cancelled: number;
  btb: number;
  maxBtb: number;
  combo: number;
  maxCombo: number;
  holds: number;
  clears: Record<string, number>;
}

export class Game {
  readonly opts: GameOptions;
  handling: Handling;
  board: Cell[][];
  queue: PieceType[] = [];
  hold: PieceType | null = null;
  holdLocked = false;
  piece!: Falling;
  frame = 0;
  g: number;
  garbageMultiplier: number;
  over = false;
  result: "clear" | "topout" | null = null;
  stats: Stats;
  incoming: Incoming[] = [];

  /** Called with each outgoing attack after cancellation (VS mode). */
  onAttack: ((amount: number) => void) | null = null;

  private bagRng: Rng;
  private garbageRng: Rng;
  private listeners: ((e: GameEvent) => void)[] = [];
  private lShift: Shift = { dir: -1, held: false, das: 0, arr: 0 };
  private rShift: Shift = { dir: 1, held: false, das: 0, arr: 0 };
  private lastShift: -1 | 1 = 1;
  private softdrop = false;
  private totalRotations = 0;
  private garbageId = 0;
  private lastColumn: number | null = null;

  constructor(opts: Partial<GameOptions> = {}, handling: Handling = DEFAULT_HANDLING) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.handling = { ...handling };
    this.bagRng = new Rng(this.opts.seed);
    this.garbageRng = new Rng(this.opts.seed + 1);
    this.board = Array.from({ length: BOARD_T }, () => Array<Cell>(BOARD_W).fill(null));
    this.g = this.opts.g;
    this.garbageMultiplier = this.opts.garbagemultiplier;
    this.stats = {
      pieces: 0, inputs: 0, lines: 0, score: 0, level: 1, levelLines: 0, levelLinesNeeded: 0,
      attack: 0, sent: 0, received: 0, cancelled: 0, btb: 0, maxBtb: 0, combo: 0, maxCombo: 0,
      holds: 0, clears: {},
    };
    if (this.opts.levels) this.setLevel(1);
    this.spawn();
  }

  on(fn: (e: GameEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: GameEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  // ---------------------------------------------------------------- queries

  cellsOf(type: PieceType, x: number, y: number, r: Rotation): [number, number][] {
    const s = SHAPES[type][r];
    return s.cells.map(([c, row]) => [x + c - s.dx, Math.ceil(y + row - s.dy)]);
  }

  isOccupied(x: number, y: number): boolean {
    if (x < 0 || x >= BOARD_W) return true;
    const row = Math.ceil(y);
    if (row < 0 || row >= BOARD_T) return true;
    return this.board[row][x] !== null;
  }

  isLegal(type: PieceType, x: number, y: number, r: Rotation): boolean {
    const s = SHAPES[type][r];
    for (const [c, row] of s.cells) {
      if (this.isOccupied(x + c - s.dx, y + row - s.dy)) return false;
    }
    return true;
  }

  /** y the current piece would land at if hard dropped. */
  ghostY(): number {
    const p = this.piece;
    let y = p.y;
    while (this.canFall(y, 1)) y = this.stepY(y, 1);
    return y;
  }

  get effectiveTime(): number {
    return this.frame / 60;
  }

  pps(): number {
    return this.frame > 0 ? this.stats.pieces / (this.frame / 60) : 0;
  }

  apm(): number {
    return this.frame > 0 ? this.stats.attack / (this.frame / 3600) : 0;
  }

  pendingGarbage(): number {
    return this.incoming.reduce((a, b) => a + b.amount, 0);
  }

  // ---------------------------------------------------------------- time

  /** Advance simulated time by `dt` frames (may be fractional). */
  advance(dt: number): void {
    while (dt > 1e-9 && !this.over) {
      const toBoundary = Math.floor(this.frame + 1e-9) + 1 - this.frame;
      const step = Math.min(dt, toBoundary);
      this.processShift(this.lShift, step);
      this.processShift(this.rShift, step);
      this.fall(step);
      const before = Math.floor(this.frame + 1e-9);
      this.frame += step;
      dt -= step;
      if (Math.floor(this.frame + 1e-9) > before) this.onFrame();
    }
  }

  private onFrame(): void {
    const o = this.opts;
    // the *increase options are per second, applied in 1/60 steps (as in the client)
    if (o.gincrease && this.frame > o.gmargin) this.g += o.gincrease / 60;
    if (o.garbageincrease && this.frame > o.garbagemargin) this.garbageMultiplier += o.garbageincrease / 60;
    if (o.objective.type === "timed" && this.frame >= o.objective.frames) this.finish("clear");
  }

  // ---------------------------------------------------------------- input

  press(action: Action): void {
    if (this.over) return;
    this.stats.inputs++;
    switch (action) {
      case "left":
      case "right": {
        const s = action === "left" ? this.lShift : this.rShift;
        s.held = true;
        s.das = 0;
        s.arr = this.handling.arr;
        this.lastShift = s.dir;
        this.shift();
        break;
      }
      case "soft":
        this.softdrop = true;
        break;
      case "hard":
        this.hardDrop();
        break;
      case "cw":
        this.rotate(1);
        break;
      case "ccw":
        this.rotate(3);
        break;
      case "180":
        if (this.opts.allow180) this.rotate(2);
        break;
      case "hold":
        this.doHold();
        break;
    }
  }

  release(action: Action): void {
    if (action === "left" || action === "right") {
      const s = action === "left" ? this.lShift : this.rShift;
      const other = action === "left" ? this.rShift : this.lShift;
      s.held = false;
      if (this.lastShift === s.dir && other.held) this.lastShift = other.dir;
    } else if (action === "soft") {
      this.softdrop = false;
    }
  }

  /** Clear held-key state, e.g. when the window loses focus. */
  releaseAll(): void {
    this.lShift.held = this.rShift.held = false;
    this.softdrop = false;
  }

  private processShift(s: Shift, dt: number): void {
    const h = this.handling;
    if (!s.held || this.lastShift !== s.dir) return;
    const overflow = Math.max(0, dt - Math.max(0, h.das - s.das));
    s.das = Math.min(s.das + dt, h.das);
    if (s.das < h.das) return;
    s.arr += overflow;
    if (s.arr < h.arr) return;
    const n = h.arr === 0 ? BOARD_W : Math.floor(s.arr / h.arr);
    s.arr -= h.arr * n;
    for (let i = 0; i < n; i++) if (!this.shift(true)) break;
  }

  private shift(auto = false): boolean {
    const p = this.piece;
    if (this.isLegal(p.type, p.x + this.lastShift, p.y, p.r)) {
      p.x += this.lastShift;
      if (p.lockresets < 31) p.lockresets++;
      p.spin = "none";
      p.kick = -1;
      p.hitWall = false;
      if (!this.shouldLock()) p.locking = 0;
      if (!auto) this.emit({ type: "move" });
      return true;
    }
    if (!p.hitWall) this.emit({ type: "wall" });
    p.hitWall = true;
    return false;
  }

  private applyDCD(): void {
    const h = this.handling;
    if (!this.piece.hitWall || !h.dcd) return;
    for (const s of [this.lShift, this.rShift]) {
      s.das = Math.min(s.das, h.das - h.dcd);
      s.arr = h.arr;
    }
  }

  // ---------------------------------------------------------------- gravity & locking

  private shouldLock(): boolean {
    return this.piece.lockresets >= this.opts.lockresets;
  }

  private stepY(y: number, e: number): number {
    let a = Math.round(1e6 * (y + e)) / 1e6;
    if (a % 1 === 0) a += 1e-6;
    return a;
  }

  private canFall(y: number, e: number): boolean {
    const p = this.piece;
    const a = this.stepY(y, e);
    let full = y + 1;
    if (full % 1 === 0) full -= 2e-6;
    return this.isLegal(p.type, p.x, a, p.r) && this.isLegal(p.type, p.x, full, p.r);
  }

  /** One gravity step of at most one row; false when blocked. */
  private fallStep(e: number): boolean {
    const p = this.piece;
    if (!this.canFall(p.y, e)) return false;
    const a = this.stepY(p.y, e);
    const prevHy = p.hy;
    if (prevHy < a) p.hy = Math.ceil(a);
    p.y = a;
    if (a > prevHy) {
      p.lockresets = 0;
      p.rotresets = 0;
    }
    return true;
  }

  private fall(dt: number): void {
    if (this.over) return;
    const p = this.piece;
    const h = this.handling;
    let rows = this.g * dt;
    if (this.softdrop) {
      if (h.sdf >= 41) rows = 400 * dt;
      else rows = Math.max(rows * h.sdf, 0.05 * h.sdf * dt);
    }
    if (this.shouldLock() && !this.isLegal(p.type, p.x, p.y + 1, p.r)) {
      rows = 20;
      p.forceLock = true;
    }
    if (p.rotresets > this.opts.lockresets + 15) rows += 0.5 * dt * (p.rotresets - (this.opts.lockresets + 15));

    for (let t = rows; t > 0; t -= Math.min(1, t)) {
      const prevRow = Math.ceil(p.y);
      if (!this.fallStep(Math.min(1, t))) {
        p.locking += dt;
        if (p.locking > this.opts.locktime || p.forceLock || this.shouldLock()) this.lock();
        return;
      }
      if (Math.ceil(p.y) !== prevRow) {
        p.spin = "none";
        p.kick = -1;
        if (this.softdrop) this.stats.score += SCORING.SOFTDROP;
      }
    }
  }

  hardDrop(): void {
    if (this.over) return;
    const p = this.piece;
    while (this.fallStep(1)) this.stats.score += SCORING.HARDDROP;
    this.emit({ type: "harddrop", x: p.x, y: p.y, piece: p.type, r: p.r });
    this.lock();
  }

  // ---------------------------------------------------------------- rotation

  private rotate(delta: 1 | 2 | 3): void {
    const p = this.piece;
    const to = ((p.r + delta) % 4) as Rotation;
    const res = this.computeKick(p.type, p.x, p.y, p.r, to);
    if (!res) return;
    p.x = res.x;
    p.y = res.y;
    p.r = to;
    p.kick = res.kick;
    if (p.lockresets < 31) p.lockresets++;
    if (p.rotresets < 63) p.rotresets++;
    this.totalRotations++;
    p.spin = this.detectSpin();
    this.applyDCD();
    if (!this.shouldLock()) p.locking = 0;
    this.emit({ type: "rotate", spin: p.spin });
  }

  computeKick(
    type: PieceType, x: number, y: number, from: Rotation, to: Rotation,
  ): { x: number; y: number; kick: number } | null {
    if (this.isLegal(type, x, y, to)) return { x, y, kick: -1 };
    if (type === "o") return null;
    const table = (type === "i" ? I_KICKS : KICKS)[`${from}${to}`];
    const late = this.totalRotations > this.opts.lockresets + 15;
    for (let i = 0; i < table.length; i++) {
      const [kx, ky] = table[i];
      const nx = x + kx;
      const ny = late ? y + ky : Math.floor(y) + 0.1 + ky;
      if (this.isLegal(type, nx, ny, to)) return { x: nx, y: ny, kick: i };
    }
    return null;
  }

  private tCornerSpin(): Spin {
    const p = this.piece;
    if (this.isLegal(p.type, p.x, p.y + 1, p.r)) return "none";
    let corners = 0;
    let front = 0;
    for (const [cx, cy, a, b] of T_CORNERS) {
      if (this.isOccupied(p.x + cx, p.y + cy)) {
        corners++;
        if (p.r === a || p.r === b) front++;
      }
    }
    if (corners < 3) return "none";
    if (p.kick === 3) return "normal"; // TST / fin kick upgrades a mini
    return front === 2 ? "normal" : "mini";
  }

  private immobile(): boolean {
    const { type, x, y, r } = this.piece;
    return !this.isLegal(type, x - 1, y, r) && !this.isLegal(type, x + 1, y, r)
      && !this.isLegal(type, x, y - 1, r) && !this.isLegal(type, x, y + 1, r);
  }

  private detectSpin(): Spin {
    const p = this.piece;
    if (this.opts.spinbonuses === "T-spins") return p.type === "t" ? this.tCornerSpin() : "none";
    // all-mini+: T uses the corner rule; any immobile piece (T included) is a mini.
    if (p.type === "t") {
      const s = this.tCornerSpin();
      if (s !== "none") return s;
    }
    return this.immobile() ? "mini" : "none";
  }

  // ---------------------------------------------------------------- hold & spawn

  private doHold(): void {
    if (this.holdLocked) return;
    const cur = this.piece.type;
    const next = this.hold;
    this.hold = cur;
    this.holdLocked = true;
    this.stats.holds++;
    this.emit({ type: "hold" });
    this.spawn(next ?? undefined);
  }

  private fillQueue(): void {
    while (this.queue.length <= this.opts.nextcount) {
      this.queue.push(...this.bagRng.shuffle([...PIECES]));
    }
  }

  private spawn(type?: PieceType): void {
    this.fillQueue();
    const t = type ?? this.queue.shift()!;
    this.fillQueue();
    const x = Math.ceil(BOARD_W / 2) - 1;
    const y = BUFFER - 2.04;
    this.piece = {
      type: t, x, y, r: 0, hy: BUFFER - 2, locking: 0, lockresets: 0, rotresets: 0,
      spin: "none", kick: -1, hitWall: false, forceLock: false,
    };
    this.totalRotations = 0;
    this.applyDCD();
    if (!this.isLegal(t, x, y, 0)) this.finish("topout");
  }

  // ---------------------------------------------------------------- locking & clears

  private lock(): void {
    const p = this.piece;
    const cells = this.cellsOf(p.type, p.x, p.y, p.r);
    for (const [cx, cy] of cells) this.board[cy][cx] = p.type;
    this.stats.pieces++;
    this.emit({ type: "lock", piece: p.type });
    const lockedAbove = cells.every(([, cy]) => cy < BUFFER);

    const rows: number[] = [];
    for (let y = 0; y < BOARD_T; y++) if (this.board[y].every((c) => c !== null)) rows.push(y);
    const lines = rows.length;
    const spin = p.spin;

    for (const y of rows) {
      this.board.splice(y, 1);
      this.board.unshift(Array<Cell>(BOARD_W).fill(null));
    }
    const allClear = lines > 0 && this.board.every((row) => row.every((c) => c === null));
    const blocked = this.scoreClear(lines, spin, p.type, allClear, rows);

    if (lockedAbove && !this.opts.nolockout && lines === 0) {
      this.finish("topout");
      return;
    }
    if (!blocked) this.tankGarbage();
    if (this.over) return;

    if (this.opts.objective.type === "lines" && this.stats.lines >= this.opts.objective.count) {
      this.finish("clear");
      return;
    }
    this.holdLocked = false;
    this.spawn();
  }

  /** Applies score/attack for a lock. Returns true when garbage entry is blocked this piece. */
  private scoreClear(lines: number, spin: Spin, piece: PieceType, allClear: boolean, rows: number[]): boolean {
    const st = this.stats;
    if (lines === 0) {
      st.combo = 0;
      if (spin !== "none") {
        st.score += (spin === "mini" ? SCORING.TSPIN_MINI : SCORING.TSPIN) * st.level;
        this.emit({ type: "spinlock", spin, piece });
      }
      return false;
    }

    st.lines += lines;
    st.combo++;
    st.maxCombo = Math.max(st.maxCombo, st.combo);
    const difficult = lines >= 4 || spin !== "none";
    let btbBroken = 0;
    if (difficult) st.btb++;
    else {
      if (st.btb > 1) btbBroken = st.btb - 1;
      st.btb = 0;
    }
    st.maxBtb = Math.max(st.maxBtb, st.btb);

    const key = clearName(lines, spin);
    st.clears[key] = (st.clears[key] ?? 0) + 1;

    let score = scoreFor(Math.min(lines, 4), spin);
    if (st.btb > 1) score *= SCORING.BACKTOBACK_MULTIPLIER;
    if (st.combo > 1) score += SCORING.COMBO * (st.combo - 1);
    const atk = rawAttack(lines, spin, st.btb, st.combo, this.opts.b2bchaining);
    let attack = Math.floor(atk * this.garbageMultiplier);
    st.score += score * st.level;

    if (allClear) {
      st.score += SCORING.ALL_CLEAR * st.level;
      attack += Math.floor(this.opts.allclear_garbage * this.garbageMultiplier);
    }

    this.emit({
      type: "clear",
      info: { lines, spin, piece, btb: st.btb, combo: st.combo, attack, allClear, btbBroken },
      rows,
    });

    if (this.opts.levels) this.addLevelLines(lines);
    this.fight(attack);
    return true; // combo blocking: clearing lines always blocks garbage entry
  }

  private addLevelLines(lines: number): void {
    const st = this.stats;
    st.levelLines += lines;
    let leveled = false;
    while (st.levelLines >= st.levelLinesNeeded) {
      st.levelLines -= st.levelLinesNeeded;
      this.setLevel(st.level + 1);
      leveled = true;
    }
    if (leveled) this.emit({ type: "levelup", level: st.level });
  }

  private setLevel(level: number): void {
    const o = this.opts;
    const st = this.stats;
    st.level = level;
    this.g = Math.min(20, 1 / 60 / Math.pow(Math.max(1e-9, o.levelgbase - (level - 1) * o.levelgspeed), level - 1));
    st.levelLinesNeeded = Math.ceil(level * o.levelspeed * 5);
  }

  // ---------------------------------------------------------------- garbage

  /** Spend attack on cancelling incoming garbage first, then send the rest. */
  private fight(attack: number): void {
    if (attack <= 0) return;
    this.stats.attack += attack;
    let left = attack;
    let cancelled = 0;
    while (left > 0 && this.incoming.length) {
      const inc = this.incoming[0];
      const n = Math.min(inc.amount, left);
      inc.amount -= n;
      left -= n;
      cancelled += n;
      if (inc.amount === 0) this.incoming.shift();
    }
    if (cancelled) {
      this.stats.cancelled += cancelled;
      this.emit({ type: "garbage-cancel", amount: cancelled });
    }
    if (left > 0) {
      this.stats.sent += left;
      this.emit({ type: "attack", amount: left });
      this.onAttack?.(left);
    }
  }

  receive(amount: number): void {
    if (this.over || amount <= 0) return;
    let col = this.lastColumn;
    if (col === null || this.garbageRng.nextFloat() < this.opts.messiness_change) {
      col = Math.floor(this.garbageRng.nextFloat() * BOARD_W);
    }
    this.lastColumn = col;
    this.incoming.push({
      id: ++this.garbageId, amount, readyAt: this.frame + this.opts.garbagespeed, column: col,
    });
    this.stats.received += amount;
    this.emit({ type: "garbage-in", amount });
  }

  private tankGarbage(): void {
    let cap = this.opts.garbagecap;
    let total = 0;
    while (cap > 0 && this.incoming.length && this.incoming[0].readyAt <= this.frame) {
      const inc = this.incoming[0];
      const n = Math.min(inc.amount, cap);
      for (let i = 0; i < n; i++) this.pushGarbageRow(inc.column);
      inc.amount -= n;
      cap -= n;
      total += n;
      if (inc.amount === 0) this.incoming.shift();
      if (this.over) return;
    }
    if (total) this.emit({ type: "garbage-tank", amount: total });
  }

  private pushGarbageRow(hole: number): void {
    const top = this.board.shift()!;
    if (top.some((c) => c !== null)) {
      this.finish("topout");
      return;
    }
    const row = Array<Cell>(BOARD_W).fill("g");
    row[hole] = null;
    this.board.push(row);
  }

  private finish(result: "clear" | "topout"): void {
    if (this.over) return;
    this.over = true;
    this.result = result;
    this.emit({ type: result === "clear" ? "finish" : "topout" });
  }

  /** Zen mode: wipe the board instead of ending the game. */
  wipe(): void {
    this.board = Array.from({ length: BOARD_T }, () => Array<Cell>(BOARD_W).fill(null));
    this.incoming = [];
    this.over = false;
    this.result = null;
    this.holdLocked = false;
    this.spawn();
  }

  /** Deep copy without listeners — used by the bot to try placements. */
  clone(): Game {
    const c = Object.create(Game.prototype) as Game;
    Object.assign(c, this);
    const raw = c as unknown as Record<string, unknown>;
    raw.listeners = [];
    raw.lShift = { ...this.lShift };
    raw.rShift = { ...this.rShift };
    raw.bagRng = Object.assign(Object.create(Rng.prototype), this.bagRng);
    raw.garbageRng = Object.assign(Object.create(Rng.prototype), this.garbageRng);
    c.onAttack = null;
    c.board = this.board.map((r) => r.slice());
    c.queue = this.queue.slice();
    c.piece = { ...this.piece };
    c.stats = { ...this.stats, clears: { ...this.stats.clears } };
    c.incoming = this.incoming.map((i) => ({ ...i }));
    return c;
  }

  /** Let the bot (or tests) drive the piece directly without key timing. */
  forceAction(action: "left" | "right" | "cw" | "ccw" | "180" | "hold" | "hard" | "softdrop-to-floor"): boolean {
    if (this.over) return false;
    const p = this.piece;
    switch (action) {
      case "left":
      case "right": {
        this.lastShift = action === "left" ? -1 : 1;
        return this.shift(true);
      }
      case "cw": { const r = p.r; this.rotate(1); return p.r !== r; }
      case "ccw": { const r = p.r; this.rotate(3); return p.r !== r; }
      case "180": { const r = p.r; this.rotate(2); return p.r !== r; }
      case "hold": { const h = this.holdLocked; this.doHold(); return !h; }
      case "hard": this.hardDrop(); return true;
      case "softdrop-to-floor": {
        let moved = false;
        while (this.fallStep(1)) { moved = true; p.spin = "none"; }
        return moved;
      }
    }
  }
}

/**
 * Attack before the garbage multiplier and rounding, exactly as the official
 * client computes it. `btb` and `combo` are the counters *after* this clear
 * (first difficult clear => btb 1, first clear in a chain => combo 1).
 */
export function rawAttack(lines: number, spin: Spin, btb: number, combo: number, b2bchaining: boolean): number {
  const L = Math.min(lines, 4);
  let atk = spin === "normal" ? ATTACK.spin[L] : spin === "mini" ? ATTACK.mini[L] : ATTACK.normal[L];
  if (lines > 4) atk = spin === "normal" ? 12 + 2 * (lines - 5) : 5 + (lines - 5);
  if (btb > 1) {
    if (b2bchaining) {
      const x = Math.log1p((btb - 1) * ATTACK.BACKTOBACK_BONUS_LOG);
      atk += ATTACK.BACKTOBACK_BONUS * (Math.floor(1 + x) + (btb - 1 === 1 ? 0 : (1 + (x % 1)) / 3));
    } else {
      atk += ATTACK.BACKTOBACK_BONUS;
    }
  }
  if (combo > 1) {
    atk *= 1 + ATTACK.COMBO_BONUS * (combo - 1);
    if (combo > 2) atk = Math.max(Math.log1p(ATTACK.COMBO_MINIFIER * (combo - 1) * ATTACK.COMBO_MINIFIER_LOG), atk);
  }
  return atk;
}

export function clearName(lines: number, spin: Spin): string {
  const n = ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"][Math.min(lines, 4)];
  if (spin === "none") return n;
  return spin === "mini" ? `MINI SPIN ${n}`.trim() : `SPIN ${n}`.trim();
}

function scoreFor(lines: number, spin: Spin): number {
  const S = SCORING;
  if (spin === "normal") return [S.TSPIN, S.TSPIN_SINGLE, S.TSPIN_DOUBLE, S.TSPIN_TRIPLE, S.TSPIN_QUAD][lines];
  if (spin === "mini") return [S.TSPIN_MINI, S.TSPIN_MINI_SINGLE, S.TSPIN_MINI_DOUBLE, S.TSPIN_MINI_TRIPLE, S.TSPIN_MINI_QUAD][lines];
  return [0, S.SINGLE, S.DOUBLE, S.TRIPLE, S.QUAD][lines];
}
