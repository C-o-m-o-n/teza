// Glicko-2 ratings and the TR (Tetra Rating) display score, ported from the v1 server
// (`git show v1.0.0:server/server.js`, §3). Pure: no runtime imports, so the Accounts Durable
// Object, the matchmaker and the tests share it.
//
// Internal scale (Glickman 2012, glicko.net/glicko/glicko2.pdf):
//   mu = (r - 1500) / 173.7178, phi = RD / 173.7178, sigma = volatility.
// TR = 25000 / (1 + 10^((1500 - r)·π / (173.7178·√(3·ln²10·RD² + π²)))), shown only once RD <= 100.

export const GLICKO_TAU = 0.6; // system constant: how fast volatility may move
export const GLICKO_SCALE = 173.7178;
export const R_INITIAL = 1500;
export const RD_INITIAL = 350;
export const RD_MIN = 30;
export const RD_HIDDEN = 100; // TR is hidden while RD is above this
export const VOL_INITIAL = 0.06;
export const EPSILON = 0.000001;

export interface Rating {
  r: number;
  rd: number;
  vol: number;
}

export const DEFAULT_RATING: Readonly<Rating> = { r: R_INITIAL, rd: RD_INITIAL, vol: VOL_INITIAL };

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu: number, muj: number, phij: number): number {
  return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}

/**
 * One Glicko-2 rating period with a single game against `opp` (their pre-match values).
 * `score` is 1 for a win, 0 for a loss, 0.5 for a draw.
 */
export function updateGlicko2(player: Rating, opp: Rating, score: number): Rating {
  const mu = (player.r - R_INITIAL) / GLICKO_SCALE;
  const phi = player.rd / GLICKO_SCALE;
  const muj = (opp.r - R_INITIAL) / GLICKO_SCALE;
  const pj = opp.rd / GLICKO_SCALE;

  const gj = g(pj);
  const ej = E(mu, muj, pj);

  // Step 3: estimated variance
  const v = 1 / (gj * gj * ej * (1 - ej));
  // Step 4: estimated improvement
  const delta = v * gj * (score - ej);

  // Step 5: new volatility by the Illinois algorithm. `a` stays ln(sigma²) throughout, as in the
  // paper (v1's f read the bracket end A, which the loop moves).
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d2 = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d2 * d2) - (x - a) / (GLICKO_TAU * GLICKO_TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * GLICKO_TAU) < 0) k++;
    B = a - k * GLICKO_TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  // Steps 6-7: new phi and mu
  const phiStar = Math.sqrt(phi * phi + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gj * (score - ej);

  return {
    r: newMu * GLICKO_SCALE + R_INITIAL,
    rd: Math.max(RD_MIN, newPhi * GLICKO_SCALE),
    vol: newVol,
  };
}

/** The TR for a rating, 0 .. 25000 (12500 at r = 1500), unrounded and never hidden. */
export function calcTR(r: number, rd: number): number {
  const ln10 = Math.log(10);
  const denom = GLICKO_SCALE * Math.sqrt(3 * ln10 * ln10 * rd * rd + Math.PI * Math.PI);
  return 25000 / (1 + Math.pow(10, ((R_INITIAL - r) * Math.PI) / denom));
}

/** The TR a player sees: rounded, or null while RD > RD_HIDDEN. */
export function tdisplay(r: number, rd: number): number | null {
  return rd > RD_HIDDEN ? null : Math.round(calcTR(r, rd));
}
