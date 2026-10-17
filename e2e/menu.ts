// Reaching the menu in either interface theme (src/ui/themes.ts).
import { expect, Page } from "@playwright/test";

/** Before the page's first load only, save `theme` as the interface theme, as CONFIG would. */
export async function seedTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((theme) => {
    if (sessionStorage.getItem("e2e:seeded")) return;
    sessionStorage.setItem("e2e:seeded", "1");
    localStorage.setItem("teza:settings", JSON.stringify({ theme }));
  }, theme);
}

/** Open `url` and reach the menu: Classic opens on it, Poster Slab on its title screen, which any key skips. */
export async function openMenu(page: Page, url: string): Promise<void> {
  const ui = page.locator("#ui");
  await page.goto(url);
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) === "poster") {
    await expect(ui).toHaveAttribute("data-screen", "title");
    await page.keyboard.press("Space");
  }
  await expect(ui).toHaveAttribute("data-screen", "menu");
}
