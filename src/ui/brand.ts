// The TEZA wordmarks (README "Brand"): Poster Slab's Big Shoulders Display capitals, and Classic's stacked
// TE over ZA in Russo One, both with the Z cut like a Z-tetromino. scripts/brand.mjs draws the share image
// from the same Z_PIECES.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The Z, in a 56x80 box (0.56em wide by 0.8em, the font's cap height, so it sits on the baseline like a
 * letter): a heavy Z cut into four pieces by seams that run on from its diagonal. The pieces sit like a
 * Z-tetromino's cells, two above at the left and two below at the right; the last is the accent cell.
 */
export const Z_PIECES = [
  "0,0 40.96,0 29.5,17 0,17",
  "43.96,0 56,0 56,17 41.51,38.5 18.01,38.5",
  "14.49,41.5 37.99,41.5 12.04,80 0,80 0,63",
  "26.5,63 56,63 56,80 15.04,80",
];

function zGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "wm-z");
  svg.setAttribute("viewBox", "0 0 56 80");
  Z_PIECES.forEach((points, i) => {
    const cell = document.createElementNS(SVG_NS, "polygon");
    cell.setAttribute("class", i === Z_PIECES.length - 1 ? "wm-cell wm-accent" : "wm-cell");
    cell.setAttribute("points", points);
    svg.append(cell);
  });
  return svg;
}

/** A fresh TEZA wordmark. Size it with font-size; each letter carries `--n` (0 to 3) for staggered animation. */
export function wordmark(extraClass = ""): HTMLElement {
  const mark = document.createElement("span");
  mark.className = extraClass ? `wordmark ${extraClass}` : "wordmark";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "TEZA");
  ["T", "E", "Z", "A"].forEach((ch, i) => {
    const letter = document.createElement("span");
    letter.className = "wm-letter";
    letter.style.setProperty("--n", String(i));
    if (ch === "Z") letter.append(zGlyph());
    else letter.textContent = ch;
    mark.append(letter);
  });
  return mark;
}

/**
 * Classic's wordmark: the original stacked heading, TE over ZA (styled by `.brand h1` and `.slash`), with the
 * cut Z in place of the letter. With `drop` its four pieces fall in and lock (style.css), as the menu opens.
 */
export function classicWordmark(drop: boolean): HTMLHeadingElement {
  const h1 = document.createElement("h1");
  h1.setAttribute("aria-label", "TEZA");
  const te = document.createElement("span");
  te.textContent = "TE";
  const za = document.createElement("span");
  za.className = "slash";
  const z = zGlyph();
  z.setAttribute("preserveAspectRatio", "none"); // stretched to the font's Z (style.css)
  if (drop) z.classList.add("drop");
  za.append(z, "A");
  h1.append(te, za);
  return h1;
}
