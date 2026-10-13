// Authoritative logic for one online VS match. Runtime-independent: the Durable Object in
// worker/index.ts owns the WebSockets and feeds this module, and the tests drive it with
// fake connections and a fake clock. There is no tick: engines advance when a message
// arrives, either to an accepted input's frame or, for a player who has fallen behind the
// server clock, up to the lag limit (so nobody can stall a match by going quiet).
//
// Wire format is the Ribbon envelope from the old server, {t, s, a, d}: type, sequence id
// (per slot, increments per packet sent), ack (last `s` received from the other side) and
// payload. The last 100 packets per slot are kept so a reconnecting client can catch up.

import { Action, Game } from "../engine/game";
import { modeById } from "../modes";

export const MAX_MESSAGE_BYTES = 1024;
export const SEND_BUFFER = 100;
export const FRAME_TOLERANCE = 30; // frames an input may be ahead of the server's clock
export const MAX_INPUTS_PER_SECOND = 60;
export const MAX_REJECTED = 20; // rejected messages before the connection is dropped
export const RECONNECT_GRACE_MS = 15000;
export const MAX_LAG_FRAMES = 120; // frames an input (or an engine) may trail the server's clock
export const RESUME_TIMEOUT_MS = 5000; // an extra socket must `resume` within this time
export const MAX_PENDING = 2; // extra sockets waiting to `resume` at once
export const LOBBY_TIMEOUT_MS = 120_000; // a match without an opponent by then is reset
export const IDLE_TIMEOUT_MS = 60_000; // a started match where nobody sends anything for this long ends

const ACTIONS: readonly string[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];

/** Fixed VS rules; clients can't choose them. The seed is added at start. */
export function matchOptions(seed: number) {
  return modeById("vs").options(seed);
}

export interface Envelope {
  t: string;
  s: number;
  a: number;
  d?: unknown;
}

/** One WebSocket as seen by the match. */
export interface Peer {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface Clock {
  now(): number; // ms
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Random {
  seed(): number; // 1 .. 2^31 - 2
  token(): string;
}

export const cryptoRandom: Random = {
  seed: () => (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1,
  token: () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""),
};

export type SlotIndex = 0 | 1;

interface Slot {
  index: SlotIndex;
  token: string;
  conn: Conn | null;
  seq: number; // last `s` sent
  ack: number; // last `s` received
  buffer: Envelope[];
  game: Game | null;
  lastFrame: number;
  recent: number[]; // clock times of inputs accepted in the last second
  grace: unknown; // forfeit timer while disconnected mid-match
}

/** Opaque handle for one socket, returned by `connect`. */
export interface Conn {
  readonly peer: Peer;
  slot: Slot | null;
  rejected: number;
  closed: boolean;
  timer: unknown; // resume deadline while the socket holds no slot
}

type Message = { t: string; s?: unknown; d?: unknown };

/** Resume credentials given at upgrade time (`?resume=<token>&ack=<peerAck>`). */
export interface ResumeRequest {
  token: string;
  peerAck: number;
}

export class MatchSession {
  private slots: Slot[] = [];
  private startedAt = 0;
  private started = false;
  private ended = false;
  private pending = new Set<Conn>(); // sockets without a slot, waiting to `resume`
  private lobby: unknown = null; // resets the match if it has not started in time
  private idle: unknown = null; // ends a started match nobody is talking in
  private lastActive = 0; // clock time of the last valid message from a player
  private garbageOut: { slot: Slot; amount: number; frame: number }[] = [];

  constructor(private clock: Clock, private random: Random = cryptoRandom) {}

  /** The server's engine for a player, once the match has started. */
  game(index: SlotIndex): Game | null {
    return this.slots[index]?.game ?? null;
  }

  get isOver(): boolean {
    return this.ended;
  }

  /** Whether `token` belongs to a slot, so the adapter can refuse a bad `?resume=` before accepting. */
  hasToken(token: string): boolean {
    return this.slots.some((s) => s.token === token);
  }

