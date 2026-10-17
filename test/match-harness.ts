// The match server driven by fake connections and a fake clock, shared by the match tests.
import { expect } from "vitest";
import { Clock, Conn, Envelope, MatchSession, Peer, Random, ResumeRequest } from "../src/server/match";

/** Manual clock: time only moves when the test says so. */
export class FakeClock implements Clock {
  t = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.t && this.timers.has(id)) { // an earlier timer may have cleared it
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

export class FakePeer implements Peer {
  sent: Envelope[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string): void {
    expect(this.closed).toBeNull();
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  of(t: string): Envelope[] {
    return this.sent.filter((m) => m.t === t);
  }
  last(): Envelope {
    return this.sent[this.sent.length - 1];
  }
}

export interface Player {
  peer: FakePeer;
  conn: Conn;
}

export function join(session: MatchSession, resume?: ResumeRequest): Player {
  const peer = new FakePeer();
  return { peer, conn: session.connect(peer, resume) };
}

export function setup(random?: Random) {
  const clock = new FakeClock();
  const session = new MatchSession(clock, random);
  const p0 = join(session);
  const p1 = join(session);
  return { clock, session, p0, p1 };
}

let seq = 0;
export function send(session: MatchSession, p: Player, t: string, d?: unknown): void {
  session.message(p.conn, JSON.stringify({ t, s: ++seq, a: 0, d }));
}

export function input(session: MatchSession, p: Player, frame: number, action: string, kind = "press"): void {
  send(session, p, "input", { frame, action, kind });
}

export function lastError(p: Player): string | undefined {
  const errors = p.peer.of("error");
  return (errors[errors.length - 1]?.d as { code: string } | undefined)?.code;
}
