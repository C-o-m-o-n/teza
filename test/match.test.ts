import { describe, expect, it } from "vitest";
import { Action, Game, Handling } from "../src/engine/game";
import {
  Clock, Conn, Envelope, IDLE_TIMEOUT_MS, LOBBY_TIMEOUT_MS, MATCH_HANDLING, MAX_LAG_FRAMES, MAX_PENDING, MatchSession, Peer,
  RECONNECT_GRACE_MS, RESUME_TIMEOUT_MS, ResumeRequest, SEND_BUFFER, matchOptions,
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
      if (timer.at <= this.t && this.timers.has(id)) { // an earlier timer may have cleared it
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

function join(session: MatchSession, resume?: ResumeRequest): Player {
  const peer = new FakePeer();
  return { peer, conn: session.connect(peer, resume) };
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

  it("resets a match nobody joins in time, so the id can be used again", () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const p0 = join(session);
    clock.advance(LOBBY_TIMEOUT_MS - 1);
    expect(p0.peer.closed).toBeNull();
    clock.advance(1);
    expect(lastError(p0)).toBe("no-opponent");
    expect(p0.peer.closed).toMatchObject({ code: 1000 });
    expect(clock.pending).toBe(0);

    const again = join(session);
    expect(again.peer.of("welcome")[0].d).toMatchObject({ slot: 0 });
    const p1 = join(session);
    expect(p1.peer.of("start").length).toBe(1);
    expect(clock.pending).toBe(1); // the second lobby timer was cleared at start; only the idle timer is left
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
    input(session, p0, 70, "cw"); // server clock frame = 180, so 60 is the lowest frame allowed
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

  it("sends its handling in start, and IRS/IHS from held keys replay identically with it", () => {
    const { clock, session, p0, p1 } = setup();
    const start = p1.peer.of("start")[0].d as { seed: number; handling: Handling };
    expect(start.handling).toEqual(MATCH_HANDLING);
    expect(start.handling).toMatchObject({ irs: true, ihs: true });
    // cw and hold stay held across both hard drops, so the server applies IHS and IRS at each spawn
    const script: [number, Action, "press" | "release"][] = [
      [5, "cw", "press"], [6, "hold", "press"], [10, "hard", "press"], [20, "hard", "press"],
      [21, "cw", "release"], [22, "hold", "release"], [30, "hard", "press"],
    ];
    for (const [frame, action, kind] of script) {
      clock.advance(250);
      input(session, p0, frame, action, kind);
    }
    expect(p0.peer.of("error")).toEqual([]);
    const server = session.game(0)!;
    expect(server.stats.holds).toBe(3); // one pressed, two initial holds

    const replay = (handling: Handling) => {
      const g = new Game(matchOptions(start.seed), handling);
      for (const m of p1.peer.of("opponentInput")) {
        const d = m.d as { frame: number; action: Action; kind: string };
        g.advance(d.frame - g.frame);
        if (d.kind === "press") g.press(d.action);
        else g.release(d.action);
      }
      return g;
    };
    const same = replay(start.handling);
    expect(same.stats).toEqual(server.stats);
    expect(same.board).toEqual(server.board);
    expect(same.piece).toEqual(server.piece);
    expect(same.hold).toBe(server.hold);
    // a client that used its own settings instead would drift, which is why `start` carries them
    const own = replay({ ...start.handling, irs: false, ihs: false });
    expect(own.stats.holds).toBe(1);
    expect(own.board).not.toEqual(server.board);
  });

  it("rejects a frame too far behind the server clock", () => {
    const { clock, session, p0, p1 } = setup();
    clock.advance(3000); // server clock frame = 180
    const game = session.game(0)!;
    input(session, p0, 180 - MAX_LAG_FRAMES - 1, "cw");
    expect(lastError(p0)).toBe("frame-late");
    expect(game.stats.inputs).toBe(0);
    expect(game.frame).toBe(180 - MAX_LAG_FRAMES); // caught up, but the input was not applied
    expect(p1.peer.of("opponentInput")).toEqual([]);

    input(session, p0, 180 - MAX_LAG_FRAMES, "cw"); // exactly at the limit is fine
    expect(game.stats.inputs).toBe(1);
  });

  it("catches a silent player's engine up to the clock, deterministically, until they top out", () => {
    const { clock, session, p0, p1 } = setup();
    const quiet = session.game(1)!;
    clock.advance(5000); // server clock frame = 300
    send(session, p1, "ping"); // pinging alone does not hold the engine back
    expect(quiet.frame).toBe(300 - MAX_LAG_FRAMES);
    clock.advance(500); // frame 330
    input(session, p0, 330, "hard"); // the opponent's input catches it up too
    expect(quiet.frame).toBe(330 - MAX_LAG_FRAMES);
    expect(quiet.stats.inputs).toBe(0);

    // the catch-up runs on whole frames, so a replay of the relayed inputs still matches
    input(session, p1, 250, "hard");
    expect(p1.peer.of("error")).toEqual([]);
    const seed = (p1.peer.of("start")[0].d as { seed: number }).seed;
    const replay = new Game(matchOptions(seed));
    replay.advance(250);
    replay.press("hard");
    expect(replay.board).toEqual(quiet.board);
    expect(replay.piece).toEqual(quiet.piece);
    expect(replay.queue).toEqual(quiet.queue);

    // player 1 goes quiet for good; gravity alone tops them out while player 0 only pings
    for (let i = 0; i < 3600 && !session.isOver; i++) {
      clock.advance(1000);
      send(session, p0, "ping");
    }
    expect(session.isOver).toBe(true);
    expect(quiet.over).toBe(true);
    for (const p of [p0, p1]) {
      expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 0, reason: "topout" } })]);
    }
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

    // both sockets are closed after `end`, later input is ignored, and no timers are left
    expect(p0.peer.closed).toMatchObject({ code: 1000 });
    expect(p1.peer.closed).toMatchObject({ code: 1000 });
    const counts = [p0.peer.sent.length, p1.peer.sent.length];
    input(session, p1, frame, "hard");
    input(session, p0, frame + 1, "hard");
    session.disconnect(p0.conn);
    clock.advance(RECONNECT_GRACE_MS * 2);
    expect([p0.peer.sent.length, p1.peer.sent.length]).toEqual(counts);
    expect(session.game(1)!.stats.inputs).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("turns away new connections once the match is over", () => {
    const { clock, session, p0 } = setup();
    const token = (p0.peer.of("welcome")[0].d as { token: string }).token;
    session.disconnect(p0.conn);
    const waiting = join(session); // waiting to resume when the match ends
    clock.advance(RECONNECT_GRACE_MS);
    expect(session.isOver).toBe(true);
    expect(lastError(waiting)).toBe("ended");
    expect(waiting.peer.closed).not.toBeNull();

    const late = join(session);
    expect(lastError(late)).toBe("ended");
    expect(late.peer.closed).not.toBeNull();
    const back = join(session);
    expect(lastError(back)).toBe("ended");
    expect(() => send(session, back, "resume", { token, peerAck: 0 })).not.toThrow();
    expect(back.peer.of("error").length).toBe(1);
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
    expect(clock.pending).toBe(1); // the forfeit timer is gone; only the idle timer is left

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

describe("match: waiting sockets", () => {
  it("closes a socket that does not resume in time, even if it keeps pinging", () => {
    const { clock, session, p0 } = setup();
    session.disconnect(p0.conn);
    const idle = join(session);
    for (let t = 0; t < RESUME_TIMEOUT_MS - 1000; t += 1000) {
      clock.advance(1000);
      send(session, idle, "ping");
    }
    expect(idle.peer.closed).toBeNull();
    clock.advance(1000);
    expect(lastError(idle)).toBe("resume-timeout");
    expect(idle.peer.closed).toMatchObject({ code: 1008 });
    expect(session.isOver).toBe(false);
    expect(clock.pending).toBe(2); // only player 0's forfeit timer and the idle timer
  });

  it("caps the sockets waiting to resume", () => {
    const { clock, session, p0 } = setup();
    const token = (p0.peer.of("welcome")[0].d as { token: string }).token;
    session.disconnect(p0.conn);
    const waiting = Array.from({ length: MAX_PENDING }, () => join(session));
    expect(waiting.every((w) => w.peer.closed === null)).toBe(true);
    const extra = join(session);
    expect(lastError(extra)).toBe("busy");
    expect(extra.peer.closed).not.toBeNull();

    // a closed waiting socket frees its place, and its timer
    session.disconnect(waiting[0].conn);
    expect(clock.pending).toBe(3); // forfeit timer + one resume timer + idle timer
    const next = join(session);
    expect(next.peer.closed).toBeNull();
    send(session, next, "resume", { token, peerAck: 0 });
    expect(next.peer.of("error")).toEqual([]);
    expect(session.isOver).toBe(false);
    clock.advance(RESUME_TIMEOUT_MS);
    expect(waiting[1].peer.closed).not.toBeNull(); // the other one still times out
    expect(next.peer.closed).toBeNull();
    expect(clock.pending).toBe(1); // the idle timer
  });

  it("lets the owner resume with the upgrade token while an opponent floods the waiting places", () => {
    const { clock, session, p0, p1 } = setup();
    const token = (p0.peer.of("welcome")[0].d as { token: string }).token;
    session.disconnect(p0.conn);

    // player 1 keeps every waiting place taken: reopens sockets in a loop as they time out or get `busy`
    const flood: Player[] = [];
    for (let i = 0; i < 8; i++) flood.push(join(session));
    expect(flood.filter((f) => f.peer.closed === null).length).toBe(MAX_PENDING);
    for (let t = 0; t < 10_000; t += 500) {
      clock.advance(500);
      for (let i = 0; i < 8; i++) flood.push(join(session));
    }
    expect(flood.filter((f) => f.peer.closed === null).length).toBe(MAX_PENDING);
    expect(lastError(join(session))).toBe("busy"); // a plain socket is still turned away

    // a wrong upgrade token is refused at once and never takes a waiting place
    expect(session.hasToken("0".repeat(32))).toBe(false);
    const wrong = join(session, { token: "0".repeat(32), peerAck: 0 });
    expect(lastError(wrong)).toBe("bad-token");
    expect(wrong.peer.closed).toMatchObject({ code: 1008 });

    // the real player, with the token on the upgrade, is bound without waiting
    expect(session.hasToken(token)).toBe(true);
    const back = join(session, { token, peerAck: 2 });
    expect(back.peer.closed).toBeNull();
    expect(back.peer.of("error")).toEqual([]);
    expect(p1.peer.last().t).toBe("opponentReconnected");
    input(session, back, 10 * 60, "hard");
    expect(session.game(0)!.stats.inputs).toBe(1);

    clock.advance(RECONNECT_GRACE_MS);
    expect(session.isOver).toBe(false); // no forfeit
    expect(back.peer.closed).toBeNull();
  });
});

describe("match: idle", () => {
  it("ends a started match as a draw when nobody sends anything", () => {
    const { clock, session, p0, p1 } = setup();
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(session.isOver).toBe(false);
    clock.advance(1);
    expect(session.isOver).toBe(true);
    // both engines were run to the clock first; with no inputs neither tops out in 60 s
    expect(session.game(0)!.frame).toBe((IDLE_TIMEOUT_MS * 60) / 1000);
    expect(session.game(1)!.frame).toBe((IDLE_TIMEOUT_MS * 60) / 1000);
    for (const p of [p0, p1]) {
      expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: null, reason: "idle" } })]);
      expect(p.peer.closed).toMatchObject({ code: 1000 });
    }
    expect(clock.pending).toBe(0);
  });

  it("counts any valid message as activity and lets a top-out decide the match", () => {
    const { clock, session, p0, p1 } = setup();
    clock.advance(30_000);
    send(session, p0, "ping");
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(session.isOver).toBe(false); // the ping pushed the deadline back
    expect(clock.pending).toBe(1); // one idle timer, re-armed

    // an invalid message is not activity
    send(session, p1, "bogus");
    clock.advance(1);
    expect(session.isOver).toBe(true);
    expect(p0.peer.of("end").length).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("decides an idle match by who topped out first", () => {
    const { clock, session, p0, p1 } = setup();
    // player 0 stacks pieces fast, then everyone goes quiet; player 0 tops out before player 1
    let frame = 0;
    for (let i = 0; i < 6; i++) {
      clock.advance(100);
      frame += 6;
      input(session, p0, frame, "hard");
    }
    expect(session.isOver).toBe(false);
    clock.advance(IDLE_TIMEOUT_MS);
    expect(session.isOver).toBe(true);
    expect(session.game(0)!.over).toBe(true);
    expect(session.game(1)!.over).toBe(false);
    for (const p of [p0, p1]) {
      expect(p.peer.of("end")).toEqual([expect.objectContaining({ d: { winner: 1, reason: "topout" } })]);
    }
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