  /**
   * A new socket. With `resume` (the token from the upgrade URL) the socket rebinds that slot
   * at once and never waits among the pending sockets, so others can't crowd the owner out.
   */
  connect(peer: Peer, resume?: ResumeRequest): Conn {
    const conn: Conn = { peer, slot: null, rejected: 0, closed: false, timer: null };
    if (this.ended) {
      this.reject(conn, "ended", "the match is over");
    } else if (resume) {
      this.resume(conn, resume);
    } else if (this.slots.length < 2) {
      const slot: Slot = {
        index: this.slots.length as SlotIndex, token: this.random.token(), conn, seq: 0, ack: 0,
        buffer: [], game: null, lastFrame: 0, recent: [], grace: null,
      };
      this.slots.push(slot);
      conn.slot = slot;
      this.send(slot, "welcome", { slot: slot.index, token: slot.token });
      if (slot.index === 0) this.lobby = this.clock.setTimeout(() => this.reset(), LOBBY_TIMEOUT_MS);
      this.maybeStart();
    } else if (!this.slots.some((s) => s.conn === null)) {
      this.reject(conn, "full", "match is full");
    } else if (this.pending.size >= MAX_PENDING) {
      this.reject(conn, "busy", "too many sockets waiting to resume");
    } else {
      // a slot is free: the socket waits unbound until it sends `resume`
      this.pending.add(conn);
      conn.timer = this.clock.setTimeout(() => {
        conn.timer = null;
        this.reject(conn, "resume-timeout", "send resume first");
      }, RESUME_TIMEOUT_MS);
    }
    return conn;
  }

  message(conn: Conn, data: string | ArrayBuffer): void {
    if (conn.closed) return;
    this.catchUp(MAX_LAG_FRAMES);
    if (conn.closed) return; // the catch-up ended the match
    const msg = parse(data);
    if (typeof msg === "string") return this.reject(conn, msg, "unreadable message");
    const slot = conn.slot;
    if (slot && Number.isSafeInteger(msg.s) && (msg.s as number) > slot.ack) slot.ack = msg.s as number;
    switch (msg.t) {
      case "ping":
        if (slot) {
          this.lastActive = this.clock.now();
          this.send(slot, "pong");
        } else conn.peer.send(JSON.stringify({ t: "pong", s: 0, a: 0 }));
        return;
      case "resume":
        return this.resume(conn, msg.d);
      case "input":
        return this.input(conn, msg.d);
      default:
        return this.reject(conn, "bad-type", "unknown message type");
    }
  }

  disconnect(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.unpend(conn);
    const slot = conn.slot;
    if (!slot) return;
    conn.slot = null;
    slot.conn = null;
    if (!this.started || this.ended) return;
    const other = this.other(slot);
    this.send(other, "opponentDisconnected", { grace: RECONNECT_GRACE_MS });
    slot.grace = this.clock.setTimeout(() => {
      slot.grace = null;
      this.finish(other.index, "disconnect");
    }, RECONNECT_GRACE_MS);
  }

  // ---------------------------------------------------------------- internals

  private unpend(conn: Conn): void {
    this.pending.delete(conn);
    if (conn.timer !== null) this.clock.clearTimeout(conn.timer);
    conn.timer = null;
  }

  /** Close every socket the match knows about; ones still waiting to resume get an `error` first. */
  private closeAll(code: number, reason: string, message: string): void {
    for (const conn of [...this.pending]) this.reject(conn, reason, message);
    for (const slot of this.slots) if (slot.conn) this.drop(slot.conn, code, reason);
  }

  /** Nobody joined in time: close the lone player's socket and start over, so the id can be reused. */
  private reset(): void {
    this.lobby = null;
    if (this.started) return;
    for (const slot of this.slots) if (slot.conn) this.send(slot, "error", { code: "no-opponent", message: "nobody joined" });
    this.closeAll(1000, "no-opponent", "nobody joined");
    this.slots = [];
  }

