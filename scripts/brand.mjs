// Regenerates the brand assets: icons/favicon.svg, the PNG app icons and og/og-image.png.
// `npm run brand` (after `npm ci`). It draws them as SVG/HTML and screenshots them in Playwright's Chromium,
// so it needs no new dependency. Not part of `npm run build`: the outputs are committed.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Z_PIECES } from "../src/ui/brand.ts";

// Classic's palette (style.css): near-black ground, white ink, the blue of ZA, the muted grey.
const BG = "#08080F";
const INK = "#F4F4FA";
const BLUE = "#3F6BFF";
const MUTED = "#9A9AB0";

/** The Z-tetromino as four blue cells (the last, the accent, white) on a near-black square of `size`, cells `cell` wide. */
function iconSvg(size, cell, gap) {
  const x0 = (size - 3 * cell) / 2;
  const y0 = (size - 2 * cell) / 2;
  const cells = [[0, 0], [1, 0], [1, 1], [2, 1]].map(([x, y], i) =>
    `<rect x="${x0 + x * cell + gap / 2}" y="${y0 + y * cell + gap / 2}" width="${cell - gap}" height="${cell - gap}" fill="${i === 3 ? INK : BLUE}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="${BG}"/>${cells.join("")}</svg>\n`;
}

const font = (family, file, weight) =>
  `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url(data:font/woff2;base64,${readFileSync(`fonts/${file}`).toString("base64")}) format("woff2"); }`;

// 1200x630: Classic's menu brand. TE over ZA in Russo One with the cut Z in blue (sized as style.css does),
// the gloss in Saira beside it, on the near-black ground.
const OG_HTML = `<!doctype html><meta charset="utf-8"><style>
${font("Russo One", "russo-one-400.woff2", 400)}
${font("Saira Semi Condensed", "saira-semi-condensed-400.woff2", 400)}
${font("Saira Semi Condensed", "saira-semi-condensed-600.woff2", 600)}
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: ${BG}; color: ${INK}; font-family: "Saira Semi Condensed"; }
.mark { position: absolute; left: 72px; top: 52px; margin: 0; display: flex; flex-direction: column; font: 400 264px/0.82 "Russo One"; letter-spacing: -0.02em; }
.mark .za { color: ${BLUE}; padding-left: 0.42em; }
.mark svg { display: inline-block; width: 0.579em; height: 0.704em; margin: 0 -0.004em 0 0.015em; fill: currentColor; }
.gloss { position: absolute; left: 640px; top: 236px; display: flex; flex-direction: column; gap: 10px; font-weight: 600; font-size: 40px; line-height: 1.1; }
.gloss span + span { color: ${MUTED}; font-weight: 400; }
.foot { position: absolute; left: 72px; bottom: 44px; right: 72px; border-top: 3px solid ${INK}; padding-top: 14px; color: ${MUTED}; font-size: 22px; letter-spacing: 0.16em; text-transform: uppercase; }
</style>
<h1 class="mark"><span>TE</span><span class="za"><svg viewBox="0 0 56 80" preserveAspectRatio="none">${Z_PIECES.map((p) => `<polygon points="${p}"/>`).join("")}</svg>A</span></h1>
<div class="gloss"><span>Tetris + cheza</span><span>Swahili for play</span></div>
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
