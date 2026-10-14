# Mechanics reference (from the official client)

Source: `tetrio.js?hv=…20260714T182728`, pulled from the TETR.IO Desktop 10.0.0 Chromium cache
(`~/.config/tetrio-desktop/Cache/Cache_Data`, brotli-encoded). The desktop app (`app.asar`) is only an
Electron shell that loads https://tetr.io, so it contains no game logic.

## Board & pieces
- 10 wide, 20 visible + 20 buffer rows (40 total), y grows down.
- Piece position is fractional: a cell occupies row `ceil(y + row - dy)`. Spawn: `x = ceil(W/2)-1 = 4`, `y = B - 2.04 = 17.96`.
- Moving down needs the next *whole* row to be free (`y+1-2e-6`), otherwise the piece is grounded.

## Rotation (SRS+)
- Kick tables in `src/engine/constants.ts` (incl. I-kicks and 180° tables `02/13/20/31`).
- A kick's y is `floor(y)+0.1+ky`; after `lockresets+15` total rotations it becomes `y+ky`.
- T-spin: grounded + ≥3 occupied corners; mini unless both front corners are filled; kick index 3 upgrades to full.
- all-mini+: any other piece (or a failed T check) that can't move left/right/up/down = mini spin.

## Timing (frames @60)
- g = 0.02 rows/frame, lock delay 30, lock resets 15 (reset when the piece reaches a new lowest row).
- Once resets ≥ 15, touching the floor locks instantly. Rotating more than resets+15 times adds extra gravity.
- Default handling: ARR 2, DAS 10, DCD 2, SDF 6 (41 = instant). Soft drop = `max(g·sdf, 0.05·sdf)`.
- `gincrease` / `garbageincrease` are per second, applied as `/60` each frame after their margin.

## IRS / IHS and finesse
- There is no spawn delay, so IRS/IHS act on keys held at the moment a piece spawns after a lock (not the first piece, not a ZEN wipe). Settings `handling.irs` / `handling.ihs` (CONFIG › HANDLING), both on by default.
- IHS: hold held → the normal hold, once (the hold's own spawn doesn't chain). IRS: the most recently pressed rotate key still held → one rotation with normal kicks (a held 180 does nothing when 180 is off). IHS goes first, then IRS rotates the swapped-in piece. Neither counts as an input.
- Finesse (player only, `trackFinesse`): per piece, left/right/cw/ccw/180 presses since it spawned (a DAS slide is one press; drops, hold and IRS/IHS don't count). On lock, `max(0, used − minimum)` is added to `stats.finesse`. The minimum (`src/engine/finesse.ts`) is a BFS on an empty board from spawn: tap left/right, slide to either wall, cw/ccw/180, kicks' horizontal part only, no floor. Placements are compared by cell set; one no BFS move reaches (a tuck or spin) counts 0.
- Online matches: the server replays inputs with `MATCH_HANDLING` and sends it in `start`, so a client using it applies IRS/IHS exactly as the server does.

## Attack
Base: single 0, double 1, triple 2, quad 4; T-spin S/D/T/Q 2/4/6/10; mini S/D/T 0/1/2. All clear +10.
- B2B (btb > 1): +1, or with chaining `floor(1+log1p((btb-1)·0.8)) + (btb-1==1 ? 0 : (1 + log1p((btb-1)·0.8) % 1)/3)`.
- Combo (multiplier table): `atk *= 1 + 0.25·(combo-1)`; if combo > 2, `atk = max(log1p((combo-1)·1.25), atk)`.
- Result × garbage multiplier, rounded down. Attack cancels incoming garbage first (combo blocking: no garbage enters on a clearing piece).
- Garbage: travels `garbagespeed` = 20 frames, up to 8 lines per piece, hole column re-rolled per attack (messiness 1).

## Modes (client `gameModes`)
- 40l: `allow180, spinbonuses all-mini+, g 0.02, objective lines 40, nolockout`.
- blitz: `objective timed 120000ms, levels, levelspeed .42, levelgbase .65` with
  `g = 1/60 / (levelgbase-(lvl-1)·levelgspeed)^(lvl-1)`, lines to next level = `ceil(lvl·levelspeed·5)`.
- League values are served live by the server; VERSUS uses approximations (`gincrease .0025 @2min`, `garbageincrease .008 @3min`).

## RNG
Park–Miller: `s = 16807·s mod 2147483647`, float `(s-1)/2147483646`; bag = Fisher–Yates of `[z,l,o,s,i,j,t]`.
