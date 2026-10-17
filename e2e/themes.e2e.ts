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
