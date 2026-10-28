// Authoritative logic for one online VS match. Runtime-independent: the Durable Object in
// worker/index.ts owns the WebSockets and feeds this module, and the tests drive it with
// fake connections and a fake clock. There is no tick: engines advance when a message
// arrives, either to an accepted input's frame (snapped to the 1/256-frame grid, stepping.ts)
// or, for a player who has fallen behind the server clock, up to the lag limit (so nobody can
// stall a match by going quiet).
//
// Wire format is the Ribbon envelope from the old server, {t, s, a, d}: type, sequence id
// (per slot, increments per packet sent), ack (last `s` received from the other side) and
// payload. The last 100 packets per slot are kept so a reconnecting client can catch up.
//
// A ranked match (opened by the matchmaker, accounts.ts) is given the two accounts allowed to
// play it and a `report` callback. Only those accounts take its slots, and when it finishes the
// result is reported once and `end` waits for the new ratings (REPORT_TIMEOUT_MS at most).
// Its lobby waits only RANKED_LOBBY_TIMEOUT_MS (the queue just told both players to connect); if
// only one account arrived by then, the absent one is reported with `noShow`.
//
// A started ranked match can be watched (`connectSpectator`): spectators hold no slot and send
// nothing but `ping`. The match keeps a log of the inputs and garbage its engines applied, in
// engine order (MAX_SPECTATE_EVENTS at most); a spectator gets `start`'s data and the log so far in
// one `spectate` message, then each new entry as a `specEvent`, and replays both boards from them.

import { Action, DEFAULT_HANDLING, Game, Handling } from "../engine/game";
import { stepTo, stepToClock } from "../engine/stepping";
import { modeById } from "../modes";

export const MAX_MESSAGE_BYTES = 1024;
export const SEND_BUFFER = 100;
export const FRAME_TOLERANCE = 30; // frames an input may be ahead of the server's clock
// Inputs are metered by a token bucket: INPUT_BURST may arrive at once, then MAX_INPUTS_PER_SECOND
// on average. The client paces itself with a smaller burst at the same rate (online.ts), so packets
// network jitter bunches together still fit (README "Game server").
export const MAX_INPUTS_PER_SECOND = 60;
export const INPUT_BURST = 90;
export const MAX_REJECTED = 20; // rejected messages before the connection is dropped
export const RECONNECT_GRACE_MS = 15000;
export const MAX_LAG_FRAMES = 120; // frames an input (or an engine) may trail the server's clock
export const RESUME_TIMEOUT_MS = 5000; // an extra socket must `resume` within this time
export const MAX_PENDING = 2; // extra sockets waiting to `resume` at once
export const LOBBY_TIMEOUT_MS = 120_000; // a match without an opponent by then is reset
export const RANKED_LOBBY_TIMEOUT_MS = 30_000; // the same for a ranked room
export const IDLE_TIMEOUT_MS = 60_000; // a started match where nobody sends anything for this long ends
export const REPORT_TIMEOUT_MS = 3000; // a ranked `end` waits this long for the ratings at most
export const MAX_SPECTATORS = 50; // sockets watching one match at once
export const MAX_SPECTATE_EVENTS = 20_000; // log entries kept for spectators; a longer match takes no new ones

/** Room codes (= match ids) are issued by `POST /api/room`: 6 symbols, no 0/O, 1/I/L look-alikes. */
export const ROOM_CLAIM_MS = LOBBY_TIMEOUT_MS; // an issued code must be created within this time
export const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** A fresh room code from `crypto.getRandomValues`, without modulo bias (bytes from 248 up are redrawn). */
export function newRoomCode(): string {
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  let code = "";
  while (code.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b < limit && code.length < 6) code += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
    }
  }
  return code;
}

const ACTIONS: readonly string[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];

/** Fixed VS rules; clients can't choose them. The seed is added at start. */
export function matchOptions(seed: number) {
  return modeById("vs").options(seed);
}

/**
 * The handling the server's engines replay inputs with, sent in `start`. IRS and IHS act on
 * keys held at a spawn, so a client must use these values (not its own settings) to stay in sync.
 */
export const MATCH_HANDLING: Handling = { ...DEFAULT_HANDLING };

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

