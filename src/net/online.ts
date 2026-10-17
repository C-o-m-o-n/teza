// The online VS client: the match protocol (src/server/match.ts, README "Game server") over one
// socket, and the prediction that keeps both boards equal to the server's engines. No DOM: app.ts
// hands it a WebSocket and a clock, and the tests drive it against MatchSession.
//
// Own board: inputs apply at once, with the canonical stepping (stepping.ts), and are sent with
// the clock they landed at; the server replays them on the same grid. Garbage is the one thing
// the server decides: `garbage {amount, frame}` says the server's engine received it at `frame`,
// after the inputs it had read by then (the envelope's ack). The client keeps snapshots of its
// game and a log of what it applied, so it rewinds to a snapshot, replays the log with the
// garbage in its place, and is back at its clock with the board the server's engine will have.
//
// Opponent board: a second Game stepped only by what the server relays (`opponentInput`,
// `opponentGarbage`), at the frames the server's engine applied them. It rests at the last
// relayed frame: nothing is guessed.
//
// The outcome comes only from the server's `end`; a local top-out just stops the input.

import { Action, Game, Handling } from "../engine/game";
import { restFrame, stepTo, stepToClock } from "../engine/stepping";
import { MAX_INPUTS_PER_SECOND } from "../server/match";

/** The part of a WebSocket the client uses. */
export interface OnlineSocket {
  send(data: string): void;
  close(): void;
}

export type OnlineOutcome = "win" | "lose" | "draw" | "lost"; // lost: the connection, before `end`

export interface OnlineResult {
  outcome: OnlineOutcome;
  reason: string; // the server's (topout, disconnect, idle), or "connection"
}

/** What the client tells the screen. Every hook is optional. */
export interface OnlineEvents {
  welcome(slot: number): void; // a slot is ours: the room is open (create) or joined
  start(): void; // both players are in: `player` and `opponent` exist, the clock runs
  attack(amount: number): void; // our board predicts an attack (shown; the server sends the real one)
  garbage(amount: number): void; // the server sent us garbage
  opponentAway(graceMs: number | null): void; // the opponent's socket dropped (null: they are back)
  error(code: string, message: string): void;
  end(result: OnlineResult): void; // the match is over (or the connection is gone mid-match)
  closed(): void; // the socket closed before the match started
}

export const PING_MS = 10_000; // keeps the server's idle timer from ending a quiet match
export const PACE_WINDOW_MS = 1100; // no more than MAX_INPUTS_PER_SECOND inputs leave in this window
export const SNAPSHOT_EVERY = 15; // frames between snapshots of the own game
export const SNAPSHOTS = 120; // kept (30 s): garbage lands no further back than the server's lag limit

const ACTIONS: readonly string[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];

type Kind = "press" | "release";
type Logged =
  | { type: "input"; frame: number; s: number; action: Action; kind: Kind }
  | { type: "garbage"; frame: number; amount: number };

interface Snapshot {
  game: Game;
  at: number; // absolute log index: the events applied before it
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type Listeners = { listeners: unknown[] };

export class OnlineClient {
  phase: "connecting" | "lobby" | "playing" | "over" = "connecting";
  slot: 0 | 1 | null = null;
  player: Game | null = null;
  opponent: Game | null = null;
  result: OnlineResult | null = null;
  lastError: { code: string; message: string } | null = null;
  rewinds = 0; // garbage that landed behind the own game's frame (for the tests)
  events: Partial<OnlineEvents> = {};

  private seq = 0; // last `s` sent
  private ack = 0; // last `s` received
  private startAt = 0; // now() when `start` arrived: clock 0
  private lastFrame = 0; // frame of the last input sent; never goes down
  private lastSend = 0;
  private held = new Set<Action>(); // pressed and not released, as sent
  private queue: { action: Action; kind: Kind }[] = []; // waiting for the input budget
  private sent: number[] = []; // now() of inputs sent in the pacing window
  private log: Logged[] = [];
  private base = 0; // absolute index of log[0]
  private applied = 0; // absolute index of the next log entry to apply (the log's end, except in a replay)
  private snapshots: Snapshot[] = [];
  private synced = false; // the top-out was sent on (see `update`)

  constructor(private socket: OnlineSocket, private now: () => number) {
    this.lastSend = now();
  }

  /** Frames since `start`, from the wall clock (not the display), so it keeps pace with the server's. */
  get clock(): number {
    return this.phase === "playing" ? ((this.now() - this.startAt) * 60) / 1000 : 0;
  }

