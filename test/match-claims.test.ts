// Server hardening in src/server/match.ts: constant-time token compare, the resume subprotocol and
// issued room codes (a `mode=create` needs a live claim from `POST /api/room`).
import { describe, expect, it } from "vitest";
import {
  CLAIM_KEY, LOBBY_TIMEOUT_MS, MatchSession, ROOM_CLAIM_MS, admit, issueClaim, resumeRequest, timingSafeEqual,
  upgradeHeaders,
} from "../src/server/match";
import { FakeClock, MemoryClaims, join, lastError, send } from "./match-harness";

const TOKEN = "0123456789abcdef0123456789abcdef";
const protocols = (value: string) => new Headers({ "Sec-WebSocket-Protocol": value });

describe("match: token compare", () => {
  it("timingSafeEqual is true only for equal strings", () => {
    expect(timingSafeEqual("ab", "ab")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("ab", "ac")).toBe(false);
    expect(timingSafeEqual("ab", "ba")).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual(TOKEN, TOKEN.slice(0, 31) + "0")).toBe(false);
  });

  it("finds either slot's token, upgrade or in-band", () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const p0 = join(session);
    const p1 = join(session);
    const t0 = (p0.peer.of("welcome")[0].d as { token: string }).token;
    const t1 = (p1.peer.of("welcome")[0].d as { token: string }).token;
    expect(session.hasToken(t0)).toBe(true);
    expect(session.hasToken(t1)).toBe(true);
    expect(session.hasToken(t1.slice(0, 31))).toBe(false);
    session.disconnect(p1.conn);
    const back = join(session);
    send(session, back, "resume", { token: t1, peerAck: 0 });
    expect(back.peer.of("error")).toEqual([]);
    expect(back.peer.closed).toBeNull();
  });
});

describe("match: resume subprotocol", () => {
  it("reads teza, resume.<token>.<ack>", () => {
    expect(resumeRequest(new Headers())).toBeUndefined();
    expect(resumeRequest(protocols("teza"))).toBeUndefined();
    expect(resumeRequest(protocols(`teza, resume.${TOKEN}.5`))).toEqual({ token: TOKEN, peerAck: 5 });
    expect(resumeRequest(protocols(`resume.${TOKEN}.0,teza`))).toEqual({ token: TOKEN, peerAck: 0 });
  });

  it("refuses a malformed, doubled or teza-less resume", () => {
    for (const bad of [
      `teza, resume.${TOKEN.toUpperCase()}.5`, `teza, resume.${TOKEN.slice(1)}.5`, `teza, resume.${TOKEN}.`, `teza, resume.${TOKEN}.-1`,
      `teza, resume.${TOKEN}.1e3`, `teza, resume.${TOKEN}.${"9".repeat(16)}`, `teza, resume.${TOKEN}`, "teza, resume", `resume.${TOKEN}.5`,
      `teza, resume.${TOKEN}.5, resume.${TOKEN}.6`,
    ]) {
      expect(resumeRequest(protocols(bad)), bad).toBeNull();
    }
  });

  it("answers with teza only, never the token", () => {
    expect([...upgradeHeaders(protocols(`teza, resume.${TOKEN}.5`))]).toEqual([["sec-websocket-protocol", "teza"]]);
    expect([...upgradeHeaders(protocols("teza"))]).toEqual([["sec-websocket-protocol", "teza"]]);
    expect([...upgradeHeaders(new Headers())]).toEqual([]);
  });
});

describe("match: issued room codes", () => {
  it("creates a code only with a claim from POST /api/room, once", async () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const claims = new MemoryClaims();
    expect(await admit(session, claims, "create", null, clock.now())).toEqual({ status: 404, message: "Room code was not issued" });

    expect(await issueClaim(session, claims, clock.now())).toBe(clock.now() + ROOM_CLAIM_MS);
    expect(claims.map.get(CLAIM_KEY)).toBe(clock.now() + ROOM_CLAIM_MS);
    expect(await issueClaim(session, claims, clock.now())).toBeNull(); // claimed already: the Worker draws another code
    expect(await admit(session, claims, "create", null, clock.now())).toBeNull();
    expect(claims.map.size).toBe(0); // consumed
    join(session);

    expect(await admit(session, claims, "create", null, clock.now())).toMatchObject({ status: 409 });
    expect(await issueClaim(session, claims, clock.now())).toBeNull(); // in use
    expect(await admit(session, claims, "join", null, clock.now())).toBeNull(); // join needs no claim
  });

  it("refuses a create with the claim already used, even once the room is free again", async () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const claims = new MemoryClaims();
    await issueClaim(session, claims, clock.now());
    expect(await admit(session, claims, "create", null, clock.now())).toBeNull();
    const p0 = join(session);
    clock.advance(LOBBY_TIMEOUT_MS); // no-opponent frees the code
    expect(lastError(p0)).toBe("no-opponent");
    expect(await admit(session, claims, "create", null, clock.now())).toMatchObject({ status: 404 });
    expect(await issueClaim(session, claims, clock.now())).not.toBeNull(); // a fresh claim brings it back
    expect(await admit(session, claims, "create", null, clock.now())).toBeNull();
  });

  it("refuses an expired claim and lets the code be issued again", async () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const claims = new MemoryClaims();
    await issueClaim(session, claims, clock.now());
    clock.advance(ROOM_CLAIM_MS);
    expect(await admit(session, claims, "create", null, clock.now())).toMatchObject({ status: 404 });
    expect(claims.map.size).toBe(0);

    await issueClaim(session, claims, clock.now());
    clock.advance(ROOM_CLAIM_MS - 1);
    expect(await issueClaim(session, claims, clock.now())).toBeNull();
    clock.advance(1);
    expect(await issueClaim(session, claims, clock.now())).not.toBeNull(); // an expired claim is replaced
  });

  it("never issues a ranked or finished room", async () => {
    const clock = new FakeClock();
    const ranked = new MatchSession(clock, undefined, { accounts: ["a", "b"], report: async () => null, noShow: async () => {} });
    expect(await issueClaim(ranked, new MemoryClaims(), clock.now())).toBeNull();

    const done = new MatchSession(clock);
    const claims = new MemoryClaims();
    await issueClaim(done, claims, clock.now());
    await admit(done, claims, "create", null, clock.now());
    const p0 = join(done);
    join(done);
    done.disconnect(p0.conn);
    clock.advance(60_000); // forfeit
    expect(done.isOver).toBe(true);
    expect(await issueClaim(done, claims, clock.now())).toBeNull();
  });

  it("leaves mode checks, join and ranked as they were", async () => {
    const clock = new FakeClock();
    const session = new MatchSession(clock);
    const claims = new MemoryClaims();
    expect(await admit(session, claims, null, null, clock.now())).toMatchObject({ status: 400 });
    expect(await admit(session, claims, "join", null, clock.now())).toMatchObject({ status: 404 });
    expect(await admit(session, claims, "ranked", "a", clock.now())).toMatchObject({ status: 404 });
  });
});
