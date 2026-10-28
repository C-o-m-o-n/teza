// WATCH LIVE (VERSUS > LEADERBOARD > WATCH LIVE) in Chromium against the production build in dist/, with /api/live
// mocked and the match socket mocked by page.routeWebSocket, in both themes at desktop and phone sizes.
// Screenshots go to $E2E_SHOTS when it is set.
import { expect, Page, test, WebSocketRoute } from "@playwright/test";
import { join, resolve } from "node:path";
import { MATCH_HANDLING, matchOptions } from "../src/server/match";
import { openMenu, seedTheme } from "./menu";
import { serveDist } from "./server";

let server: Awaited<ReturnType<typeof serveDist>>;
let problems: string[];

test.beforeAll(async () => {
  server = await serveDist(resolve("dist"));
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
});

test.afterEach(() => {
  expect(problems, "page errors and console.error calls").toEqual([]);
});

const ui = (page: Page) => page.locator("#ui");

const MATCHES = () => [
  { code: "ABCDEF", startedAt: Date.now() - 125_000, players: [{ username: "Zuri_Top", tr: 21456 }, { username: "<b>x</b>", tr: null }] },
  { code: "GHJKMN", startedAt: Date.now() - 4_000, players: [{ username: "longest-name_xyz", tr: 12345 }, { username: "longest-name_abc", tr: 9876 }] },
  { code: "PQRSTU", startedAt: Date.now() - 600_000, players: [{ username: "Amani", tr: 15000 }, { username: "Baraka", tr: 14999 }], extra: "dropped" },
];

/** A spectate message: the real VS rules and a few events on both boards, garbage included. */
function spectate(): string {
  const events = [
    { k: "input", slot: 0, frame: 20.5, action: "left", kind: "press" },
    { k: "input", slot: 0, frame: 20.5, action: "left", kind: "release" },
    { k: "input", slot: 0, frame: 30, action: "hard", kind: "press" },
    { k: "input", slot: 1, frame: 31.25, action: "cw", kind: "press" },
    { k: "input", slot: 1, frame: 40, action: "hard", kind: "press" },
    { k: "garbage", slot: 1, amount: 2, frame: 40 },
  ];
  return JSON.stringify({ t: "spectate", s: 1, a: 0, d: { seed: 4242, options: matchOptions(4242), handling: MATCH_HANDLING, events, elapsed: 60 } });
}

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) });
}

/** Text that overflows its box sideways (clipped) or two text boxes that overlap, on the current screen. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const leaves = [...document.querySelectorAll<HTMLElement>("#ui .ladder-row > span, #ui .form-error, #ui .note, #ui .account-label, #ui .results p")]
      .filter((e) => e.offsetParent !== null && e.textContent);
    for (const e of leaves) {
      const r = e.getBoundingClientRect();
      if (e.scrollWidth > e.clientWidth + 1) out.push(`clipped: ${e.className || e.tagName} "${e.textContent}"`);
      if (r.right > vw + 0.5 || r.left < -0.5) out.push(`off screen: "${e.textContent}"`);
    }
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
        const a = leaves[i].getBoundingClientRect();
        const b = leaves[j].getBoundingClientRect();
        if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          out.push(`overlap: "${leaves[i].textContent}" / "${leaves[j].textContent}"`);
        }
      }
    }
    return out;
  });
}

/** Whether the canvas has drawn something (not the background) in its left and right halves: two boards. */
async function boardsDrawn(page: Page): Promise<[boolean, boolean]> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("canvas#game")!;
    const ctx = c.getContext("2d")!;
    const half = (x0: number) => {
      const { data } = ctx.getImageData(x0, Math.floor(c.height * 0.3), Math.floor(c.width / 2), Math.floor(c.height * 0.4));
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 200) lit++;
      return lit > 500;
    };
    return [half(0), half(Math.floor(c.width / 2))];
  });
}

async function mockLive(page: Page, matches: unknown = MATCHES()): Promise<{ fetches: () => number }> {
  let n = 0;
  await page.route("**/api/live", (route) => {
    n++;
    return route.fulfill({ json: { matches } });
  });
  return { fetches: () => n };
}

/** The match socket: records every frame the page sends; `open` decides what the server does on connect. */
async function mockSocket(page: Page, open: (ws: WebSocketRoute) => void = (ws) => ws.send(spectate())) {
  const frames: string[] = [];
  const urls: string[] = [];
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket("**/api/match/*", (ws) => {
    urls.push(ws.url());
    socket = ws;
    ws.onMessage((m) => frames.push(String(m)));
    open(ws);
  });
  return { frames, urls, socket: () => socket! };
}