  /** Close the socket and stop. The server gives the match to the opponent after its grace period. */
  leave(): void {
    this.phase = "over";
    this.socket.close();
  }

  /**
   * Bring the own board to the clock, send what the input budget allows, and ping when due.
   * Call once per display frame.
   */
  update(): void {
    if (this.phase === "lobby" || this.phase === "playing") {
      if (this.now() - this.lastSend >= PING_MS) this.send("ping"); // nothing sent for 10 s
    }
    if (this.phase !== "playing" || !this.player) return;
    this.stepPlayer(this.clock, false);
    this.flush();
    this.prune();
    if (!this.player.over) this.synced = false; // a rewind can undo a predicted top-out
    else if (!this.synced) {
      // Tell the server's engine to come to this clock now (a no-op input once it has topped
      // out), rather than wait for its catch-up, so `end` follows the top-out at once.
      this.synced = true;
      this.queue.push({ action: "soft", kind: "release" });
      this.held.delete("soft");
      this.flush();
    }
  }

  press(action: Action): void {
    if (!this.player || this.phase !== "playing" || this.player.over) return;
    this.held.add(action);
    this.queue.push({ action, kind: "press" });
    this.flush();
  }

  release(action: Action): void {
    // a key held through a blur was released then; its keyup is not sent again
    if (!this.player || this.phase !== "playing" || !this.held.has(action)) return;
    this.held.delete(action);
    this.queue.push({ action, kind: "release" });
    this.flush();
  }

  /** The window lost focus: release every held action, one by one, here and on the server. */
  blur(): void {
    for (const action of [...this.held]) this.release(action);
  }

  // ---------------------------------------------------------------- socket

  receive(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(msg) || typeof msg.t !== "string") return;
    if (Number.isSafeInteger(msg.s) && (msg.s as number) > this.ack) this.ack = msg.s as number;
    const d = isObject(msg.d) ? msg.d : {};
    const ackOfOurs = Number.isSafeInteger(msg.a) ? (msg.a as number) : 0;
    switch (msg.t) {
      case "welcome":
        if (this.phase !== "connecting" || (d.slot !== 0 && d.slot !== 1)) return;
        this.slot = d.slot;
        this.phase = "lobby";
        this.events.welcome?.(d.slot);
        return;
      case "start":
        return this.start(d);
      case "garbage":
        if (this.phase !== "playing" || !finite(d.amount) || !finite(d.frame)) return;
        this.garbage(d.amount, d.frame, ackOfOurs);
        return;
      case "opponentInput": {
        const opp = this.opponent;
        if (this.phase !== "playing" || !opp || !finite(d.frame) || typeof d.action !== "string" || !ACTIONS.includes(d.action)) return;
        stepToClock(opp, d.frame, true);
        if (d.kind === "press") opp.press(d.action as Action);
        else if (d.kind === "release") opp.release(d.action as Action);
        return;
      }
      case "opponentGarbage":
        if (this.phase !== "playing" || !this.opponent || !finite(d.amount) || !finite(d.frame)) return;
        stepToClock(this.opponent, d.frame, true);
        this.opponent.receive(d.amount);
        return;
      case "opponentDisconnected":
        this.events.opponentAway?.(finite(d.grace) ? d.grace : 0);
        return;
      case "opponentReconnected":
        this.events.opponentAway?.(null);
        return;
      case "end": {
        if (this.phase === "over") return;
        const winner = d.winner;
        const outcome = winner === null ? "draw" : winner === this.slot ? "win" : "lose";
        this.finish({ outcome, reason: typeof d.reason === "string" ? d.reason : "" });
        return;
      }
      case "error":
        this.lastError = { code: String(d.code ?? ""), message: String(d.message ?? "") };
        this.events.error?.(this.lastError.code, this.lastError.message);
        return;
    }
  }

  /** The socket closed (or failed to open). */
  closed(): void {
    if (this.phase === "over") return;
    if (this.phase === "playing") return this.finish({ outcome: "lost", reason: "connection" });
    this.phase = "over";
    this.events.closed?.();
  }

  // ---------------------------------------------------------------- internals

  private send(t: string, d?: unknown): number {
    const s = ++this.seq;
    this.socket.send(JSON.stringify({ t, s, a: this.ack, d }));
    this.lastSend = this.now();
    return s;
  }

  private finish(result: OnlineResult): void {
    this.phase = "over";
    this.result = result;
    this.events.end?.(result);
  }