  /**
   * Fires IDLE_TIMEOUT_MS after the last valid player message (one timer, re-armed for the
   * remainder when there was activity since). On expiry both engines run to the clock, so a
   * top-out still decides the match; otherwise it ends as a draw.
   */
  private armIdle(ms: number): void {
    this.idle = this.clock.setTimeout(() => {
      this.idle = null;
      if (this.ended) return;
      const left = this.lastActive + IDLE_TIMEOUT_MS - this.clock.now();
      if (left > 0) return this.armIdle(left);
      this.catchUp(0);
      this.finish(null, "idle");
    }, ms);
  }

  private wallFrame(): number {
    return ((this.clock.now() - this.startedAt) * 60) / 1000;
  }

  /**
   * Bring any engine that trails the server clock by more than `lag` frames up to that
   * limit, as if the player had pressed nothing. The target is a whole frame so the engine's
   * per-frame steps are the same as if the next input had advanced it. Lagging engines move
   * together one frame at a time and stop at the first top-out, so whoever tops out first loses.
   */
  private catchUp(lag: number): void {
    if (!this.started || this.ended) return;
    const target = Math.floor(this.wallFrame() - lag);
    const games = this.slots.map((s) => s.game!).filter((g) => g.frame < target);
    if (games.length === 0) return;
    for (let f = Math.floor(Math.min(...games.map((g) => g.frame))) + 1; f <= target; f++) {
      for (const g of games) if (g.frame < f) g.advance(f - g.frame);
      if (games.some((g) => g.over)) break;
    }
    this.settle();
  }

  /** Send garbage queued by attacks, then end the match if an engine has topped out. */
  private settle(): void {
    const garbage = this.garbageOut;
    this.garbageOut = [];
    for (const g of garbage) this.send(g.slot, "garbage", { amount: g.amount, frame: g.frame });
    // VS has no objective, so over = topped out; both on the same catch-up frame is a draw
    const out = this.slots.filter((s) => s.game?.over);
    if (out.length === 1) this.finish(this.other(out[0]).index, "topout");
    else if (out.length === 2) this.finish(null, "topout");
  }

  private other(slot: Slot): Slot {
    return this.slots[1 - slot.index];
  }

  private send(slot: Slot, t: string, d?: unknown): void {
    const pkt: Envelope = { t, s: ++slot.seq, a: slot.ack, d };
    slot.buffer.push(pkt);
    if (slot.buffer.length > SEND_BUFFER) slot.buffer.shift();
    slot.conn?.peer.send(JSON.stringify(pkt));
  }

  /** Send an `error`. Unbound sockets are closed at once; bound ones after too many. */
  private reject(conn: Conn, code: string, message: string): void {
    if (conn.closed) return;
    if (conn.slot) this.send(conn.slot, "error", { code, message });
    else conn.peer.send(JSON.stringify({ t: "error", s: 0, a: 0, d: { code, message } }));
    if (!conn.slot || ++conn.rejected > MAX_REJECTED) this.drop(conn, 1008, code);
  }

  private drop(conn: Conn, code: number, reason: string): void {
    try {
      conn.peer.close(code, reason);
    } finally {
      this.disconnect(conn);
    }
  }

  private maybeStart(): void {
    if (this.started || this.slots.length < 2 || this.slots.some((s) => s.conn === null)) return;
    this.started = true;
    this.startedAt = this.lastActive = this.clock.now();
    if (this.lobby !== null) this.clock.clearTimeout(this.lobby);
    this.lobby = null;
    this.armIdle(IDLE_TIMEOUT_MS);
    const seed = this.random.seed();
    const options = matchOptions(seed);
    for (const slot of this.slots) {
      const game = new Game(options);
      game.onAttack = (amount) => {
        const target = this.other(slot);
        if (!target.game) return;
        target.game.receive(amount);
        this.garbageOut.push({ slot: target, amount, frame: target.game.frame });
      };
      slot.game = game;
    }
    for (const slot of this.slots) this.send(slot, "start", { seed, options });
  }

