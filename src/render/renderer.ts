import { BOARD_H, BOARD_W, BUFFER, Cell, PieceType, SHAPES } from "../engine/constants";
import { Game, GameEvent } from "../engine/game";

export const COLORS: Record<PieceType | "g", string> = {
  z: "#ef3b4f",
  l: "#f5862a",
  o: "#f5c931",
  s: "#79d136",
  i: "#29cdb5",
  j: "#4c5ef0",
  t: "#b647e0",
  g: "#5b5b68",
};

const DISPLAY = "'Russo One', 'Saira', system-ui, sans-serif";
const BODY = "'Saira Semi Condensed', 'Saira', system-ui, sans-serif";

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** Pre-rendered mino sprites, one per colour per cell size. */
class Skin {
  private cache = new Map<string, HTMLCanvasElement>();

  get(color: string, size: number): HTMLCanvasElement {
    const key = `${color}@${size}`;
    let c = this.cache.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d")!;
    const b = Math.max(1, Math.round(size * 0.12));
    x.fillStyle = color;
    x.fillRect(0, 0, size, size);
    // bevel: light top-left, dark bottom-right
    x.fillStyle = shade(color, 0.35);
    x.beginPath();
    x.moveTo(0, 0); x.lineTo(size, 0); x.lineTo(size - b, b); x.lineTo(b, b); x.lineTo(b, size - b); x.lineTo(0, size);
    x.fill();
    x.fillStyle = shade(color, -0.35);
    x.beginPath();
    x.moveTo(size, size); x.lineTo(0, size); x.lineTo(b, size - b); x.lineTo(size - b, size - b); x.lineTo(size - b, b); x.lineTo(size, 0);
    x.fill();
    // face sheen
    x.fillStyle = shade(color, 0.12);
    x.fillRect(b, b, size - 2 * b, (size - 2 * b) * 0.45);
    this.cache.set(key, c);
    return c;
  }

  clear(): void {
    this.cache.clear();
  }
}

interface Spring {
  x: number; y: number; r: number; vx: number; vy: number; vr: number;
}

/** A shard of a cleared cell: `part` of `parts`×`parts` pieces of the cell's sprite. */
interface Fragment {
  x: number; y: number; vx: number; vy: number; rot: number; vr: number;
  life: number; max: number; color: string; size: number; part: [number, number]; parts: number;
}

interface Shockwave {
  y: number; // centre row, board px
  t: number;
  strength: number;
}

interface ActionText {
  lines: { text: string; color: string; size: number }[];
  t: number;
  life: number;
}

interface Flash {
  rows: number[];
  t: number;
}

interface Trail {
  cols: [number, number][]; // [x, topRow]
  color: string;
  t: number;
}

export interface ViewLayout {
  bx: number; // board top-left (visible area), css px
  by: number;
  S: number; // cell size
}

export interface ViewOptions {
  label?: string;
  accent: string;
  mode: "40l" | "blitz" | "zen" | "vs";
  objectiveLines?: number;
  compact?: boolean; // opponent board: fewer stats
  ghost?: boolean; // PB ghost: drawn translucent, laid out beside the player's board
}

const GHOST_ALPHA = 0.4;