  private start(d: Record<string, unknown>): void {
    if (this.phase !== "lobby" || !isObject(d.options) || !isObject(d.handling)) return;
    // the server's rules and handling, not local settings: IRS/IHS and DAS must replay the same
    const options = d.options as ConstructorParameters<typeof Game>[0];
    const handling = d.handling as unknown as Handling;
    this.player = new Game(options, handling);
    this.opponent = new Game(options, handling);
    this.player.onAttack = (n) => this.events.attack?.(n);
    this.phase = "playing";
    this.startAt = this.now();
    this.snapshots = [{ game: this.player.clone(), at: 0 }];
    this.events.start?.();
  }

  /** Send queued inputs while the budget allows, each applied here at the clock it is sent with. */
  private flush(): void {
    const g = this.player;
    if (!g || this.phase !== "playing") return;
    const now = this.now();
    this.sent = this.sent.filter((t) => t > now - PACE_WINDOW_MS);
    while (this.queue.length && this.sent.length < MAX_INPUTS_PER_SECOND) {
      const { action, kind } = this.queue.shift()!;
      const frame = Math.max(this.clock, this.lastFrame);
      this.lastFrame = frame;
      this.stepPlayer(frame, true);
      const s = this.send("input", { frame, action, kind });
      this.sent.push(now);
      this.log.push({ type: "input", frame: g.frame, s, action, kind });
      this.applied++;
      if (kind === "press") g.press(action);
      else g.release(action);
    }
  }

  /** stepToClock for the own game, taking snapshots on the way. */
  private stepPlayer(clock: number, input: boolean): void {
    this.run(restFrame(clock, false));
    if (input) this.run(restFrame(clock, true));
  }

  /** Step the own game to the rest point `to`, snapshotting at every SNAPSHOT_EVERY-th frame. */
  private run(to: number): void {
    const g = this.player!;
    for (let f = (Math.floor(g.frame / SNAPSHOT_EVERY) + 1) * SNAPSHOT_EVERY; f <= to && !g.over; f += SNAPSHOT_EVERY) {
      stepTo(g, f);
      this.snapshots.push({ game: g.clone(), at: this.applied });
    }
    stepTo(g, to);
  }

  /** Forget snapshots beyond SNAPSHOTS, and the log before the oldest one left. */
  private prune(): void {
    if (this.snapshots.length <= SNAPSHOTS) return;
    this.snapshots.splice(0, this.snapshots.length - SNAPSHOTS);
    const drop = this.snapshots[0].at - this.base;
    this.log.splice(0, drop);
    this.base += drop;
  }

  /** The server's engine received `amount` at `frame`, after our inputs up to `s = ack`. */
  private garbage(amount: number, frame: number, ack: number): void {
    const g = this.player!;
    // its place in the log: after the inputs the server had read, and after earlier garbage
    let at = this.base + this.log.length;
    while (at > this.base) {
      const e = this.log[at - 1 - this.base];
      if (e.type === "garbage" || e.s <= ack) break;
      at--;
    }
    const entry: Logged = { type: "garbage", frame, amount };
    if (at === this.base + this.log.length && g.frame <= frame) {
      // nothing applied after it yet: step to it (if not there) and take it
      this.run(frame);
      this.log.push(entry);
      this.applied++;
      g.receive(amount);
      this.events.garbage?.(amount);
      return;
    }
    let i = this.snapshots.length - 1;
    while (i >= 0 && (this.snapshots[i].at > at || this.snapshots[i].game.frame > frame)) i--;
    if (i < 0) {
      // older than every snapshot: cannot happen within the server's lag limit; take it now
      this.log.push(entry);
      this.applied++;
      g.receive(amount);
      this.events.garbage?.(amount);
      return;
    }
    this.rewinds++;
    const snap = this.snapshots[i];
    this.snapshots.length = i + 1;
    const end = g.frame;
    this.log.splice(at - this.base, 0, entry);
    // replay silently (sounds and board effects already played), except the garbage itself
    const raw = g as unknown as Listeners;
    const listeners = raw.listeners;
    const onAttack = g.onAttack;
    Object.assign(g, snap.game.clone());
    raw.listeners = [];
    g.onAttack = null;
    for (this.applied = snap.at; this.applied < this.base + this.log.length;) {
      const e = this.log[this.applied - this.base];
      this.run(e.frame);
      this.applied++;
      if (e.type === "input") {
        if (e.kind === "press") g.press(e.action);
        else g.release(e.action);
      } else if (e === entry) {
        raw.listeners = listeners;
        g.receive(e.amount);
        raw.listeners = [];
      } else {
        g.receive(e.amount);
      }
    }
    this.run(end);
    raw.listeners = listeners;
    g.onAttack = onAttack;
    this.events.garbage?.(amount);
  }
}
