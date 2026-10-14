// Finesse: the fewest inputs that take a piece from its spawn to a placement, measured on an
// empty board. Moves are a tap left/right, a DAS slide to either wall (one input each) and the
// cw/ccw/180 rotations with SRS+ kicks. Only a kick's horizontal part is used and there is no
// floor, so the result ignores the stack, as the usual finesse definition does.
import { BOARD_W, I_KICKS, KICKS, PieceType, Rotation, SHAPES } from "./constants";

export const SPAWN_X = Math.ceil(BOARD_W / 2) - 1;

/** Columns and rows of a placement, shifted so its top row is 0: the same key for any drop height. */
export function placementKey(cells: [number, number][]): string {
  const top = Math.min(...cells.map(([, y]) => y));
  return cells.map(([x, y]) => `${x},${y - top}`).sort().join(" ");
}

function cellsAt(type: PieceType, x: number, r: Rotation): [number, number][] {
  const s = SHAPES[type][r];
  return s.cells.map(([c, row]) => [x + c - s.dx, row]);
}

function fits(type: PieceType, x: number, r: Rotation): boolean {
  return cellsAt(type, x, r).every(([cx]) => cx >= 0 && cx < BOARD_W);
}

function rotateTo(type: PieceType, x: number, from: Rotation, to: Rotation): number | null {
  if (fits(type, x, to)) return x;
  if (type === "o") return null;
  for (const [kx] of (type === "i" ? I_KICKS : KICKS)[`${from}${to}`]) {
    if (fits(type, x + kx, to)) return x + kx;
  }
  return null;
}

const cache = new Map<string, Map<string, number>>();

/** Fewest inputs to reach every placement of `type` from spawn, keyed by `placementKey`. */
function distances(type: PieceType, allow180: boolean): Map<string, number> {
  const id = `${type}${allow180 ? 1 : 0}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const seen = new Map<string, number>(); // `${x},${r}` -> inputs
  const best = new Map<string, number>();
  const queue: [number, Rotation][] = [[SPAWN_X, 0]];
  seen.set(`${SPAWN_X},0`, 0);
  for (let i = 0; i < queue.length; i++) {
    const [x, r] = queue[i];
    const d = seen.get(`${x},${r}`)!;
    const key = placementKey(cellsAt(type, x, r));
    if (!best.has(key)) best.set(key, d);
    const next: [number, Rotation][] = [];
    for (const dir of [-1, 1]) {
      if (fits(type, x + dir, r)) next.push([x + dir, r]);
      let w = x;
      while (fits(type, w + dir, r)) w += dir;
      next.push([w, r]);
    }
    for (const delta of allow180 ? [1, 3, 2] : [1, 3]) {
      const to = ((r + delta) % 4) as Rotation;
      const nx = rotateTo(type, x, r, to);
      if (nx !== null) next.push([nx, to]);
    }
    for (const [nx, nr] of next) {
      const k = `${nx},${nr}`;
      if (seen.has(k)) continue;
      seen.set(k, d + 1);
      queue.push([nx, nr]);
    }
  }
  cache.set(id, best);
  return best;
}

/**
 * Fewest left/right/rotate inputs that put `type` from its spawn onto the given board cells,
 * or null when no sequence of those moves reaches them (a tuck or spin placement).
 */
export function minInputs(type: PieceType, cells: [number, number][], allow180: boolean): number | null {
  return distances(type, allow180).get(placementKey(cells)) ?? null;
}
