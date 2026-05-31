# TETRIO Clone — Phase 1: Solo Engine

> **AI Disclosure:** This codebase was designed and written in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). All architecture decisions, system documentation, and source code were produced through a directed conversation between the project author and the AI. Every section is extensively commented to explain *why* each decision was made, not just *what* it does.

---

## Overview

Phase 1 establishes the complete **solo game engine** — a faithful re-implementation of TETR.IO's core mechanics from the ground up, using only publicly available reverse-engineering documentation, community format specs, and the official TETR.IO replay file schema.

This is a single self-contained HTML file. No dependencies, no build step — open it in any modern browser and play.

---

## What's Implemented

| System | Details |
|---|---|
| **MINSTD PRNG** | Exact `X(n+1) = 16807·X(n) mod 2147483647` LCG with BigInt precision |
| **7-Bag Randomizer** | Fisher-Yates shuffle driven by the shared MINSTD state |
| **Board** | 10×40 (20 buffer + 20 visible), standard guideline layout |
| **SRS Rotation** | Full Super Rotation System kick tables for JLSTZ and I-piece |
| **180° Rotation** | TETR.IO's custom 180° kick table (non-standard, A key) |
| **Fixed 60Hz Loop** | Delta-time accumulator — frame-rate independent physics |
| **Lock Delay** | 30-tick timer, 15-reset cap, 60-tick floor max (Infinity system) |
| **DAS / ARR** | Delayed Auto Shift (10 ticks) + Auto Repeat Rate (2 ticks) |
| **Hold Piece** | Standard guideline hold with lock-once-per-piece rule |
| **Ghost Piece** | Hard-drop preview rendered at 20% opacity |
| **Next Queue** | 5-piece preview with fade |
| **Scoring** | Single/Double/Triple/Quad + combo bonuses + level scaling |
| **Gravity Table** | 30-level gravity curve matching guideline speeds |
| **Sprint Mode** | 40-line clear, timer display |
| **Blitz Mode** | 2-minute countdown, score display |
| **PPS Stat** | Pieces Per Second, live |

---

## Architecture

### The PRNG — Why It Matters

TETR.IO's randomness is deterministic and **shared** across subsystems. A single `MINSTD` instance per match drives both:

1. The 7-bag Fisher-Yates shuffle (piece order)
2. Garbage hole column selection (Phase 2)

This is why replays (`.ttr` files) only need to store the seed + inputs — the entire game can be reconstructed. Using separate RNG instances for these two subsystems would cause replay desync.

```js
// X(n+1) = (16807 * X(n)) mod 2147483647
// BigInt required — 16807 * 2147483646 ≈ 3.6×10¹³, exceeds Number.MAX_SAFE_INTEGER
this.state = Number(
  (BigInt(16807) * BigInt(this.state)) % BigInt(2147483647)
);
```

### The Fixed Timestep Accumulator

The physics loop runs at a strict internal **60 ticks per second**, decoupled from the display's refresh rate:

```
each rAF frame:
  delta = now - lastTime           // real elapsed ms
  accumulator += delta
  while accumulator >= 16.666ms:
    processDAS()
    tick()                         // one physics step
    accumulator -= 16.666ms
  render()                         // once per frame
```

The leftover in `accumulator` carries to the next frame. This remainder is the **subframe** value — the same fractional tick offset stored in TETR.IO's `.ttr` replay format to enable exact input reproduction.

### SRS + 180° Kicks

Standard SRS kicks are used for CW/CCW rotations per the Tetris Guideline. TETR.IO adds a **non-standard 180° kick table** (the `A` key), documented by the community:

```
Rotation 0 → 2:  try [0,0], [0,-1], [0,+1], [-1,0], [+1,0]
```

Each rotation direction has its own ordered kick list. The first valid position wins.

### Lock Delay (Infinity System)

```
lockTimer:  ticks since piece last touched a surface  (max: 30)
lockResets: number of move/rotate resets used         (max: 15)
lockFloor:  total ticks spent on any floor surface    (max: 60)
```

Any one of these reaching its cap triggers an immediate lock. This prevents both the "shuffle forever" exploit and unresponsive feels.

---

## Board Coordinate System

```
Row  0 ─── top of buffer (invisible)
Row 19 ─── bottom of buffer (spawn zone)
Row 20 ─── top of visible board  ← VIS_START
Row 39 ─── bottom of visible board (floor)

Col  0 = left wall
Col  9 = right wall
```

Pieces spawn with their rotation origin at row 19, col 3. After applying piece offsets, most pieces appear at rows 18–19 (buffer), falling into the visible area naturally.

---

## Piece Rotation States

Each piece has 4 rotation states (0=spawn, 1=CW, 2=180°, 3=CCW), stored as `[row_offset, col_offset]` pairs relative to the rotation pivot:

```
T-piece, rotation 0 (spawn):     T-piece, rotation 1 (CW):
  . X .                            . X .
  X X X                            . X X
                                   . X .
offsets: [-1,1],[0,0],[0,1],[0,2]  offsets: [-1,1],[0,1],[0,2],[1,1]
```

---

## File Structure

```
tetrio-clone-phase1.html
├── <style>          CSS design tokens, layout, canvas styling
└── <script>
    ├── §1  MINSTD PRNG
    ├── §2  Piece definitions (all 7 pieces, 4 rotations each)
    ├── §3  SRS kick tables (JLSTZ, I, 180°)
    ├── §4  7-Bag randomizer
    ├── §5  Board helpers (create, validate, lock, clear lines)
    ├── §6  Active piece (spawn, move, rotate, ghost)
    ├── §7  Scoring system + gravity table
    ├── §8  Lock delay constants
    ├── §9  Game state machine (variables)
    ├── §10 Game init / reset
    ├── §11 Hold piece mechanic
    ├── §12 Hard drop & locking
    ├── §13 Physics tick
    ├── §14 Input handling (DAS/ARR)
    ├── §15 Game loop (rAF + fixed timestep)
    ├── §16 Rendering (board, ghost, hold, next)
    ├── §17 Stats display
    ├── §18 Game lifecycle (start, pause, end)
    └── §19 UI controls
```

---

## Controls

| Key | Action |
|---|---|
| `← →` | Move left / right |
| `↑` | Rotate clockwise |
| `Z` | Rotate counter-clockwise |
| `A` | Rotate 180° |
| `↓` | Soft drop (+1 pt/row) |
| `Space` | Hard drop (+2 pt/row) |
| `C` / `Shift` | Hold piece |
| `P` | Pause / unpause |

---

## Sources & References

- [TETR.IO Replay Format Spec](https://github.com/tetrio/issues) — official repo, `.ttr` input key documentation
- [TetrisWiki — TETR.IO](https://tetris.wiki/TETR.IO) — MINSTD PRNG formula, bag system
- [Tetris Guideline](https://tetris.wiki/Tetris_guideline) — SRS, lock delay, scoring
- Community-documented 180° kick table (osk's Discord, archived in awesome-tetrio)
- [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) — curated community resources

---

## What's Next — Phase 2

- T-spin detection (3-corner rule + kick index validation)
- T-spin Mini detection
- Back-to-Back (B2B) chain tracking
- TETR.IO's Multiplier combo system
- Full attack/garbage table
- Garbage column persistence + sickness scatter
- All Clear (Perfect Clear) detection
- APM stat
- Action popups (visual feedback)
