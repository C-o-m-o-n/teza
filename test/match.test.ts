import { describe, expect, it } from "vitest";
import { Action, Game } from "../src/engine/game";
import {
  Clock, Conn, Envelope, MatchSession, Peer, RECONNECT_GRACE_MS, SEND_BUFFER, matchOptions,
} from "../src/server/match";

/** Manual clock: time only moves when the test says so. */
class FakeClock implements Clock {
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
      if (timer.at <= this.t) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

class FakePeer implements Peer {
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

interface Player {
  peer: FakePeer;
  conn: Conn;
}

function join(session: MatchSession): Player {
  const peer = new FakePeer();
  return { peer, conn: session.connect(peer) };
}

function setup() {
  const clock = new FakeClock();
  const session = new MatchSession(clock);
  const p0 = join(session);
  const p1 = join(session);
  return { clock, session, p0, p1 };
}

let seq = 0;
function send(session: MatchSession, p: Player, t: string, d?: unknown): void {
  session.message(p.conn, JSON.stringify({ t, s: ++seq, a: 0, d }));
}

function input(session: MatchSession, p: Player, frame: number, action: string, kind = "press"): void {
  send(session, p, "input", { frame, action, kind });
}

function lastError(p: Player): string | undefined {
  const errors = p.peer.of("error");
  return (errors[errors.length - 1]?.d as { code: string } | undefined)?.code;
}

describe("match: joining", () => {
  it("gives the first two connections distinct slots and the same seed; a third is turned away", () => {
    const { session, p0, p1 } = setup();
    const w0 = p0.peer.of("welcome")[0].d as { slot: number; token: string };
    const w1 = p1.peer.of("welcome")[0].d as { slot: number; token: string };
    expect([w0.slot, w1.slot]).toEqual([0, 1]);
    expect(w0.token).toMatch(/^[0-9a-f]{32}$/);
    expect(w0.token).not.toBe(w1.token);

    const s0 = p0.peer.of("start")[0].d as { seed: number; options: { hasgarbage: boolean } };
    const s1 = p1.peer.of("start")[0].d as { seed: number };
    expect(s0.seed).toBe(s1.seed);
    expect(s0.options.hasgarbage).toBe(true);
    expect(p0.peer.sent.map((m) => m.s)).toEqual([1, 2]);

    const p2 = join(session);
    expect(lastError(p2)).toBe("full");
    expect(p2.peer.closed).not.toBeNull();
  });

  it("answers ping with pong", () => {
    const { session, p0 } = setup();
    send(session, p0, "ping");
    expect(p0.peer.last().t).toBe("pong");
  });
});

describe("match: inputs", () => {
  it("accepts a valid hard drop and relays it to the opponent", () => {
    const { session, p0, p1 } = setup();
    input(session, p0, 20, "hard");
    const game = session.game(0)!;
    expect(game.stats.inputs).toBe(1);
    expect(game.frame).toBe(20);
    expect(game.stats.pieces).toBe(1);
    expect(p0.peer.of("error")).toEqual([]);
    expect(p1.peer.last()).toMatchObject({ t: "opponentInput", d: { frame: 20, action: "hard", kind: "press" } });
  });

  it("rejects a decreasing frame, a frame too far ahead, and bad actions or kinds without touching the engine", () => {
    const { clock, session, p0, p1 } = setup();
    clock.advance(1000); // server clock frame = 60
    input(session, p0, 10, "cw");
    const game = session.game(0)!;
    expect(game.stats.inputs).toBe(1);
    const relayed = p1.peer.of("opponentInput").length;

    const cases: [number, string, string, string][] = [
      [5, "cw", "press", "frame-behind"],
      [60 + 30 + 1, "cw", "press", "frame-ahead"],
      [100_000, "hard", "press", "frame-ahead"],
      [20, "jump", "press", "bad-input"],
      [20, "__proto__", "press", "bad-input"],
      [20, "cw", "tap", "bad-input"],
    ];
    for (const [frame, action, kind, code] of cases) {
      input(session, p0, frame, action, kind);
      expect(lastError(p0)).toBe(code);
      expect(game.frame).toBe(10);
      expect(game.stats.inputs).toBe(1);
    }
    send(session, p0, "input", { frame: "20", action: "cw", kind: "press" });
    expect(lastError(p0)).toBe("bad-input");
    send(session, p0, "input", { frame: Infinity, action: "cw", kind: "press" }); // serialises to null
    expect(lastError(p0)).toBe("bad-input");
    expect(game.frame).toBe(10);
    expect(p1.peer.of("opponentInput").length).toBe(relayed);
    expect(p0.peer.closed).toBeNull();

    // exactly at the tolerance is fine
    input(session, p0, 90, "cw");
    expect(game.frame).toBe(90);
    expect(game.stats.inputs).toBe(2);
  });

  it("rejects more than 60 inputs per second", () => {
    const { clock, session, p0 } = setup();
    clock.advance(2000);
    const game = session.game(0)!;
    for (let i = 0; i < 60; i++) input(session, p0, 10 + i * 0.5, i % 2 ? "cw" : "ccw");
    expect(p0.peer.of("error")).toEqual([]);
    expect(game.stats.inputs).toBe(60);
    const frame = game.frame;

    input(session, p0, 50, "cw");
    expect(lastError(p0)).toBe("rate-limit");
    expect(game.stats.inputs).toBe(60);
    expect(game.frame).toBe(frame);

    clock.advance(1000);
    input(session, p0, 50, "cw");
    expect(game.stats.inputs).toBe(61);
  });

  it("drops the connection after more than 20 rejected inputs", () => {
    const { session, p0, p1 } = setup();
    for (let i = 0; i < 20; i++) input(session, p0, 0, "jump");
    expect(p0.peer.closed).toBeNull();
    input(session, p0, 0, "jump");
    expect(p0.peer.closed).toMatchObject({ code: 1008 });
    expect(p1.peer.last()).toMatchObject({ t: "opponentDisconnected", d: { grace: RECONNECT_GRACE_MS } });
  });

  it("is deterministic: replaying the accepted inputs reproduces the server board", () => {
    const { clock, session, p0, p1 } = setup();
    const script: [number, Action, "press" | "release"][] = [
      [3, "left", "press"], [18.5, "left", "release"], [20, "cw", "press"], [25, "hard", "press"],
      [31.25, "right", "press"], [40, "right", "release"], [41, "hold", "press"], [55, "soft", "press"],
      [70, "soft", "release"], [72, "180", "press"], [80, "hard", "press"], [95.5, "ccw", "press"],
      [96, "hard", "press"], [120, "hard", "press"],
    ];
    for (const [frame, action, kind] of script) {
      clock.advance(250);
      input(session, p0, frame, action, kind);
    }
    expect(p0.peer.of("error")).toEqual([]);

    const seed = (p0.peer.of("start")[0].d as { seed: number }).seed;
    const replay = new Game(matchOptions(seed));
    for (const m of p1.peer.of("opponentInput")) {
      const d = m.d as { frame: number; action: Action; kind: string };
      replay.advance(d.frame - replay.frame);
      if (d.kind === "press") replay.press(d.action);
      else replay.release(d.action);
    }
    const server = session.game(0)!;
    expect(replay.frame).toBe(server.frame);
    expect(replay.stats).toEqual(server.stats);
    expect(replay.board).toEqual(server.board);
    expect(replay.piece).toEqual(server.piece);
    expect(replay.queue).toEqual(server.queue);
    expect(server.stats.pieces).toBe(4);
  });

  it("sends attacks to the opponent's engine and tells them", () => {
    const { session, p0, p1 } = setup();
    session.game(0)!.onAttack!(3); // as if player 0 just cleared lines
    input(session, p0, 5, "cw");
    expect(session.game(1)!.stats.received).toBe(3);
    expect(p1.peer.last()).toMatchObject({ t: "garbage", d: { amount: 3, frame: 0 } });
  });
});

describe("match: ending", () => {
  it("ends once, with the other player winning, when a player tops out", () => {
    const { clock, session, p0, p1 } = setup();
    let frame = 0;
    for (let i = 0; i < 100 && !session.isOver; i++) {
      clock.advance(100);
      frame += 6;
      input(session, p0, frame, "hard");
    }
    expect(session.isOver).toBe(true);
    expect(session.game(0)!.over).toBe(true);
    expect(p0.peer.of("error")).toEqual([]);

    for (const p of [p0, p1]) {
      expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout" } })]);
    }

    // later input is ignored, and a disconnect no longer starts a forfeit timer
    const counts = [p0.peer.sent.length, p1.peer.sent.length];
    input(session, p1, frame, "hard");
    input(session, p0, frame + 1, "hard");
    session.disconnect(p0.conn);
    clock.advance(RECONNECT_GRACE_MS * 2);
    expect([p0.peer.sent.length, p1.peer.sent.length]).toEqual(counts);
    expect(session.game(1)!.stats.inputs).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe("match: reconnect", () => {
  it("tells the opponent, replays missed packets on resume, and rejects a wrong token", () => {
    const { clock, session, p0, p1 } = setup();
    const token = (p0.peer.of("welcome")[0].d as { token: string }).token;
    clock.advance(1000);
    input(session, p1, 10, "cw"); // p0 gets s=3
    expect(p0.peer.last().s).toBe(3);

    session.disconnect(p0.conn);
    expect(p1.peer.last()).toMatchObject({ t: "opponentDisconnected", d: { grace: 15000 } });
    input(session, p1, 20, "ccw"); // s=4, buffered only
    input(session, p1, 30, "hard"); // s=5

    const intruder = join(session);
    expect(intruder.peer.sent).toEqual([]); // waits for resume
    send(session, intruder, "resume", { token: "0".repeat(32), peerAck: 0 });
    expect(lastError(intruder)).toBe("bad-token");
    expect(intruder.peer.closed).not.toBeNull();

    const back = join(session);
    send(session, back, "resume", { token, peerAck: 3 });
    expect(back.peer.sent.map((m) => [m.s, m.t])).toEqual([[4, "opponentInput"], [5, "opponentInput"]]);
    expect(back.peer.sent.map((m) => (m.d as { frame: number }).frame)).toEqual([20, 30]);
    expect(p1.peer.last().t).toBe("opponentReconnected");
    expect(clock.pending).toBe(0);

    // the rebound socket plays on with the same engine
    input(session, back, 40, "hard");
    expect(session.game(0)!.stats.inputs).toBe(1);
    expect(p1.peer.last()).toMatchObject({ t: "opponentInput", d: { frame: 40 } });

    clock.advance(RECONNECT_GRACE_MS * 2);
    expect(session.isOver).toBe(false);
  });

  it("forfeits a player who does not come back within 15 s", () => {
    const { clock, session, p0, p1 } = setup();
    session.disconnect(p0.conn);
    clock.advance(RECONNECT_GRACE_MS - 1);
    expect(session.isOver).toBe(false);
    clock.advance(1);
    expect(session.isOver).toBe(true);
    expect(p1.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "disconnect" } })]);
    expect(clock.pending).toBe(0);
  });

  it("asks for a resync when the missed packets have left the buffer", () => {
    const { clock, session, p0, p1 } = setup();
    const token = (p0.peer.of("welcome")[0].d as { token: string }).token;
    session.disconnect(p0.conn);
    for (let i = 0; i < SEND_BUFFER + 10; i++) {
      clock.advance(50);
      input(session, p1, i * 2, "cw");
    }
    const back = join(session);
    send(session, back, "resume", { token, peerAck: 2 });
    expect(back.peer.sent.map((m) => m.t)).toEqual(["error"]);
    expect(lastError(back)).toBe("resync");
    expect(p1.peer.last().t).toBe("opponentReconnected");
  });
});

describe("match: hostile messages", () => {
  it("rejects oversized and non-JSON messages without throwing", () => {
    const { session, p0 } = setup();
    const bad: (string | ArrayBuffer)[] = [
      "x".repeat(1025),
      JSON.stringify({ t: "ping", d: "é".repeat(600) }), // under 1024 chars, over 1024 bytes
      new ArrayBuffer(2048),
    ];
    for (const data of bad) {
      expect(() => session.message(p0.conn, data)).not.toThrow();
      expect(lastError(p0)).toBe("too-large");
    }
    for (const data of ["not json{", "", new ArrayBuffer(4)]) {
      expect(() => session.message(p0.conn, data)).not.toThrow();
      expect(lastError(p0)).toBe("bad-json");
    }
    for (const data of ["null", "[]", "42", '{"t":5}', '{"t":"teleport"}']) {
      expect(() => session.message(p0.conn, data)).not.toThrow();
      expect(["bad-message", "bad-type"]).toContain(lastError(p0));
    }
    expect(session.game(0)!.stats.inputs).toBe(0);
  });
});