  private resume(conn: Conn, d: unknown): void {
    if (conn.slot) return this.reject(conn, "already-bound", "this socket already holds a slot");
    if (!isObject(d) || typeof d.token !== "string" || !Number.isSafeInteger(d.peerAck) || (d.peerAck as number) < 0) {
      return this.reject(conn, "bad-message", "resume needs {token, peerAck}");
    }
    const slot = this.slots.find((s) => s.token === d.token);
    if (!slot) return this.reject(conn, "bad-token", "unknown resume token");
    const peerAck = d.peerAck as number;
    this.unpend(conn);
    this.lastActive = this.clock.now();

    if (slot.conn) {
      // the client reconnected before the old socket's close reached us
      const old = slot.conn;
      old.slot = null;
      this.drop(old, 1000, "replaced");
    }
    slot.conn = conn;
    conn.slot = slot;
    const wasAway = slot.grace !== null;
    if (wasAway) {
      this.clock.clearTimeout(slot.grace);
      slot.grace = null;
    }

    const first = slot.buffer.length ? slot.buffer[0].s : slot.seq + 1;
    if (peerAck > slot.seq || peerAck + 1 < first) {
      this.send(slot, "error", { code: "resync", message: "missed packets are no longer buffered" });
    } else {
      for (const pkt of slot.buffer) {
        if (pkt.s > peerAck) conn.peer.send(JSON.stringify({ ...pkt, a: slot.ack }));
      }
    }
    if (wasAway && !this.ended) this.send(this.other(slot), "opponentReconnected");
    this.maybeStart();
  }

  private input(conn: Conn, d: unknown): void {
    const slot = conn.slot;
    if (!slot) return this.reject(conn, "not-joined", "send resume first");
    if (this.ended) return;
    const game = slot.game;
    if (!game) return this.reject(conn, "not-started", "the match has not started");
    if (
      !isObject(d) || typeof d.action !== "string" || !ACTIONS.includes(d.action) ||
      (d.kind !== "press" && d.kind !== "release") || typeof d.frame !== "number" || !Number.isFinite(d.frame)
    ) {
      return this.reject(conn, "bad-input", "input needs {frame, action, kind}");
    }
    const frame = d.frame;
    if (frame < slot.lastFrame) return this.reject(conn, "frame-behind", "frame is before the last accepted input");
    const now = this.clock.now();
    const wall = this.wallFrame();
    if (frame > wall + FRAME_TOLERANCE) return this.reject(conn, "frame-ahead", "frame is ahead of the server clock");
    if (frame < wall - MAX_LAG_FRAMES) return this.reject(conn, "frame-late", "frame is too far behind the server clock");
    slot.recent = slot.recent.filter((t) => t > now - 1000);
    if (slot.recent.length >= MAX_INPUTS_PER_SECOND) return this.reject(conn, "rate-limit", "too many inputs");

    slot.recent.push(now);
    this.lastActive = now;
    slot.lastFrame = frame;
    const action = d.action as Action;
    game.advance(frame - game.frame);
    if (d.kind === "press") game.press(action);
    else game.release(action);

    this.send(this.other(slot), "opponentInput", { frame, action, kind: d.kind });
    this.settle();
  }

  /** `winner` is null for a draw (an idle match). */
  private finish(winner: SlotIndex | null, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.idle !== null) this.clock.clearTimeout(this.idle);
    this.idle = null;
    for (const slot of this.slots) {
      if (slot.grace !== null) this.clock.clearTimeout(slot.grace);
      slot.grace = null;
      if (slot.game) slot.game.onAttack = null;
    }
    for (const slot of this.slots) this.send(slot, "end", { winner, reason });
    this.closeAll(1000, "ended", "the match is over");
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode one client frame, or return an error code. Never throws. */
function parse(data: string | ArrayBuffer): Message | string {
  const size = typeof data === "string" ? data.length : data.byteLength;
  if (size > MAX_MESSAGE_BYTES) return "too-large";
  if (typeof data !== "string") return "bad-json";
  if (new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES) return "too-large";
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return "bad-json";
  }
  if (!isObject(v) || typeof v.t !== "string") return "bad-message";
  return v as Message;
}
