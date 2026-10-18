// LEADERBOARD and PROFILE (VERSUS > LEADERBOARD) in Chromium against the production build in dist/, with
// /api/leaderboard and /api/profile/* mocked, in both themes and at desktop and phone sizes.
// Screenshots go to $E2E_SHOTS when it is set.
import { expect, Page, test } from "@playwright/test";
import { join, resolve } from "node:path";
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

const PLAYERS = [
  { rank: 1, username: "Zuri_Top", tr: 21456, games: 212 },
  { rank: 2, username: "<b>bold</b>", tr: 18003, games: 77 },
  { rank: 3, username: "longest-name_xyz", tr: 12345, games: 1043 },
  ...Array.from({ length: 47 }, (_, i) => ({ rank: i + 4, username: `player${i + 4}`, tr: 12000 - i * 100, games: 20 + i })),
];

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) });
}

/** Text that overflows its box sideways (clipped) or two text boxes that overlap, on the current screen. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const leaves = [...document.querySelectorAll<HTMLElement>("#ui .ladder-row > span, #ui .stat span, #ui .stat strong, #ui .account-name, #ui .form-error, #ui .note, #ui .account-label")]
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

async function mock(page: Page, players = PLAYERS): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/leaderboard", (route) => route.fulfill({ json: { players } }));
  await page.route("**/api/profile/*", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    asked.push(name);
    if (name === "Zuri_Top") return route.fulfill({ json: { username: "Zuri_Top", joined: Date.UTC(2026, 9, 1), rating: { tr: 21456, games: 212 }, rank: 1 } });
    if (name === "<b>bold</b>") return route.fulfill({ json: { username: "<b>bold</b>", joined: Date.UTC(2026, 9, 2), rating: { tr: 18003, games: 77 }, rank: 2 } });
    if (name === "longest-name_xyz") return route.fulfill({ json: { username: "longest-name_xyz", joined: Date.UTC(2026, 9, 3), rating: { tr: null, games: 9 }, rank: null } });
    return route.fulfill({ status: 404, json: { error: "No such player." } });
  });
  return asked;
}

async function openVersus(page: Page, theme: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await seedTheme(page, theme);
  await openMenu(page, server.url);
  await page.locator("button.bar", { hasText: "VERSUS" }).click();
  await expect(ui(page)).toHaveAttribute("data-screen", "bots");
}

for (const theme of ["classic", "poster"]) {
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const tag = `${theme}-${size.width}x${size.height}`;

    test(`${tag}: LEADERBOARD lists players in rank order, a row opens the PROFILE, ESC goes back twice`, async ({ page }) => {
      const asked = await mock(page);
      await openVersus(page, theme, size);
      await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
      await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");
      const rows = page.locator(".ladder-row");
      await expect(rows).toHaveCount(50);
      await expect(rows.locator(".ladder-rank")).toHaveText(PLAYERS.map((p) => `#${p.rank}`));
      await expect(rows.first()).toContainText("Zuri_Top");
      await expect(rows.first().locator(".ladder-tr")).toHaveText("TR 21,456");
      await expect(rows.nth(2).locator(".ladder-games")).toHaveText("1043 GAMES");
      // server text is text: the tag shows literally and makes no element
      await expect(rows.nth(1).locator(".ladder-name")).toHaveText("<b>bold</b>");
      await expect(page.locator(".ladder b")).toHaveCount(0);
      await expect(rows.first()).toBeFocused();
      await expect(page.locator(".hint")).toHaveText("ENTER for a profile · ESC to go back");
      expect(await layoutProblems(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await shot(page, `${tag}-leaderboard`);

      // keyboard: down to the second row, ENTER opens it
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(1)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(ui(page)).toHaveAttribute("data-screen", "profile");
      const box = page.locator(".profile");
      await expect(box.locator(".account-name")).toHaveText("<b>bold</b>");
      const stats = box.locator(".stat strong");
      await expect(box.locator(".stat span")).toHaveText(["STANDING", "RATING", "RANKED GAMES", "JOINED"]);
      await expect(stats).toHaveText(["RANK #2", "TR 18,003", "77", "Oct 2, 2026"]);
      await expect(page.locator(".profile b")).toHaveCount(0);
      expect(await layoutProblems(page)).toEqual([]);
      await shot(page, `${tag}-profile`);

      await page.keyboard.press("Escape");
      await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");
      await expect(rows).toHaveCount(50);
      await page.keyboard.press("Escape");
      await expect(ui(page)).toHaveAttribute("data-screen", "bots");

      // an uncalibrated player: UNRANKED, TR HIDDEN, and the calibration note; BACK returns one level
      await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
      await rows.nth(2).click();
      await expect(box.locator(".stat").first()).toContainText("UNRANKED");
      await expect(box).toContainText("TR HIDDEN");
      await expect(box.locator(".note")).toContainText("after calibration");
      expect(await layoutProblems(page)).toEqual([]);
      await shot(page, `${tag}-profile-uncalibrated`);
      await page.locator("button", { hasText: "← BACK" }).click();
      await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");

      // a player the server doesn't know: No such player
      await page.unroute("**/api/leaderboard");
      await page.route("**/api/leaderboard", (route) => route.fulfill({ json: { players: [{ rank: 1, username: "Ghost99", tr: 13000, games: 30 }] } }));
      await page.keyboard.press("Escape");
      await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
      await expect(rows).toHaveCount(1);
      await rows.first().click();
      await expect(page.locator(".profile .form-error")).toHaveText("No such player");
      await expect(page.locator(".profile .stats")).toHaveCount(0);
      await shot(page, `${tag}-profile-404`);
      // the browser logs the 404 itself; that one is expected
      problems = problems.filter((p) => !p.includes("status of 404"));
      expect(asked).toEqual(["<b>bold</b>", "longest-name_xyz", "Ghost99"]);
    });
  }

  test(`${theme}: an empty leaderboard says so, and with no game server it is unavailable`, async ({ page }) => {
    await openVersus(page, theme, { width: 1280, height: 720 });
    // the static server answers /api/* with 204
    await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "leaderboard");
    await expect(page.locator(".ladder-box .form-error")).toHaveText("Online play isn't available here");
    await expect(page.locator(".ladder-row")).toHaveCount(0);
    await expect(page.locator(".ladder-box .note")).toHaveText("");
    await expect(page.locator(".hint")).toHaveText("ESC to go back");
    await shot(page, `${theme}-leaderboard-unavailable`);
    await page.keyboard.press("Escape");
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");

    await mock(page, []);
    await page.locator("button.bar", { hasText: "LEADERBOARD" }).click();
    await expect(page.locator(".ladder-box .note")).toHaveText("NO CALIBRATED PLAYERS YET");
    await expect(page.locator(".ladder-box .form-error")).toHaveText("");
    await expect(page.locator(".hint")).toHaveText("ESC to go back");
    await shot(page, `${theme}-leaderboard-empty`);
  });

  test(`${theme}: the queue screen shows a no-show cooldown instead of searching`, async ({ page }) => {
    await page.route("**/api/account/queue/join", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "95" }, json: { error: "x", retryAfter: 95 } }));
    let polls = 0;
    await page.route("**/api/account/queue/status", (route) => {
      polls++;
      return route.fulfill({ json: { status: "none" } });
    });
    await openVersus(page, theme, { width: 1280, height: 720 });
    await page.locator("button.bar", { hasText: "RANKED 1V1" }).click();
    await expect(ui(page)).toHaveAttribute("data-screen", "queue");
    await expect(page.locator(".room.queue .form-error")).toHaveText("You didn't join your last ranked match, so you can search again in 1:35.");
    await expect(page.locator(".room.queue")).toContainText("NOT SEARCHING");
    await shot(page, `${theme}-queue-cooldown`);
    await page.waitForTimeout(2500);
    expect(polls).toBe(0);
    problems = problems.filter((p) => !p.includes("status of 429"));
    await page.keyboard.press("Escape");
    await expect(ui(page)).toHaveAttribute("data-screen", "bots");
  });
}