async function openLeaderboard(page: Page, theme: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await seedTheme(page, theme);
  await openMenu(page, server.url);
  await page.locator("button.bar", { hasText: "VERSUS" }).click();
  await expect(ui(page)).toHaveAttribute("data-screen", "bots");
  await expect(page.locator("nav.bars .bar")).toHaveCount(8); // VERSUS keeps its eight bars: WATCH LIVE is on the LEADERBOARD
  await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
  await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");
}

const watchLive = (page: Page) => page.locator("button.ghost-btn", { hasText: "WATCH LIVE" });

for (const theme of ["classic", "poster"]) {
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const tag = `${theme}-${size.width}x${size.height}`;
    const desktop = size.width > 860;

    test(`${tag}: WATCH LIVE lists the live matches, a row opens the spectator screen, ESC and end lead back`, async ({ page }) => {
      const live = await mockLive(page);
      const sock = await mockSocket(page);
      await openLeaderboard(page, theme, size);
      const bar = watchLive(page);
      await expect(bar).toBeVisible();
      await bar.click();
      await expect(ui(page)).toHaveAttribute("data-screen", "live");
      const rows = page.locator(".live-row");
      await expect(rows).toHaveCount(3);
      await expect(rows.first()).toBeFocused();
      await expect(rows.locator(".ladder-name")).toHaveText(["Zuri_Top vs <b>x</b>", "longest-name_xyz vs longest-name_abc", "Amani vs Baraka"]);
      await expect(page.locator(".ladder b")).toHaveCount(0); // server text is text
      await expect(rows.locator(".ladder-tr")).toHaveText(["TR 21,456 · TR ?", "TR 12,345 · TR 9,876", "TR 15,000 · TR 14,999"]);
      await expect(rows.first().locator(".live-time")).toHaveText(/^2:0\d$/);
      await expect(rows.nth(2).locator(".live-time")).toHaveText(/^10:0\d$/);
      await expect(page.locator(".hint")).toHaveText("ENTER to watch · ESC to go back");
      await expect(page.locator("button", { hasText: "REFRESH" })).toHaveClass(/ghost-btn/);
      expect(await layoutProblems(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await shot(page, `${tag}-live`);

      // REFRESH asks again
      const before = live.fetches();
      await page.locator("button", { hasText: "REFRESH" }).click();
      await expect.poll(live.fetches).toBe(before + 1);

      // ESC goes back to the LEADERBOARD
      await page.keyboard.press("Escape");
      await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");
      await bar.click();
      await expect(rows).toHaveCount(3);

      // the first row: the spectator socket, the play screen with two boards
      await rows.first().click();
      await expect(ui(page)).toHaveAttribute("data-screen", "play");
      expect(sock.urls).toHaveLength(1);
      expect(new URL(sock.urls[0]).pathname).toBe("/api/match/ABCDEF");
      expect(new URL(sock.urls[0]).searchParams.get("mode")).toBe("spectate");
      await expect.poll(() => boardsDrawn(page)).toEqual([true, true]);
      // the LIVE tag: a real element with the match clock (from the server's elapsed frame), which runs while the boards rest
      const liveTag = page.locator("#ui .spectate-tag");
      await expect(liveTag).toBeVisible();
      await expect(liveTag).toHaveText(/^LIVE · 0:0\d · ESC TO LEAVE$/);
      await expect(liveTag).toHaveAttribute("aria-label", "Watching Zuri_Top versus <b>x</b> live. Press Escape to leave.");
      const at = await liveTag.locator(".spectate-clock").textContent();
      await expect(liveTag.locator(".spectate-clock")).not.toHaveText(at!, { timeout: 2500 });
      const box = (await liveTag.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      // game keys do nothing and send nothing
      for (const key of ["Space", "ArrowLeft", "ArrowRight", "ArrowDown", "KeyZ", "KeyX", "KeyC", "KeyA", "ShiftLeft", "KeyR"]) await page.keyboard.press(key);
      await page.waitForTimeout(300);
      await expect(ui(page)).toHaveAttribute("data-screen", "play");
      expect(sock.frames.filter((f) => JSON.parse(f).t !== "ping")).toEqual([]);
      await shot(page, `${tag}-watching`);

      // ESC leaves (the socket closes) and returns to the list
      await page.keyboard.press("Escape");
      await expect(ui(page)).toHaveAttribute("data-screen", "live");
      await expect(rows).toHaveCount(3);

      // again, until the server's end: the winner by name, then back to the list
      await rows.first().click();
      await expect(ui(page)).toHaveAttribute("data-screen", "play");
      expect(sock.urls).toHaveLength(2);
      if (desktop) {
        await page.waitForTimeout(10_500); // one ping, nothing else
        expect(sock.frames.map((f) => JSON.parse(f).t)).toContain("ping");
      }
      expect(sock.frames.filter((f) => JSON.parse(f).t !== "ping")).toEqual([]);
      sock.socket().send(JSON.stringify({ t: "specEvent", s: 2, a: 0, d: { k: "garbage", slot: 0, amount: 3, frame: 90 } }));
      sock.socket().send(JSON.stringify({ t: "end", s: 3, a: 0, d: { winner: 1, reason: "topout" } }));
      await expect(ui(page)).toHaveAttribute("data-screen", "results");
      const results = page.locator(".results");
      await expect(results.locator(".big")).toHaveText("<b>x</b> WINS");
      await expect(results.locator(".badge")).toHaveText("FINAL · BY TOP-OUT");
      await expect(results.locator("b")).toHaveCount(0);
      await expect(results.locator("button")).toHaveText("WATCH LIVE  ·  ESC");
      expect(await layoutProblems(page)).toEqual([]);
      await shot(page, `${tag}-ended`);
      await page.waitForTimeout(700); // results ignore keys at first
      await page.keyboard.press("Escape");
      await expect(ui(page)).toHaveAttribute("data-screen", "live");
      await expect(rows).toHaveCount(3);
      expect(sock.frames.filter((f) => JSON.parse(f).t !== "ping")).toEqual([]);
    });
  }

  test(`${theme}: an empty list says so, a failing fetch is unavailable, and a refused socket is not live any more`, async ({ page }) => {
    // the match will have ended between the list and the click: the socket closes before spectate
    const sock = await mockSocket(page, (ws) => void ws.close({ code: 1008, reason: "not-live" }));
    await openLeaderboard(page, theme, { width: 1280, height: 720 });
    // the static server answers /api/* with 204
    await watchLive(page).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "live");
    await expect(page.locator(".live .form-error")).toHaveText("Online play isn't available here");
    await expect(page.locator(".live-row")).toHaveCount(0);
    await expect(page.locator(".hint")).toHaveText("ESC to go back");
    await shot(page, `${theme}-live-unavailable`);
    await page.keyboard.press("Escape");
    await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");

    // a server error is not "no server": it says so and tries again
    await page.route("**/api/live", (route) => route.fulfill({ status: 500, body: "oops" }));
    await watchLive(page).click();
    await expect(page.locator(".live .form-error")).toHaveText("Couldn't load the live matches. Trying again…");
    await expect(page.locator(".live .note")).toHaveText("");
    problems = problems.filter((p) => !p.includes("status of 500")); // the browser logs the failed request itself
    await page.keyboard.press("Escape");
    await page.unroute("**/api/live");

    await mockLive(page, []);
    await watchLive(page).click();
    await expect(page.locator(".live .note")).toHaveText("No ranked matches are live right now.");
    await expect(page.locator(".live .form-error")).toHaveText("");
    await shot(page, `${theme}-live-empty`);
    await page.keyboard.press("Escape");
    await page.unroute("**/api/live");

    await mockLive(page);
    await watchLive(page).click();
    await page.locator(".live-row").first().click();
    await expect(page.locator(".live .form-error")).toHaveText("That match is not live any more.");
    await expect(ui(page)).toHaveAttribute("data-screen", "live");
    expect(sock.urls).toHaveLength(1);
    expect(sock.frames).toEqual([]);
    await shot(page, `${theme}-live-gone`);
  });
}

test("the list re-fetches every 10 s while shown, and stops on leaving", async ({ page }) => {
  const live = await mockLive(page);
  await openLeaderboard(page, "classic", { width: 1280, height: 720 });
  await watchLive(page).click();
  await expect.poll(live.fetches).toBe(1);
  await expect.poll(live.fetches, { timeout: 12_000 }).toBe(2);
  await page.keyboard.press("Escape");
  const left = live.fetches();
  await page.waitForTimeout(11_000);
  expect(live.fetches()).toBe(left);
});
