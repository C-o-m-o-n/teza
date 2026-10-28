// Interface themes (src/ui/themes.ts) in Chromium against the production build in dist/: the pre-paint
// theme, each theme's first screen, the CONFIG switch, and Classic's wordmark drop.
import { expect, Page, test } from "@playwright/test";
import { resolve } from "node:path";
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
  // The theme as the parser reached the stylesheet link, and the page at DOMContentLoaded (App, a blocking
  // script at the end of <body>, has built its first screen by then).
  await page.addInitScript(() => {
    const w = window as unknown as { atLoad: Record<string, unknown>; atStylesheet?: string };
    new MutationObserver((records, observer) => {
      if (!records.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLLinkElement && n.rel === "stylesheet"))) return;
      w.atStylesheet = document.documentElement.dataset.theme ?? "unset";
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      w.atLoad = {
        atStylesheet: w.atStylesheet,
        theme: document.documentElement.dataset.theme,
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
        background: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
        screen: document.getElementById("ui")?.dataset.screen,
      };
    });
  });
});

test.afterEach(() => {
  expect(problems, "page errors and console.error calls").toEqual([]);
});

const atLoad = (page: Page) => page.evaluate(() => (window as unknown as { atLoad: Record<string, unknown> }).atLoad);
const ui = (page: Page) => page.locator("#ui");

test("Classic is the default: themed before first paint, straight to the menu", async ({ page }) => {
  await page.goto(server.url);
  expect(await atLoad(page)).toEqual({
    atStylesheet: "classic", theme: "classic", themeColor: "#08080f", background: "rgb(8, 8, 15)",
    font: '"Saira Semi Condensed", Saira, system-ui, sans-serif', screen: "menu",
  });
  await expect(ui(page)).toHaveAttribute("data-screen", "menu");
  await expect(page.locator(".title")).toHaveCount(0);
  await expect(page.locator(".wm-replay")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  const brand = page.locator(".menu > .brand h1");
  await expect(brand).toHaveAttribute("aria-label", "TEZA");
  await expect(brand).toHaveCSS("font-family", '"Russo One", Saira, system-ui, sans-serif');
  await expect(brand.locator("span").first()).toHaveText("TE");
  await expect(brand.locator(".slash")).toHaveText("A"); // the Z is drawn
  expect(await page.evaluate(() => document.fonts.check('400 64px "Russo One"') && document.fonts.check('400 17px "Saira Semi Condensed"'))).toBe(true);
});

test("Poster Slab: themed before first paint, opens on the title, a key reaches its menu", async ({ page }) => {
  await seedTheme(page, "poster");
  await page.goto(server.url);
  expect(await atLoad(page)).toEqual({
    atStylesheet: "poster", theme: "poster", themeColor: "#0b0b0c", background: "rgb(11, 11, 12)",
    font: '"Archivo Narrow", "Saira Semi Condensed", system-ui, sans-serif', screen: "title",
  });
  await expect(ui(page)).toHaveAttribute("data-screen", "title");
  await page.keyboard.press("KeyQ");
  await expect(ui(page)).toHaveAttribute("data-screen", "menu");
  await expect(page.locator(".menu > .brand .wm-replay .wordmark")).toHaveAttribute("aria-label", "TEZA");
  await expect(page.locator(".menu > .brand")).toHaveCSS("background-color", "rgb(224, 48, 30)");
});

test("an unknown saved theme falls back to Classic", async ({ page }) => {
  await seedTheme(page, "neon");
  await page.goto(server.url);
  expect((await atLoad(page)).theme).toBe("classic");
  await expect(ui(page)).toHaveAttribute("data-screen", "menu");
});

test("CONFIG > STYLE switches the theme live, it persists, and RESET returns to Classic", async ({ page }) => {
  await openMenu(page, server.url);
  await page.locator("button.bar", { hasText: "CONFIG" }).click();
  const panels = page.locator(".panels > .panel h2");
  await expect(panels.first()).toHaveText("STYLE");
  const select = page.locator('select[name="theme"]');
  await expect(select.locator("option")).toHaveText(["Classic", "Poster Slab"]);
  await expect(select).toHaveValue("classic");

  await select.selectOption("poster");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "poster");
  await expect(ui(page)).toHaveAttribute("data-screen", "config"); // no title screen
  await expect(page.locator(".title")).toHaveCount(0);
  await expect(page.locator(".config > .brand")).toHaveCSS("background-color", "rgb(224, 48, 30)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0b0c");
  await expect(page.locator('select[name="theme"]')).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("teza:settings")!).theme)).toBe("poster");

  await page.reload();
  expect((await atLoad(page)).theme).toBe("poster");
  await expect(ui(page)).toHaveAttribute("data-screen", "title");
  await page.keyboard.press("KeyQ");
  await page.locator("button.bar", { hasText: "CONFIG" }).click();
  await expect(page.locator('select[name="theme"]')).toHaveValue("poster");

  await page.locator("button", { hasText: "RESET TO DEFAULTS" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  await expect(page.locator('select[name="theme"]')).toHaveValue("classic");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#08080f");
  await expect(ui(page)).toHaveAttribute("data-screen", "config");
});

