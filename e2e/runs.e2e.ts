// Full 40 LINES and 2-minute BLITZ runs in Chromium against the production build in dist/.
// Each run uses a fixed seed (?seed=) and a placement plan computed in Node (plan.ts) with the
// game's own engine and bot. Playwright's fake clock drives time, so every run is identical.
import { expect, Page, test } from "@playwright/test";
import { resolve } from "node:path";
import { ModeId, modeById } from "../src/modes";
import { FRAME_MS, Plan, planRun } from "./plan";
import { serveDist } from "./server";

const SEED = 7;
const CLICK_AT = 10_000 + FRAME_MS / 2; // fake-clock ms when the mode is started, off the frame grid
const GAP_MS = { "40l": 10 * FRAME_MS, blitz: 20 * FRAME_MS }; // one placement per gap
const SETTLE_MS = 5_000; // fake time allowed after the last input for the results screen to appear

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

/** Open the game, start `mode` from the menu, play `plan` as key presses, then wait for the results screen. */
async function play(page: Page, mode: ModeId, plan: Plan): Promise<void> {
  const ui = page.locator("#ui");
  await page.clock.install({ time: 0 });
  await page.goto(`${server.url}/?seed=${SEED}`);
  await expect(ui).toHaveAttribute("data-screen", "menu");
  await page.clock.pauseAt(CLICK_AT);
  await page.locator("button.bar", { hasText: modeById(mode).title }).click();
  await expect(ui).toHaveAttribute("data-screen", "play");

  let now = CLICK_AT;
  for (const step of plan.steps) {
    await page.clock.runFor(step.at - now);
    now = step.at;
    for (const code of step.codes) await page.keyboard.press(code);
  }
  // Let the game end and the results screen appear, in bounded fake time.
  for (let waited = 0; waited < SETTLE_MS; waited += 500) {
    if ((await ui.getAttribute("data-screen")) === "results") break;
    await page.clock.runFor(500);
  }
  await expect(ui).toHaveAttribute("data-screen", "results", { timeout: 1_000 });
}

function stat(page: Page, label: string) {
  return page.locator(".results .stats .stat", { has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) }).locator("strong");
}

test("40 LINES: full run to 40 LINES CLEARED", async ({ page }) => {
  const plan = planRun("40l", SEED, CLICK_AT, GAP_MS["40l"]);
  expect(plan.result, "Node run of the plan").toBe("clear");
  expect(plan.lines, "Node run of the plan").toBe(40);

  await play(page, "40l", plan);
  await expect(page.locator(".results .headline")).toHaveText("40 LINES CLEARED");
  await expect(stat(page, "LINES")).toHaveText("40");
  await expect(stat(page, "PIECES")).toHaveText(`${plan.pieces}`);
  console.log(`40 LINES seed ${SEED}: lines 40, pieces ${plan.pieces}, time ${await page.locator(".results .big").textContent()}`);
});

test("BLITZ: full 2-minute run to TIME'S UP", async ({ page }) => {
  const plan = planRun("blitz", SEED, CLICK_AT, GAP_MS.blitz);
  expect(plan.result, "Node run of the plan").toBe("clear");
  expect(plan.score, "Node run of the plan").toBeGreaterThan(0);

  await play(page, "blitz", plan);
  await expect(page.locator(".results .headline")).toHaveText("TIME'S UP");
  const score = Number((await page.locator(".results .big").textContent())?.replaceAll(",", ""));
  expect(score).toBeGreaterThan(0);
  expect(score, "browser score equals the Node run of the same inputs").toBe(plan.score);
  console.log(`BLITZ seed ${SEED}: score ${score}, lines ${plan.lines}, pieces ${plan.pieces}`);
});
