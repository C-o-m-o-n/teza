// Regenerates the brand assets: icons/favicon.svg, the PNG app icons and og/og-image.png.
// `npm run brand` (after `npm ci`). It draws them as SVG/HTML and screenshots them in Playwright's Chromium,
// so it needs no new dependency. Not part of `npm run build`: the outputs are committed.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Z_PIECES } from "../src/ui/brand.ts";

const INK = "#0B0B0C";
const PAPER = "#F3EFE6";
const RED = "#E0301E";
const GREEN = "#0F6B3E";

/** The Z-tetromino as four paper cells (the last one green) on a red square of `size`, cells `cell` wide. */
function iconSvg(size, cell, gap) {
  const x0 = (size - 3 * cell) / 2;
  const y0 = (size - 2 * cell) / 2;
  const cells = [[0, 0], [1, 0], [1, 1], [2, 1]].map(([x, y], i) =>
    `<rect x="${x0 + x * cell + gap / 2}" y="${y0 + y * cell + gap / 2}" width="${cell - gap}" height="${cell - gap}" fill="${i === 3 ? GREEN : PAPER}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="${RED}"/>${cells.join("")}</svg>\n`;
}

const font = (family, file, weight) =>
  `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url(data:font/woff2;base64,${readFileSync(`fonts/${file}`).toString("base64")}) format("woff2"); }`;

// 1200x630: the title screen's last frame. TEZA on the red slab, the green stripe, the CHEZA row on ink.
const OG_HTML = `<!doctype html><meta charset="utf-8"><style>
${font("Big Shoulders Display", "big-shoulders-display-latin.woff2", "800 900")}
${font("Archivo Narrow", "archivo-narrow-latin.woff2", "500 700")}
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: ${INK}; color: ${PAPER}; font-family: "Archivo Narrow"; }
.stage { height: 408px; background: ${RED}; border-bottom: 12px solid ${GREEN}; display: flex; align-items: flex-end; padding-left: 40px; box-sizing: border-box; }
.mark { display: flex; align-items: baseline; font: 900 470px/0.8 "Big Shoulders Display"; letter-spacing: -0.02em; margin-bottom: -0.012em; }
.mark svg { width: 0.56em; height: 0.8em; margin: 0 0.03em 0 0.01em; fill: ${INK}; }
.row { display: flex; align-items: center; gap: 40px; padding: 30px 40px 0; }
.cheza { font: 900 132px/0.8 "Big Shoulders Display"; }
.gloss { display: flex; flex-direction: column; gap: 6px; font-weight: 700; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; }
.gloss span + span { color: ${RED}; }
.foot { position: absolute; left: 40px; bottom: 26px; font-weight: 700; font-size: 18px; letter-spacing: 0.24em; text-transform: uppercase; }
</style>
<div class="stage"><div class="mark">TE<svg viewBox="0 0 56 80">${Z_PIECES.map((p) => `<polygon points="${p}"/>`).join("")}</svg>A</div></div>
<div class="row"><div class="cheza">CHEZA</div><div class="gloss"><span>Tetris + cheza</span><span>Swahili for play</span></div></div>
<div class="foot">Built in Kenya</div>`;

const ICONS = [
  ["icons/icon-192.png", iconSvg(192, 42, 3)],
  ["icons/icon-512.png", iconSvg(512, 112, 8)],
  ["icons/apple-touch-icon-180.png", iconSvg(180, 40, 3)],
  // maskable: the cells' corners stay within 40% of the size from the centre (the safe-zone circle)
  ["icons/icon-maskable-512.png", iconSvg(512, 96, 7)],
];

// The favicon: the same cells with no padding at the sides.
writeFileSync("icons/favicon.svg", iconSvg(48, 16, 2));
console.log("wrote icons/favicon.svg");

mkdirSync("og", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [path, svg] of ICONS) {
  const size = Number(svg.match(/width="(\d+)"/)[1]);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>body{margin:0}</style>${svg}`);
  await page.screenshot({ path });
  console.log(`wrote ${path}`);
}
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(OG_HTML);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: "og/og-image.png" });
console.log("wrote og/og-image.png");
await browser.close();