/** The Z's pieces: their fills, and their running animations' count and end time from now (ms). */
function zPieces(page: Page) {
  return page.evaluate(async () => {
    const cells = [...document.querySelectorAll<SVGPolygonElement>(".brand svg polygon")];
    const anims = cells.flatMap((c) => c.getAnimations());
    const t0 = performance.now();
    await Promise.all(anims.map((a) => a.finished));
    return {
      count: cells.length,
      fills: cells.map((c) => getComputedStyle(c).fill),
      running: anims.length,
      doneAfter: performance.now() - t0,
      transforms: cells.map((c) => getComputedStyle(c).transform),
    };
  });
}

test("Classic wordmark: four blue pieces that drop in once as the menu opens", async ({ page }) => {
  await page.goto(server.url);
  await expect(ui(page)).toHaveAttribute("data-screen", "menu");
  const z = await zPieces(page);
  expect(z.count).toBe(4);
  expect(z.fills).toEqual(Array(4).fill("rgb(63, 107, 255)"));
  expect(z.running).toBe(4);
  expect(z.doneAfter).toBeLessThan(1000);
  expect(z.transforms).toEqual(Array(4).fill("none"));
  // not on the other screens' headers
  await page.locator("button.bar", { hasText: "VERSUS" }).click();
  await expect(page.locator(".brand svg")).toHaveCount(0);
  // and again on returning to the menu
  await page.keyboard.press("Escape");
  expect((await zPieces(page)).running).toBe(4);
});

test("Classic wordmark: no drop with reduced motion, from the OS or CONFIG", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.url);
  await expect(ui(page)).toHaveAttribute("data-screen", "menu");
  expect(await zPieces(page)).toMatchObject({ count: 4, running: 0, transforms: Array(4).fill("none") });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("button.bar", { hasText: "CONFIG" }).click();
  await page.locator("label.row", { hasText: "Reduce motion" }).locator("input").check();
  await page.keyboard.press("Escape");
  expect(await zPieces(page)).toMatchObject({ count: 4, running: 0 });
});

for (const theme of ["classic", "poster"]) {
  test(`${theme}: VERSUS offers CREATE ROOM, JOIN ROOM, RANKED 1V1, LEADERBOARD and WATCH LIVE, which say so when there is no game server`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await seedTheme(page, theme);
    await openMenu(page, server.url);
    await page.locator("button.bar", { hasText: "VERSUS" }).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");
    const titles = page.locator("nav.bars .bar-title");
    await expect(titles).toHaveText(["ROOKIE", "CASUAL", "RANKED", "PRO", "CREATE ROOM", "JOIN ROOM", "RANKED 1V1", "LEADERBOARD", "WATCH LIVE"]);
    // all nine fit a 1280x720 screen, and nothing runs off it sideways
    for (const box of await page.locator("nav.bars .bar").evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect().toJSON()))) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(720);
      expect(box.right).toBeLessThanOrEqual(1280);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

    // this static server answers /api/* with 204: no rooms or queue here, and the page stays
    const alert = page.locator(".form-error");
    for (const bar of ["CREATE ROOM", "JOIN ROOM", "RANKED 1V1"]) {
      await page.locator("button.bar", { hasText: bar }).click();
      await expect(alert).toHaveText("Online play isn't available here");
      await expect(ui(page)).toHaveAttribute("data-screen", "bots");
    }

    // with a game server (GET /api/room says so), JOIN's field takes the theme's input style (no socket is opened)
    await page.route("**/api/room", (route) => route.fulfill(route.request().method() === "GET"
      ? { status: 200, json: { online: true } } : { status: 201, json: { code: "ABCDEF" } }));
    await page.locator("button.bar", { hasText: "JOIN ROOM" }).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "lobby");
    const field = page.locator('input[name="room"]');
    await expect(field).toBeFocused();
    await page.keyboard.type("ab1-c2d3");
    await expect(field).toHaveValue("AB1C2D");
    await expect(field).toHaveCSS("font-family", theme === "poster" ? '"Big Shoulders Display", "Russo One", system-ui, sans-serif' : '"Russo One", Saira, system-ui, sans-serif');
    await expect(field).toHaveCSS("border-bottom-width", "2px");
    const box = (await field.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    await page.keyboard.press("Escape");
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");
  });
}