/** Visual state for one board: springs, particles, action text. */
export class BoardView {
  layout: ViewLayout = { bx: 0, by: 0, S: 24 };
  spring: Spring = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 };
  /** Vertical stretch (+) / squash (−) about the board bottom, with its velocity. */
  squash = { s: 0, v: 0 };
  fragments: Fragment[] = [];
  shockwaves: Shockwave[] = [];
  /** Heartbeat scale offset this frame (0 unless danger is high). */
  heartbeat = 0;
  private heartT = 0;
  private recoilDir = 1;
  /** Full rows as they were at the last lock, so cleared cells keep their colours. */
  private lockedRows = new Map<number, Cell[]>();
  texts: ActionText[] = [];
  flashes: Flash[] = [];
  trails: Trail[] = [];
  bigText: { text: string; t: number; color: string } | null = null;
  /** Line above the board, e.g. the ghost's lead over the player. */
  marker: string | null = null;
  danger = 0;
  bounciness = 1;
  reduceMotion = false;

  constructor(public game: Game, public opts: ViewOptions) {
    game.on((e) => this.onEvent(e));
  }

  setGame(game: Game): void {
    this.game = game;
    this.fragments = [];
    this.shockwaves = [];
    this.squash = { s: 0, v: 0 };
    this.heartbeat = 0;
    this.heartT = 0;
    this.texts = [];
    this.flashes = [];
    this.trails = [];
    this.bigText = null;
    this.spring = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 };
    game.on((e) => this.onEvent(e));
  }

  /** Strength of board motion: bounciness, or 0 when motion is reduced. */
  private get motion(): number {
    return this.reduceMotion ? 0 : this.bounciness;
  }

  private kick(vx: number, vy: number, vr = 0): void {
    const k = this.motion;
    this.spring.vx += vx * k;
    this.spring.vy += vy * k;
    this.spring.vr += vr * k;
  }

  private onEvent(e: GameEvent): void {
    const S = this.layout.S;
    switch (e.type) {
      case "wall":
        this.kick(this.game.piece.x < BOARD_W / 2 ? -S * 4 : S * 4, 0);
        break;
      case "harddrop": {
        this.kick(0, S * 9);
        this.squash.v += 1.4 * this.motion;
        const cells = this.game.cellsOf(e.piece, e.x, e.y, e.r);
        const tops = new Map<number, number>();
        for (const [x, y] of cells) tops.set(x, Math.min(tops.get(x) ?? 99, y));
        this.trails.push({ cols: [...tops.entries()], color: COLORS[e.piece], t: 0 });
        break;
      }
      case "rotate":
        if (e.spin !== "none") this.kick(0, 0, 0.06);
        break;
      case "lock":
        this.lockedRows.clear();
        for (let y = 0; y < this.game.board.length; y++) {
          const row = this.game.board[y];
          if (row.every((c) => c !== null)) this.lockedRows.set(y, [...row]);
        }
        break;
      case "clear": {
        const { info } = e;
        this.flashes.push({ rows: e.rows, t: 0 });
        this.shatter(e.rows, info.piece);
        if ((info.spin !== "none" || info.btb > 1) && this.motion > 0) {
          const mid = (e.rows[0] + e.rows[e.rows.length - 1]) / 2;
          this.shockwaves.push({ y: (mid - BUFFER + 0.5) * S, t: 0, strength: this.motion });
        }
        this.kick(0, S * (2 + info.lines * 2), info.spin !== "none" ? (Math.random() < 0.5 ? -0.08 : 0.08) : 0);
        const lines: ActionText["lines"] = [];
        const clearWord = ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"][Math.min(info.lines, 4)];
        if (info.spin !== "none") {
          lines.push({ text: `${info.spin === "mini" ? "MINI " : ""}${info.piece.toUpperCase()}-SPIN`, color: COLORS[info.piece], size: 1.0 });
        }
        lines.push({ text: clearWord, color: info.lines >= 4 ? "#ffffff" : "#d9d9e6", size: info.lines >= 4 || info.spin !== "none" ? 1.35 : 1.05 });
        if (info.btb > 1) lines.push({ text: `B2B ×${info.btb - 1}`, color: "#f5c931", size: 0.8 });
        if (info.combo > 1) lines.push({ text: `${info.combo - 1} COMBO`, color: "#8fd3ff", size: 0.8 });
        this.texts.unshift({ lines, t: 0, life: 1.8 });
        this.texts.length = Math.min(this.texts.length, 3);
        if (info.allClear) {
          this.bigText = { text: "ALL CLEAR", t: 0, color: "#f5c931" };
          this.kick(0, S * 14, 0.1);
        }
        break;
      }
      case "spinlock":
        this.texts.unshift({
          lines: [{ text: `${e.spin === "mini" ? "MINI " : ""}${e.piece.toUpperCase()}-SPIN`, color: COLORS[e.piece], size: 1 }],
          t: 0, life: 1.4,
        });
        break;
      case "garbage-in":
        this.recoilDir = -this.recoilDir;
        this.kick(this.recoilDir * S * (60 + Math.min(10, e.amount) * 12), 0);
        break;
      case "garbage-tank":
        this.kick(0, -S * (4 + e.amount * 1.5));
        break;
      case "levelup":
        this.texts.unshift({ lines: [{ text: `LEVEL ${e.level}`, color: "#f5c931", size: 1 }], t: 0, life: 1.5 });
        break;
      case "topout":
        this.kick(S * 6, S * 18, 0.12);
        break;
    }
  }

  /** Break each cleared cell into fragments that fly out and fall. */
  private shatter(rows: number[], piece: PieceType): void {
    const k = this.motion;
    if (k <= 0) return;
    const { S } = this.layout;
    const parts = k >= 1.5 ? 3 : k >= 0.75 ? 2 : 1;
    const size = S / parts;
    const mid = (BOARD_W * S) / 2;
    for (const row of rows) {
      const cells = this.lockedRows.get(row);
      for (let x = 0; x < BOARD_W; x++) {
        const color = COLORS[cells?.[x] ?? piece];
        for (let px = 0; px < parts; px++) {
          for (let py = 0; py < parts; py++) {
            const cx = x * S + (px + 0.5) * size;
            const cy = (row - BUFFER) * S + (py + 0.5) * size;
            this.fragments.push({
              x: cx, y: cy,
              vx: ((cx - mid) / mid + (Math.random() - 0.5) * 1.4) * S * 9 * k,
              vy: -(0.3 + Math.random()) * S * 14 * k,
              rot: 0,
              vr: (Math.random() - 0.5) * 14 * k,
              life: 0,
              max: 0.7 + Math.random() * 0.5,
              color, size, part: [px, py], parts,
            });
          }
        }
      }
    }
  }

  update(dt: number): void {
    const s = this.spring;
    const k = 220;
    const c = 16;
    s.vx += (-k * s.x - c * s.vx) * dt;
    s.vy += (-k * s.y - c * s.vy) * dt;
    s.vr += (-k * s.r - c * s.vr) * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.r += s.vr * dt;
    const q = this.squash;
    q.v += (-320 * q.s - 11 * q.v) * dt;
    q.s = Math.max(-0.2, Math.min(0.2, q.s + q.v * dt));
    const g = this.layout.S * 40;
    for (const f of this.fragments) {
      f.life += dt;
      f.vy += g * dt;
      f.vx *= 1 - 1.2 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vr * dt;
    }
    this.fragments = this.fragments.filter((f) => f.life < f.max);
    for (const w of this.shockwaves) w.t += dt;
    this.shockwaves = this.shockwaves.filter((w) => w.t < SHOCK_LIFE);
    for (const t of this.texts) t.t += dt;
    this.texts = this.texts.filter((t) => t.t < t.life);
    for (const f of this.flashes) f.t += dt;
    this.flashes = this.flashes.filter((f) => f.t < 0.25);
    for (const t of this.trails) t.t += dt;
    this.trails = this.trails.filter((t) => t.t < 0.22);
    if (this.bigText) {
      this.bigText.t += dt;
      if (this.bigText.t > 2) this.bigText = null;
    }
    // danger: stack height + pending garbage
    let top = BOARD_H;
    for (let y = BUFFER; y < BUFFER + BOARD_H; y++) {
      if (this.game.board[y].some((c) => c !== null)) {
        top = y - BUFFER;
        break;
      }
    }
    const effective = BOARD_H - top + Math.min(8, this.game.pendingGarbage());
    const target = effective > 15 ? Math.min(1, (effective - 15) / 4) : 0;
    this.danger += (target - this.danger) * Math.min(1, dt * 6);
    // heartbeat: lub-dub every 1.2 s once danger passes 0.5
    if (this.danger > 0.5 && this.motion > 0) {
      this.heartT = (this.heartT + dt) % 1.2;
      const beat = (at: number, w: number) => Math.exp(-(((this.heartT - at) / w) ** 2));
      const amp = ((this.danger - 0.5) / 0.5) * 0.022 * this.motion;
      this.heartbeat = amp * (beat(0.08, 0.05) + 0.65 * beat(0.32, 0.05));
    } else {
      this.heartT = 0;
      this.heartbeat = 0;
    }
    if (this.reduceMotion) {
      // settle instantly so toggling it mid-game leaves the board still
      this.spring = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 };
      this.squash = { s: 0, v: 0 };
      this.fragments = [];
      this.shockwaves = [];
    }
  }
}

