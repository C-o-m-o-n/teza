import { describe, expect, it } from "vitest";
import source from "../sw.js?raw";

const ORIGIN = "https://teza.comonhq.com";

/** Runs sw.js against a stub `self`, returning its fetch listener. */
function loadWorker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = { location: new URL(`${ORIGIN}/sw.js`), addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn) };
  const caches = { open: () => new Promise(() => {}) };
  new Function("self", "caches", source)(self, caches);
  return listeners.fetch;
}

/** True when the worker answers the request (calls respondWith). */
function intercepts(url: string, init: RequestInit = {}): boolean {
  let answered = false;
  loadWorker()({ request: new Request(url, init), respondWith: () => (answered = true) });
  return answered;
}

describe("service worker routing", () => {
  it("serves same-origin static GETs", () => {
    expect(intercepts(`${ORIGIN}/`)).toBe(true);
    expect(intercepts(`${ORIGIN}/game.js`)).toBe(true);
    expect(intercepts(`${ORIGIN}/fonts/russo-one-400.woff2`)).toBe(true);
  });

  it("never intercepts /api/*", () => {
    expect(intercepts(`${ORIGIN}/api/account/me`)).toBe(false);
    expect(intercepts(`${ORIGIN}/api/records`, { method: "PUT", body: "{}" })).toBe(false);
    expect(intercepts(`${ORIGIN}/api/match/abc`, { headers: { Upgrade: "websocket" } })).toBe(false);
  });

  it("ignores non-GET, WebSocket upgrades and cross-origin requests", () => {
    expect(intercepts(`${ORIGIN}/`, { method: "POST", body: "x" })).toBe(false);
    expect(intercepts(`${ORIGIN}/`, { headers: { Upgrade: "websocket" } })).toBe(false);
    expect(intercepts("https://fonts.gstatic.com/x.woff2")).toBe(false);
  });
});