// Classic keeps its full-size VERSUS bars (min-height 80 px, 38 px titles) wherever all nine fit beside the title, and the
// stacked phone layout keeps them too; only shorter side-by-side screens get the tighter stack
for (const size of [{ width: 1280, height: 900 }, { width: 1440, height: 900 }, { width: 1280, height: 899 }, { width: 390, height: 844 }]) {
  test(`classic: VERSUS bar size at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openMenu(page, server.url);
    await page.locator("button.bar", { hasText: "VERSUS" }).click();
    const full = size.height >= 900 || size.width <= 860;
    const bars = page.locator("nav.bars .bar");
    await expect(bars).toHaveCount(9);
    await expect(bars.first().locator(".bar-title")).toHaveCSS("font-size", full ? "38px" : "29px");
    const boxes = await bars.evaluateAll((els) => els.map((b) => b.getBoundingClientRect().toJSON()));
    for (const box of boxes) expect(full ? box.height >= 80 : box.height < 80).toBe(true);
    if (size.width > 860) {
      const hint = (await page.locator(".hint").boundingBox())!;
      expect(boxes[0].top).toBeGreaterThanOrEqual(0);
      expect(boxes[8].bottom).toBeLessThanOrEqual(hint.y);
    }
  });
}

for (const theme of ["classic", "poster"]) {
  test(`${theme}: RANKED 1V1 asks to sign in, searches with the range and own TR, and ESC leaves the queue`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await seedTheme(page, theme);
    await openMenu(page, server.url);
    await page.locator("button.bar", { hasText: "VERSUS" }).click();
    const alert = page.locator(".form-error");

    // a game server, signed out: it says so and stays on VERSUS
    await page.route("**/api/account/queue/join", (route) => route.fulfill({ status: 401, json: { error: "Not signed in." } }));
    await page.locator("button.bar", { hasText: "RANKED 1V1" }).click();
    await expect(alert).toHaveText("Sign in to play ranked");
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");
    // the browser logs the refused request itself; that one is expected here
    problems = problems.filter((p) => !p.includes("status of 401"));

    // signed in: the search screen, polling every 2 s; nobody is found, so no socket is opened
    const calls: string[] = [];
    let polls = 0;
    await page.unroute("**/api/account/queue/join");
    await page.route("**/api/account/queue/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(`${route.request().method()} ${path}`);
      if (path.endsWith("/status")) {
        polls++;
        return route.fulfill({ json: { status: "waiting", waited: polls * 2, range: polls > 1 ? 1000 : 500 } });
      }
      return route.fulfill({ json: { status: path.endsWith("/join") ? "waiting" : "none" } });
    });
    await page.route("**/api/account/me", (route) => route.fulfill({
      json: { username: "Alice", createdAt: 0, records: { vs: {} }, rating: { tr: null, games: 2 } },
    }));
    await page.locator("button.bar", { hasText: "RANKED 1V1" }).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "queue");
    const box = page.locator(".room.queue");
    await expect(box).toContainText("SEARCHING");
    await expect(box.locator(".stat", { hasText: "YOUR TR" })).toContainText("TR HIDDEN");
    await expect(box.locator(".stat", { hasText: "RANGE" })).toContainText("±500");
    await expect(box.locator(".stat", { hasText: "RANGE" })).toContainText("±1000", { timeout: 5000 });
    await expect(page.locator(".room-code")).not.toHaveText("0:00");
    // legible: the theme's text colour on its background, and the box stays on screen
    for (const sel of [".room .account-label", ".room .stat strong", ".room-code"]) {
      const color = await page.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
      expect(color).not.toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    }
    const rect = (await box.boundingBox())!;
    expect(rect.x + rect.width).toBeLessThanOrEqual(1280);
    expect(rect.y + rect.height).toBeLessThanOrEqual(720);

    await page.keyboard.press("Escape");
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");
    await expect.poll(() => calls.filter((c) => c === "POST /api/account/queue/leave").length).toBe(1);
    expect(calls[0]).toBe("POST /api/account/queue/join");
    const after = polls;
    await page.waitForTimeout(2500);
    expect(polls).toBe(after); // polling stopped
  });
}