/** One player's rating after a ranked match: TR (null while hidden) and its change (null unless both TRs are visible). */
export interface SlotRating {
  tr: number | null;
  delta: number | null;
}

/** What makes a match ranked. The client never reports a result: `report` is called by `finish` only. */
export interface RankedConfig {
  accounts: readonly [string, string]; // account keys allowed to take a slot, one each
  /** Rate the result (`winner` null for a draw); resolves with each slot's rating, by slot index, or null. */
  report(winner: SlotIndex | null): Promise<readonly [SlotRating, SlotRating] | null>;
  /** The lobby timed out with only one account connected: `absent` never came. Not waited on; failures are ignored. */
  noShow(absent: string): Promise<unknown>;
  /** The match started (true) or finished (false), for the live list. Not waited on; failures are ignored. */
  live?(on: boolean): Promise<unknown> | void;
}

/**
 * One entry of the spectator log: an input a slot's engine applied at `frame` (as relayed in
 * `opponentInput`), or garbage slot `slot` received at `frame` (as in `garbage`/`opponentGarbage`).
 */
export type SpectateEvent =
  | { k: "input"; slot: SlotIndex; frame: number; action: Action; kind: "press" | "release" }
  | { k: "garbage"; slot: SlotIndex; amount: number; frame: number };

interface Slot {
  index: SlotIndex;
  token: string;
  account: string | null; // ranked: the account key holding the slot
  conn: Conn | null;
  seq: number; // last `s` sent
  ack: number; // last `s` received
  buffer: Envelope[];
  game: Game | null;
  lastFrame: number;
  budget: number; // inputs the slot may still send now (the token bucket)
  budgetAt: number; // clock time `budget` was last brought up to date
  grace: unknown; // forfeit timer while disconnected mid-match
}

/** Opaque handle for one socket, returned by `connect` (or `connectSpectator`). */
export interface Conn {
  readonly peer: Peer;
  slot: Slot | null;
  rejected: number;
  closed: boolean;
  timer: unknown; // resume deadline while the socket holds no slot
  spectator: boolean; // watching: never holds a slot, only pings
  seq: number; // a spectator's last `s` sent
}

type Message = { t: string; s?: unknown; d?: unknown };

/** Resume credentials given at upgrade time (the `resume.<token>.<peerAck>` subprotocol, see `resumeRequest`). */
export interface ResumeRequest {
  token: string;
  peerAck: number;
}

/** The subprotocol every resume offers next to `resume.<token>.<peerAck>`, and the only one the server answers with. */
export const PROTOCOL = "teza";
const RESUME_PROTOCOL = /^resume\.([0-9a-f]{32})\.([0-9]{1,15})$/;