const SHOCK_LIFE = 0.55;

export interface Flight {
  from: [number, number];
  to: [number, number];
  t: number;
  dur: number;
  amount: number;
  color: string;
}

export interface Overlay {
  countdown: string | null;
  countdownT: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private skin = new Skin();
  private dpr = 1;
  width = 0;
  height = 0;
  views: BoardView[] = [];
  flights: Flight[] = [];
  overlay: Overlay = { countdown: null, countdownT: 0 };
  gridOpacity = 0.1;
  shadowOpacity = 0.3;
  accent = "#3f6bff";
  private bgT = 0;
  private layer: HTMLCanvasElement | null = null; // offscreen, for translucent views

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.skin.clear();
    this.layoutViews();
  }

  layoutViews(): void {
    const n = this.views.length;
    if (!n) return;
    const W = this.width;
    const H = this.height;
    if (n === 2 && this.views[1].opts.ghost) {
      // the player's board exactly where it is alone, the ghost smaller in the space to its right
      const [player, ghost] = this.views;
      const S = Math.floor(Math.min((H * 0.86) / (BOARD_H + 3), (W * 0.94) / (BOARD_W + 13)));
      const bx = Math.round(W / 2 - (BOARD_W * S) / 2 + S * 0.5);
      const by = Math.round(H / 2 - (BOARD_H * S) / 2 + S * 0.6);
      player.layout = { bx, by, S };
      const left = bx + BOARD_W * S + S * 5.4; // right of the player's next column, plus a gap
      // ghost width: hold column 5.2 cells, board, next column 4.8 cells
      const gs = Math.max(4, Math.floor(Math.min(S * 0.62, (W - left - 12) / (BOARD_W + 10))));
      ghost.layout = { bx: Math.round(left + gs * 5.2), by: by + BOARD_H * (S - gs), S: gs };
    } else if (n === 1) {
      const S = Math.floor(Math.min((H * 0.86) / (BOARD_H + 3), (W * 0.94) / (BOARD_W + 13)));
      const bx = Math.round(W / 2 - (BOARD_W * S) / 2 + S * 0.5);
      const by = Math.round(H / 2 - (BOARD_H * S) / 2 + S * 0.6);
      this.views[0].layout = { bx, by, S };
    } else {
      const S = Math.floor(Math.min((H * 0.8) / (BOARD_H + 3), (W * 0.96) / (2 * (BOARD_W + 12) + 3)));
      const half = W / 2;
      this.views.forEach((v, i) => {
        // board centre sits slightly right of each half: stats/hold are wider than next
        const cx = i === 0 ? half / 2 + S * 0.9 : half + half / 2 + S * 0.3;
        v.layout = {
          bx: Math.round(cx - (BOARD_W * S) / 2),
          by: Math.round(H / 2 - (BOARD_H * S) / 2 + S * 0.6),
          S,
        };
      });
    }
  }

  /** Centre of a view's garbage meter, for attack flights. */
  meterPoint(v: BoardView): [number, number] {
    const { bx, by, S } = v.layout;
    return [bx - S * 0.45, by + BOARD_H * S * 0.75];
  }

  boardCentre(v: BoardView): [number, number] {
    const { bx, by, S } = v.layout;
    return [bx + (BOARD_W * S) / 2, by + (BOARD_H * S) / 2];
  }

  update(dt: number): void {
    this.bgT += dt;
    for (const v of this.views) v.update(dt);
    for (const f of this.flights) f.t += dt;
    this.flights = this.flights.filter((f) => f.t < f.dur);
    if (this.overlay.countdown) this.overlay.countdownT += dt;
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground();
    for (const v of this.views) {
      if (v.opts.ghost) this.drawFaded(v, GHOST_ALPHA);
      else this.drawView(v);
    }
    this.drawFlights();
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const { width: W, height: H } = this;
    ctx.fillStyle = "#08080f";
    ctx.fillRect(0, 0, W, H);
    // slow diagonal hatching tinted with the mode accent
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1;
    const gap = 46;
    const off = (this.bgT * 12) % gap;
    ctx.beginPath();
    for (let x = -H + off; x < W + H; x += gap) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x + H, H);
    }
    ctx.stroke();
    ctx.restore();
    // vignette
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  private mino(type: PieceType | "g", x: number, y: number, S: number, alpha = 1): void {
    const ctx = this.ctx;
    const px = Math.round(S * this.dpr);
    const sprite = this.skin.get(COLORS[type], px);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x, y, S, S);
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  private drawPiecePreview(type: PieceType, cx: number, cy: number, S: number, alpha = 1): void {
    const cells = SHAPES[type][0].cells;
    const xs = cells.map(([c]) => c);
    const ys = cells.map(([, r]) => r);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const ox = cx - (w * S) / 2 - Math.min(...xs) * S;
    const oy = cy - (h * S) / 2 - Math.min(...ys) * S;
    for (const [c, r] of cells) this.mino(type, ox + c * S, oy + r * S, S, alpha);
  }

  private label(text: string, x: number, y: number, S: number, align: CanvasTextAlign = "left", color = "rgba(255,255,255,0.55)"): void {
    const ctx = this.ctx;
    ctx.font = `600 ${Math.round(S * 0.62)}px ${BODY}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, y);
  }

  /** Draw a view on the offscreen layer, then the layer at `alpha`; name and marker stay opaque. */
  private drawFaded(v: BoardView, alpha: number): void {
    const main = this.ctx;
    const layer = (this.layer ??= document.createElement("canvas"));
    if (layer.width !== this.canvas.width || layer.height !== this.canvas.height) {
      layer.width = this.canvas.width;
      layer.height = this.canvas.height;
    }
    const lctx = layer.getContext("2d")!;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx = lctx;
    try {
      this.drawView(v, false);
    } finally {
      this.ctx = main;
    }
    main.save();
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalAlpha = alpha;
    main.drawImage(layer, 0, 0);
    main.restore();
    if (v.opts.label) this.drawName(v);
    if (v.marker) this.drawMarker(v);
  }

  private drawView(v: BoardView, names = true): void {
    const ctx = this.ctx;
    const g = v.game;
    const { bx, by, S } = v.layout;
    const bw = BOARD_W * S;
    const bh = BOARD_H * S;
    const s = v.spring;

    ctx.save();
    ctx.translate(bx + bw / 2 + s.x * 0.05, by + bh / 2 + s.y * 0.05);
    ctx.rotate(s.r * 0.15);
    // heartbeat pulses about the centre
    const hb = 1 + v.heartbeat;
    ctx.scale(hb, hb);
    // squash & stretch about the board bottom, keeping area constant
    const sy = 1 + v.squash.s;
    ctx.translate(0, bh / 2);
    ctx.scale(1 / sy, sy);
    ctx.translate(0, -bh / 2);
    ctx.translate(-(bx + bw / 2), -(by + bh / 2));

    // board well
    ctx.fillStyle = "rgba(0,0,0,0.82)";
    ctx.fillRect(bx, by, bw, bh);
    // grid
    ctx.strokeStyle = `rgba(255,255,255,${this.gridOpacity})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < BOARD_W; x++) {
      ctx.moveTo(bx + x * S + 0.5, by);
      ctx.lineTo(bx + x * S + 0.5, by + bh);
    }
    for (let y = 1; y < BOARD_H; y++) {
      ctx.moveTo(bx, by + y * S + 0.5);
      ctx.lineTo(bx + bw, by + y * S + 0.5);
    }
    ctx.stroke();

    // stack (including buffer rows peeking above the board)
    const rowTop = BUFFER - 3;
    for (let y = rowTop; y < BUFFER + BOARD_H; y++) {
      const row = g.board[y];
      for (let x = 0; x < BOARD_W; x++) {
        const c: Cell = row[x];
        if (c) this.mino(c, bx + x * S, by + (y - BUFFER) * S, S, y < BUFFER ? 0.6 : 1);
      }
    }

    // drop trails
    for (const t of v.trails) {
      const a = 1 - t.t / 0.22;
      for (const [x, top] of t.cols) {
        const y1 = by + (top - BUFFER) * S;
        const grad = ctx.createLinearGradient(0, y1 - S * 5, 0, y1);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(1, t.color);
        ctx.globalAlpha = a * 0.55;
        ctx.fillStyle = grad;
        ctx.fillRect(bx + x * S + S * 0.15, y1 - S * 5, S * 0.7, S * 5);
      }
      ctx.globalAlpha = 1;
    }

    if (!g.over) {
      const p = g.piece;
      // ghost
      const gy = g.ghostY();
      for (const [x, y] of g.cellsOf(p.type, p.x, gy, p.r)) {
        if (y < rowTop) continue;
        const px = bx + x * S;
        const py = by + (y - BUFFER) * S;
        ctx.fillStyle = COLORS[p.type];
        ctx.globalAlpha = this.shadowOpacity;
        ctx.fillRect(px, py, S, S);
        ctx.globalAlpha = 1;
      }
      // active piece; lock-delay fades it slightly toward white
      const lockPct = Math.min(1, p.locking / g.opts.locktime);
      for (const [x, y] of g.cellsOf(p.type, p.x, p.y, p.r)) {
        if (y < rowTop) continue;
        this.mino(p.type, bx + x * S, by + (y - BUFFER) * S, S);
        if (lockPct > 0) {
          ctx.fillStyle = `rgba(255,255,255,${lockPct * 0.35})`;
          ctx.fillRect(bx + x * S, by + (y - BUFFER) * S, S, S);
        }
      }
    }

    // line clear flashes
    for (const f of v.flashes) {
      const a = 1 - f.t / 0.25;
      ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
      for (const r of f.rows) {
        const h = S * (1 - f.t / 0.25);
        ctx.fillRect(bx, by + (r - BUFFER) * S + (S - h) / 2, bw, h);
      }
    }

    // shockwaves from spin and B2B clears, kept inside the well
    if (v.shockwaves.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by - S * 3, bw, bh + S * 3);
      ctx.clip();
      for (const w of v.shockwaves) {
        const p = w.t / SHOCK_LIFE;
        const e = 1 - (1 - p) ** 3;
        ctx.globalAlpha = (1 - p) * Math.min(1, 0.55 * w.strength);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = S * 0.5 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(bx + bw / 2, by + w.y, S * (0.5 + 8 * w.strength * e), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // board frame
    const danger = v.danger;
    ctx.strokeStyle = danger > 0.02 ? `rgba(255,${Math.round(255 * (1 - danger))},${Math.round(255 * (1 - danger))},0.95)` : "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(2, S * 0.1);
    ctx.beginPath();
    ctx.moveTo(bx - 1, by);
    ctx.lineTo(bx - 1, by + bh + 1);
    ctx.lineTo(bx + bw + 1, by + bh + 1);
    ctx.lineTo(bx + bw + 1, by);
    ctx.stroke();
    if (danger > 0.02) {
      ctx.shadowColor = "#ff2040";
      ctx.shadowBlur = S * 1.2 * danger * (0.6 + 0.4 * Math.sin(this.bgT * 9));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    this.drawMeter(v);
    this.drawHold(v);
    this.drawNext(v);

    // fragments of cleared cells
    const px = Math.round(S * this.dpr);
    for (const f of v.fragments) {
      const sprite = this.skin.get(f.color, px);
      const src = px / f.parts;
      ctx.globalAlpha = Math.min(1, 2 * (1 - f.life / f.max));
      ctx.save();
      ctx.translate(bx + f.x, by + f.y);
      ctx.rotate(f.rot);
      ctx.drawImage(sprite, f.part[0] * src, f.part[1] * src, src, src, -f.size / 2, -f.size / 2, f.size, f.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    ctx.restore();

    this.drawStats(v);
    this.drawActionText(v);
    if (v.bigText) {
      const t = v.bigText.t;
      const a = t < 0.15 ? t / 0.15 : t > 1.5 ? 1 - (t - 1.5) / 0.5 : 1;
      const sc = 1 + Math.max(0, 0.25 - t) * 2;
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.translate(bx + bw / 2, by + bh * 0.42);
      ctx.scale(sc, sc);
      ctx.font = `${Math.round(S * 1.9)}px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.fillStyle = v.bigText.color;
      ctx.shadowColor = v.bigText.color;
      ctx.shadowBlur = S;
      for (const [i, line] of v.bigText.text.split(" ").entries()) ctx.fillText(line, 0, i * S * 2);
      ctx.restore();
    }
    if (this.overlay.countdown && v === this.views[0]) this.drawCountdown(v);
    if (names && v.opts.label) this.drawName(v);
  }

  private drawMarker(v: BoardView): void {
    const { bx, by, S } = v.layout;
    const ctx = this.ctx;
    ctx.font = `${Math.round(S * 1.1)}px ${DISPLAY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = v.opts.accent;
    ctx.fillText(v.marker!, bx + (BOARD_W * S) / 2, by - S * 1.6);
  }

  private drawName(v: BoardView): void {
    const { bx, by, S } = v.layout;
    const ctx = this.ctx;
    ctx.font = `${Math.round(S * 0.8)}px ${DISPLAY}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(v.opts.label!, bx + (BOARD_W * S) / 2, by + BOARD_H * S + S * 1.4);
  }

  private drawMeter(v: BoardView): void {
    const ctx = this.ctx;
    const { bx, by, S } = v.layout;
    const g = v.game;
    if (!g.opts.hasgarbage) return;
    const w = S * 0.32;
    const x = bx - w - S * 0.18;
    const bottom = by + BOARD_H * S;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, by, w, BOARD_H * S);
    let y = bottom;
    for (const inc of g.incoming) {
      const h = Math.min(inc.amount, Math.max(0, (y - by) / S)) * S;
      const ready = inc.readyAt <= g.frame;
      ctx.fillStyle = ready ? "#ff2a3c" : "#ff9a3c";
      ctx.fillRect(x, y - h, w, h - 1);
      y -= h;
      if (y <= by) break;
    }
    // cap marker
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(x - S * 0.1, bottom - g.opts.garbagecap * S, w + S * 0.2, 1);
  }

  private drawHold(v: BoardView): void {
    const { bx, by, S } = v.layout;
    const g = v.game;
    const ps = v.opts.compact ? S * 0.6 : S * 0.75;
    const w = S * 4.4;
    const x = bx - w - S * 0.8;
    this.label("HOLD", x + S * 0.1, by - S * 0.25, S);
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(x, by, w, S * 3);
    if (g.hold) this.drawPiecePreview(g.hold, x + w / 2, by + S * 1.5, ps, g.holdLocked ? 0.3 : 1);
  }

  private drawNext(v: BoardView): void {
    const { bx, by, S } = v.layout;
    const g = v.game;
    const x = bx + BOARD_W * S + S * 0.4;
    const w = S * 4.4;
    const count = v.opts.compact ? 3 : g.opts.nextcount;
    this.label("NEXT", x + S * 0.1, by - S * 0.25, S);
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(x, by, w, S * (count * 2.8 + 0.4));
    const ps = S * 0.75;
    for (let i = 0; i < count; i++) {
      this.drawPiecePreview(g.queue[i], x + w / 2, by + S * (1.6 + i * 2.8), ps);
    }
  }

  private drawStats(v: BoardView): void {
    const ctx = this.ctx;
    const { bx, by, S } = v.layout;
    const g = v.game;
    const x = bx - S * 1.1;
    let y = by + BOARD_H * S - S * 0.2;
    const secs = g.frame / 60;
    const rows: [string, string, string?][] = [];
    const time = formatTime(g.frame);
    if (v.opts.mode === "40l") {
      rows.push(["TIME", time.main, time.ms]);
      rows.push(["LINES", `${g.stats.lines}`, `/${v.opts.objectiveLines ?? 40}`]);
      rows.push(["PIECES", `${g.stats.pieces}`, `${g.pps().toFixed(2)}/S`]);
      rows.push(["FINESSE", `${g.stats.finesse}`]);
    } else if (v.opts.mode === "blitz") {
      const left = Math.max(0, 120 - secs);
      const t = formatTime(left * 60);
      rows.push(["SCORE", g.stats.score.toLocaleString("en-US")]);
      rows.push(["TIME LEFT", t.main, t.ms]);
      rows.push(["LEVEL", `${g.stats.level}`, `${g.stats.levelLines}/${g.stats.levelLinesNeeded}`]);
      rows.push(["PIECES", `${g.stats.pieces}`, `${g.pps().toFixed(2)}/S`]);
    } else if (v.opts.mode === "vs") {
      rows.push(["ATTACK", `${g.stats.attack}`, `${g.apm().toFixed(1)}/M`]);
      rows.push(["PIECES", `${g.stats.pieces}`, `${g.pps().toFixed(2)}/S`]);
      if (!v.opts.compact) rows.push(["TIME", time.main, time.ms]);
    } else {
      rows.push(["LINES", `${g.stats.lines}`]);
      rows.push(["SCORE", g.stats.score.toLocaleString("en-US")]);
      rows.push(["PIECES", `${g.stats.pieces}`, `${g.pps().toFixed(2)}/S`]);
      rows.push(["TIME", time.main]);
    }
    // bottom-up, right aligned against the meter, TETR.IO-style big numbers
    for (const [label, value, sub] of rows.reverse()) {
      ctx.textAlign = "right";
      ctx.font = `${Math.round(S * 1.15)}px ${DISPLAY}`;
      const subW = sub ? (ctx.font = `${Math.round(S * 0.62)}px ${DISPLAY}`, ctx.measureText(sub).width + S * 0.15) : 0;
      ctx.font = `${Math.round(S * 1.15)}px ${DISPLAY}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(value, x - subW, y);
      if (sub) {
        ctx.font = `${Math.round(S * 0.62)}px ${DISPLAY}`;
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(sub, x, y);
      }
      this.label(label, x, y - S * 1.15, S, "right");
      y -= S * 2.35;
    }
  }

  private drawActionText(v: BoardView): void {
    const ctx = this.ctx;
    const { bx, by, S } = v.layout;
    const x = bx - S * 1.1;
    let y = by + S * 6.2;
    for (const t of v.texts) {
      const a = t.t < 0.08 ? t.t / 0.08 : t.t > t.life - 0.4 ? (t.life - t.t) / 0.4 : 1;
      const slide = Math.max(0, 0.12 - t.t) * S * 8;
      ctx.globalAlpha = Math.max(0, a);
      for (const line of t.lines) {
        ctx.font = `${Math.round(S * line.size)}px ${DISPLAY}`;
        ctx.textAlign = "right";
        ctx.fillStyle = line.color;
        ctx.fillText(line.text, x + slide, y);
        y += S * line.size * 1.05;
      }
      y += S * 0.45;
      ctx.globalAlpha = 1;
    }
  }

  private drawCountdown(v: BoardView): void {
    const ctx = this.ctx;
    const { bx, by, S } = v.layout;
    const t = this.overlay.countdownT;
    const sc = 1 + Math.max(0, 0.2 - t) * 2.5;
    ctx.save();
    ctx.translate(bx + (BOARD_W * S) / 2, by + BOARD_H * S * 0.45);
    ctx.scale(sc, sc);
    ctx.font = `${Math.round(S * 2.4)}px ${DISPLAY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = this.accent;
    ctx.shadowBlur = S * 1.5;
    ctx.fillText(this.overlay.countdown!, 0, 0);
    ctx.restore();
  }

  private drawFlights(): void {
    const ctx = this.ctx;
    for (const f of this.flights) {
      const p = f.t / f.dur;
      const e = p * p * (3 - 2 * p);
      const [x0, y0] = f.from;
      const [x1, y1] = f.to;
      const cx = (x0 + x1) / 2;
      const cy = Math.min(y0, y1) - 160;
      const pt = (u: number): [number, number] => [
        (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1,
        (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1,
      ];
      const r = 4 + Math.min(f.amount, 12);
      for (let i = 0; i < 8; i++) {
        const u = Math.max(0, e - i * 0.03);
        const [x, y] = pt(u);
        ctx.globalAlpha = (1 - i / 8) * 0.8;
        ctx.fillStyle = i === 0 ? "#ffffff" : f.color;
        ctx.beginPath();
        ctx.arc(x, y, r * (1 - i / 10), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

export function formatTime(frames: number): { main: string; ms: string } {
  const total = Math.max(0, frames / 60);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total * 1000) % 1000);
  return { main: `${m}:${String(s).padStart(2, "0")}`, ms: `.${String(ms).padStart(3, "0")}` };
}
