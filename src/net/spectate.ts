// The spectator client: watches a live ranked match (`?mode=spectate`, README "Game server") over
// one socket. No DOM: app.ts hands it a WebSocket and a clock, and the tests drive it against
// MatchSession.
//
// Both boards are simulated the way OnlineClient simulates its opponent: a Game per slot, stepped
// only by the server's log of what its engines applied (`input` and `garbage` entries, at the
// engine frames they landed at). `spectate` carries the rules and the log so far, replayed at once;
// each later `specEvent` is applied as it arrives. A board rests at its last event's frame: nothing
// is guessed, so between events it stands still. The client sends nothing but a `ping`.

import { Action, Game, Handling } from "../engine/game";
import { stepToClock } from "../engine/stepping";
import { OnlineSocket, PING_MS } from "./online";

export interface SpectatorResult {
  winner: 0 | 1 | null; // a slot (board) index, or null for a draw
  reason: string; // the server's (topout, disconnect, idle)
}

/** What the client tells the screen. Every hook is optional. */
export interface SpectatorEvents {
  start(): void; // `spectate` arrived: `boards` exist, with the log so far applied
  garbage(slot: 0 | 1, amount: number): void; // board `slot` received garbage (live events only)
  end(result: SpectatorResult): void;
  error(code: string, message: string): void;
  closed(): void; // the socket closed before `spectate`, or mid-match before `end`
}

const ACTIONS: readonly string[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export class SpectatorClient {
  phase: "connecting" | "watching" | "over" = "connecting";
  boards: [Game, Game] | null = null;
  result: SpectatorResult | null = null;
  lastError: { code: string; message: string } | null = null;
  events: Partial<SpectatorEvents> = {};

  private seq = 0; // last `s` sent
  private ack = 0; // last `s` received
  private lastSend: number;

  constructor(private socket: OnlineSocket, private now: () => number) {
    this.lastSend = now();
  }

  /** Close the socket and stop watching. */
  leave(): void {
    this.phase = "over";
    this.socket.close();
  }

  /** Ping when nothing was sent for PING_MS. Call once per display frame. */
  update(): void {
    if (this.phase === "over" || this.now() - this.lastSend < PING_MS) return;
    this.socket.send(JSON.stringify({ t: "ping", s: ++this.seq, a: this.ack }));
    this.lastSend = this.now();
  }

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
    switch (msg.t) {
      case "spectate":
        return this.start(d);
      case "specEvent":
        if (this.phase === "watching") this.apply(d, true);
        return;
      case "end": {
        if (this.phase === "over") return;
        const winner = d.winner === 0 || d.winner === 1 ? d.winner : null;
        this.phase = "over";
        this.result = { winner, reason: typeof d.reason === "string" ? d.reason : "" };
        this.events.end?.(this.result);
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
    this.phase = "over";
    this.events.closed?.();
  }

  // ---------------------------------------------------------------- internals

  private start(d: Record<string, unknown>): void {
    if (this.phase !== "connecting" || !isObject(d.options) || !isObject(d.handling) || !Array.isArray(d.events)) return;
    // the server's rules and handling, as sent to both players in `start`
    const options = d.options as ConstructorParameters<typeof Game>[0];
    const handling = d.handling as unknown as Handling;
    this.boards = [new Game(options, handling), new Game(options, handling)];
    this.phase = "watching";
    for (const e of d.events) if (isObject(e)) this.apply(e, false); // silent: the screen listens after `start`
    this.events.start?.();
  }

  /** One log entry, with the stepping OnlineClient gives its opponent board. Malformed ones are skipped. */
  private apply(e: Record<string, unknown>, live: boolean): void {
    if ((e.slot !== 0 && e.slot !== 1) || !finite(e.frame)) return;
    const slot = e.slot;
    const game = this.boards![slot];
    if (e.k === "input") {
      if (typeof e.action !== "string" || !ACTIONS.includes(e.action) || (e.kind !== "press" && e.kind !== "release")) return;
      stepToClock(game, e.frame, true);
      if (e.kind === "press") game.press(e.action as Action);
      else game.release(e.action as Action);
    } else if (e.k === "garbage") {
      if (!finite(e.amount)) return;
      stepToClock(game, e.frame, true);
      game.receive(e.amount);
      if (live) this.events.garbage?.(slot, e.amount);
    }
  }
}