function offeredProtocols(headers: Headers): string[] {
  return (headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Resume credentials from an upgrade's `Sec-WebSocket-Protocol: teza, resume.<32 hex>.<ack digits>`,
 * so the token never appears in a URL (and so not in request logs). Undefined without a `resume`
 * subprotocol; null if it is malformed, offered twice, or offered without `teza`.
 */
export function resumeRequest(headers: Headers): ResumeRequest | undefined | null {
  const offered = offeredProtocols(headers);
  const resumes = offered.filter((p) => p.startsWith("resume"));
  if (resumes.length === 0) return undefined;
  const m = resumes.length === 1 ? RESUME_PROTOCOL.exec(resumes[0]) : null;
  if (!m || !offered.includes(PROTOCOL)) return null;
  return { token: m[1], peerAck: Number(m[2]) };
}

/** Headers for the 101: `Sec-WebSocket-Protocol: teza` if the client offered it, never the resume token. */
export function upgradeHeaders(request: Headers): Headers {
  const headers = new Headers();
  if (offeredProtocols(request).includes(PROTOCOL)) headers.set("Sec-WebSocket-Protocol", PROTOCOL);
  return headers;
}

/**
 * Compares two strings in time that depends only on their length: every char code is XORed in,
 * with no early exit on the first difference. False if the lengths differ.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  private spectators = new Set<Conn>();
  private log: SpectateEvent[] = []; // what the engines applied, for spectators (emptied at the end)
  private startData: { seed: number; options: ReturnType<typeof matchOptions>; handling: Handling } | null = null;

  constructor(private clock: Clock, private random: Random = cryptoRandom, private ranked: RankedConfig | null = null) {}

  get isRanked(): boolean {
    return this.ranked !== null;
  }

  /** Whether `account` may take a slot: ranked, one of its two accounts, and not holding one already. */
  mayTake(account: string): boolean {
    return !!this.ranked?.accounts.includes(account) && !this.slots.some((s) => s.account === account);
  }

  /** The account holding slot `index` (ranked matches), or null. */
  accountOf(index: SlotIndex): string | null {
    return this.slots[index]?.account ?? null;
  }

  /** The server's engine for a player, once the match has started. */
  game(index: SlotIndex): Game | null {
    return this.slots[index]?.game ?? null;
  }

  get isOver(): boolean {
    return this.ended;
  }

  /** Started and not finished: what a spectator may watch (ranked matches only, see `admission`). */
  get isLive(): boolean {
    return this.started && !this.ended;
  }

  /** Sockets watching the match. */
  get spectatorCount(): number {
    return this.spectators.size;
  }

  /** Whether anyone holds a slot, so the adapter can tell `create` (needs none) from `join` (needs one). */
  get hasPlayers(): boolean {
    return this.slots.length > 0;
  }

  /** Whether `token` belongs to a slot, so the adapter can refuse a bad upgrade resume before accepting. */
  hasToken(token: string): boolean {
    return this.slotFor(token) !== null;
  }

  /** The slot holding `token`, compared in constant time against every slot (no stop at the first match). */
  private slotFor(token: string): Slot | null {
    let found: Slot | null = null;
    for (const slot of this.slots) if (timingSafeEqual(slot.token, token)) found = slot;
    return found;
  }

  /**
   * A new socket. With `resume` (the token from the upgrade's subprotocol) the socket rebinds that slot
   * at once and never waits among the pending sockets, so others can't crowd the owner out.
   */
  connect(peer: Peer, resume?: ResumeRequest, account?: string): Conn {
    const conn: Conn = { peer, slot: null, rejected: 0, closed: false, timer: null, spectator: false, seq: 0 };
    if (this.ended) {
      this.reject(conn, "ended", "the match is over");
    } else if (resume) {
      this.resume(conn, resume);
    } else if (this.ranked && (account === undefined || !this.mayTake(account))) {
      this.reject(conn, "not-yours", "this ranked match is for two other accounts");
    } else if (this.slots.length < 2) {
      const slot: Slot = {
        index: this.slots.length as SlotIndex, token: this.random.token(), account: this.ranked ? account! : null, conn, seq: 0, ack: 0,
        buffer: [], game: null, lastFrame: 0, budget: INPUT_BURST, budgetAt: 0, grace: null,
      };
      this.slots.push(slot);
      conn.slot = slot;
      this.send(slot, "welcome", { slot: slot.index, token: slot.token });
      if (slot.index === 0) this.lobby = this.clock.setTimeout(() => this.reset(), this.ranked ? RANKED_LOBBY_TIMEOUT_MS : LOBBY_TIMEOUT_MS);
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

  /**
   * A socket that watches: it gets one `spectate` message with the match's rules and the log so far,
   * then live `specEvent`s and the `end`. Refused (an `error`, then closed) unless the match is a live
   * ranked one, with room for another spectator (`busy`) and a log that is still complete (`too-long`).
   */
  connectSpectator(peer: Peer): Conn {
    const conn: Conn = { peer, slot: null, rejected: 0, closed: false, timer: null, spectator: true, seq: 0 };
    if (!this.ranked || !this.isLive || !this.startData) this.refuseSpectator(conn, "not-live", "no such live match");
    else if (this.spectators.size >= MAX_SPECTATORS) this.refuseSpectator(conn, "busy", "too many spectators");
    else if (this.log.length >= MAX_SPECTATE_EVENTS) this.refuseSpectator(conn, "too-long", "this match is too long to join");
    else {
      this.spectators.add(conn);
      this.sendSpectator(conn, "spectate", { ...this.startData, events: this.log, elapsed: this.wallFrame() });
    }
    return conn;
  }

  message(conn: Conn, data: string | ArrayBuffer): void {
    if (conn.closed) return;
    if (conn.spectator) return this.spectatorMessage(conn, data); // no catch-up: a spectator never moves the match
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
        return this.input(conn, msg.d, Number.isSafeInteger(msg.s) ? (msg.s as number) : undefined);
      default:
        return this.reject(conn, "bad-type", "unknown message type");
    }
  }

  disconnect(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.spectator) {
      this.spectators.delete(conn);
      return;
    }
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

  /** A spectator may only ping (answered without touching `lastActive`); anything else counts as rejected. */
  private spectatorMessage(conn: Conn, data: string | ArrayBuffer): void {
    const msg = parse(data);
    if (typeof msg === "string") return this.rejectSpectator(conn, msg, "unreadable message");
    if (msg.t === "ping") return conn.peer.send(JSON.stringify({ t: "pong", s: 0, a: 0 }));
    if (msg.t === "input") return this.rejectSpectator(conn, "spectator", "spectators can't play");
    this.rejectSpectator(conn, "bad-type", "unknown message type");
  }

  private sendSpectator(conn: Conn, t: string, d?: unknown): void {
    const pkt: Envelope = { t, s: ++conn.seq, a: 0, d };
    conn.peer.send(JSON.stringify(pkt));
  }

  private rejectSpectator(conn: Conn, code: string, message: string): void {
    this.sendSpectator(conn, "error", { code, message });
    if (++conn.rejected > MAX_REJECTED) this.drop(conn, 1008, code);
  }

  private refuseSpectator(conn: Conn, code: string, message: string): void {
    this.sendSpectator(conn, "error", { code, message });
    this.drop(conn, 1008, code);
  }

  /** Log what an engine applied (until the log is full) and pass it to every spectator. */
  private record(event: SpectateEvent): void {
    if (this.log.length < MAX_SPECTATE_EVENTS) this.log.push(event);
    for (const conn of this.spectators) this.sendSpectator(conn, "specEvent", event);
  }

  /** Tell the ranked config the match is (no longer) live. Never throws into the match. */
  private announce(on: boolean): void {
    try {
      void Promise.resolve(this.ranked?.live?.(on)).catch(() => {});
    } catch {
      // the live list is only a directory
    }
  }

  /** Close every socket the match knows about; ones still waiting to resume get an `error` first. */
  private closeAll(code: number, reason: string, message: string): void {
    for (const conn of [...this.pending]) this.reject(conn, reason, message);
    for (const slot of this.slots) if (slot.conn) this.drop(slot.conn, code, reason);
  }

  /**
   * Nobody joined in time: close the lone player's socket and start over, so the id can be reused.
   * A ranked room first reports the absent account if exactly one of the two is connected.
   */
  private reset(): void {
    this.lobby = null;
    if (this.started) return;
    // whoever is connected now is present; the other account is absent even if it took a slot and left
    const connected = this.slots.filter((s) => s.conn !== null);
    const present = connected.length === 1 ? connected[0].account : null;
    const absent = present === null ? undefined : this.ranked?.accounts.find((k) => k !== present);
    if (absent !== undefined) {
      try {
        void Promise.resolve(this.ranked!.noShow(absent)).catch(() => {});
      } catch {
        // a failed report changes nothing here
      }
    }
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
      for (const g of games) stepTo(g, f);
      if (games.some((g) => g.over)) break;
    }
    this.settle();
  }

  /** Send garbage queued by attacks, then end the match if an engine has topped out. */
  private settle(): void {
    const garbage = this.garbageOut;
    this.garbageOut = [];
    for (const g of garbage) {
      // the attacker's client simulates the target's board, so it learns the frame the garbage landed at
      this.send(g.slot, "garbage", { amount: g.amount, frame: g.frame });
      this.send(this.other(g.slot), "opponentGarbage", { amount: g.amount, frame: g.frame });
      this.record({ k: "garbage", slot: g.slot.index, amount: g.amount, frame: g.frame });
    }
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

  /**
   * Send an `error`. Unbound sockets are closed at once; bound ones after too many. A refused
   * input names its `s`, so the client can take it back out of its predicted board.
   */
  private reject(conn: Conn, code: string, message: string, s?: number): void {
    if (conn.closed) return;
    if (conn.slot) this.send(conn.slot, "error", s === undefined ? { code, message } : { code, message, s });
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
      const game = new Game(options, MATCH_HANDLING);
      game.onAttack = (amount) => {
        const target = this.other(slot);
        if (!target.game) return;
        target.game.receive(amount);
        this.garbageOut.push({ slot: target, amount, frame: target.game.frame });
      };
      slot.game = game;
    }
    for (const slot of this.slots) this.send(slot, "start", { seed, options, handling: MATCH_HANDLING });
    this.startData = { seed, options, handling: MATCH_HANDLING };
    this.announce(true);
  }

  private resume(conn: Conn, d: unknown): void {
    if (conn.slot) return this.reject(conn, "already-bound", "this socket already holds a slot");
    if (!isObject(d) || typeof d.token !== "string" || !Number.isSafeInteger(d.peerAck) || (d.peerAck as number) < 0) {
      return this.reject(conn, "bad-message", "resume needs {token, peerAck}");
    }
    const slot = this.slotFor(d.token);
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

  private input(conn: Conn, d: unknown, s: number | undefined): void {
    const reject = (code: string, message: string) => this.reject(conn, code, message, s);
    const slot = conn.slot;
    if (!slot) return reject("not-joined", "send resume first");
    if (this.ended) return;
    const game = slot.game;
    if (!game) return reject("not-started", "the match has not started");
    if (
      !isObject(d) || typeof d.action !== "string" || !ACTIONS.includes(d.action) ||
      (d.kind !== "press" && d.kind !== "release") || typeof d.frame !== "number" || !Number.isFinite(d.frame)
    ) {
      return reject("bad-input", "input needs {frame, action, kind}");
    }
    const frame = d.frame;
    if (frame < slot.lastFrame) return reject("frame-behind", "frame is before the last accepted input");
    const now = this.clock.now();
    const wall = this.wallFrame();
    if (frame > wall + FRAME_TOLERANCE) return reject("frame-ahead", "frame is ahead of the server clock");
    if (frame < wall - MAX_LAG_FRAMES) return reject("frame-late", "frame is too far behind the server clock");
    slot.budget = Math.min(INPUT_BURST, slot.budget + ((now - slot.budgetAt) * MAX_INPUTS_PER_SECOND) / 1000);
    slot.budgetAt = now;
    if (slot.budget < 1) return reject("rate-limit", "too many inputs");

    slot.budget--;
    this.lastActive = now;
    slot.lastFrame = frame;
    const action = d.action as Action;
    // the input lands on the 1/256-frame grid, after whole-frame steps, as on a client (stepping.ts)
    // A catch-up may already have moved the engine past that point; the input then lands at the
    // engine's frame, and that is the frame relayed, so the opponent's client applies it where we did.
    stepToClock(game, frame, true);
    const applied = game.frame;
    if (d.kind === "press") game.press(action);
    else game.release(action);

    this.send(this.other(slot), "opponentInput", { frame: applied, action, kind: d.kind });
    this.record({ k: "input", slot: slot.index, frame: applied, action, kind: d.kind });
    this.settle();
  }

  /** `winner` is null for a draw (an idle match). A ranked match reports it first (see `rate`). */
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
    this.log = [];
    this.announce(false);
    if (this.ranked) return this.rate(this.ranked, winner, reason);
    this.end(winner, reason, null);
  }

  /**
   * Report a ranked result once, then send `end` with each player's rating. If `report` fails,
   * answers something unreadable or takes over REPORT_TIMEOUT_MS, `end` goes out without ratings.
   */
  private rate(ranked: RankedConfig, winner: SlotIndex | null, reason: string): void {
    let done = false;
    const deliver = (ratings: readonly SlotRating[] | null) => {
      if (done) return;
      done = true;
      this.clock.clearTimeout(timer);
      this.end(winner, reason, ratings);
    };
    const timer = this.clock.setTimeout(() => deliver(null), REPORT_TIMEOUT_MS);
    let reported: Promise<unknown>;
    try {
      reported = Promise.resolve(ranked.report(winner));
    } catch (e) {
      reported = Promise.reject(e);
    }
    reported.then(
      (r) => deliver(Array.isArray(r) && r.length === 2 && r.every(isSlotRating) ? r : null),
      () => deliver(null),
    );
  }

  private end(winner: SlotIndex | null, reason: string, ratings: readonly SlotRating[] | null): void {
    for (const slot of this.slots) {
      const rating = ratings?.[slot.index];
      this.send(slot, "end", rating ? { winner, reason, rating: { tr: rating.tr, delta: rating.delta } } : { winner, reason });
    }
    for (const conn of [...this.spectators]) {
      this.sendSpectator(conn, "end", { winner, reason });
      this.drop(conn, 1000, "ended");
    }
    this.closeAll(1000, "ended", "the match is over");
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const intOrNull = (v: unknown) => v === null || Number.isSafeInteger(v);

function isSlotRating(v: unknown): v is SlotRating {
  return isObject(v) && intOrNull(v.tr) && intOrNull(v.delta);
}

/**
 * Whether a new socket (no resume) may open with `mode`, given the account the Worker
 * resolved from its session cookie: null if so, else the refusal. Only `mode=ranked` takes a
 * ranked room's slots, and only for its two accounts; create and join can't touch it (409).
 * `mode=spectate` watches a started, unfinished ranked match; every other room (unranked, free,
 * still in its lobby, finished) gets the same 404, so a code's state can't be told from it.
 */
export function admission(session: MatchSession, mode: string | null, account: string | null): { status: number; message: string } | null {
  if (mode === "spectate") return session.isRanked && session.isLive ? null : { status: 404, message: "No such live match" };
  if (mode === "ranked") {
    if (!session.isRanked) return { status: 404, message: "No such ranked match" };
    if (account === null) return { status: 401, message: "Sign in to play ranked" };
    if (!session.mayTake(account)) return { status: 403, message: "This ranked match is not yours" };
    return null;
  }
  if (mode !== "create" && mode !== "join") return { status: 400, message: "Expected ?mode=create, ?mode=join, ?mode=ranked or ?mode=spectate" };
  if (session.isRanked) return { status: 409, message: "That code is a ranked match" };
  if (mode === "create" && session.hasPlayers) return { status: 409, message: "Room code taken" };
  if (mode === "join" && !session.hasPlayers) return { status: 404, message: "No such room" };
  return null;
}

/** Where a `Match` object keeps the claim on its code: its Durable Object storage (a Map in the tests). */
export interface ClaimStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: number): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export const CLAIM_KEY = "claim"; // the claim's expiry time, ms

/**
 * `POST /api/room` reserving this room's code: records a claim that expires ROOM_CLAIM_MS from
 * `now` and returns that time, or null if the code is claimed already (unexpired) or in use.
 */
export async function issueClaim(session: MatchSession, storage: ClaimStorage, now: number): Promise<number | null> {
  if (session.hasPlayers || session.isRanked || session.isOver) return null;
  const claimed = await storage.get(CLAIM_KEY);
  if (typeof claimed === "number" && claimed > now) return null;
  const expires = now + ROOM_CLAIM_MS;
  await storage.put(CLAIM_KEY, expires);
  return expires;
}

/** Consume the claim on this room's code: true if there was one and it had not expired. */
async function takeClaim(storage: ClaimStorage, now: number): Promise<boolean> {
  const claimed = await storage.get(CLAIM_KEY);
  if (claimed === undefined) return false;
  await storage.delete(CLAIM_KEY);
  return typeof claimed === "number" && claimed > now;
}

/**
 * `admission`, plus the issued-code rule: `mode=create` also needs a live claim from `POST /api/room`
 * (404 without one), which it consumes, so a code is created at most once per `POST /api/room`.
 */
export async function admit(
  session: MatchSession, storage: ClaimStorage, mode: string | null, account: string | null, now: number,
): Promise<{ status: number; message: string } | null> {
  const refused = admission(session, mode, account);
  if (refused || mode !== "create") return refused;
  if (!(await takeClaim(storage, now))) return { status: 404, message: "Room code was not issued" };
  return admission(session, mode, account); // nothing else runs during the storage calls, but check again
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
