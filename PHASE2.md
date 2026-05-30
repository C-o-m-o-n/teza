# TETRIO Clone — Phase 2: T-Spins, B2B, Garbage System & Attack Table

> **AI Disclosure:** This phase was designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). The T-spin corner logic, B2B chain math, attack table values, and garbage column persistence algorithm were all derived from publicly documented community reverse-engineering of TETR.IO, then coded and documented with AI assistance. Every decision is explained inline.

---

## Overview

Phase 2 builds the **competitive scoring and garbage layer** on top of the Phase 1 engine. This is where TETR.IO diverges most significantly from standard Tetris Guideline — its T-spin detection, combo multiplier system, and garbage column mechanics are all custom.

Phase 1 carries forward **unchanged** (PRNG, bag, SRS, lock delay, game loop). Phase 2 adds new systems on top.

---

## What's New in Phase 2

| System | Details |
|---|---|
| **T-spin Detection** | 3-corner rule + SRS kick index validation |
| **T-spin Mini** | Separate mini detection with reduced attack values |
| **B2B Chain** | Back-to-Back tracking with level-scaled bonus |
| **Multiplier Combo** | TETR.IO's non-standard combo multiplier (not flat +1) |
| **Attack Table** | Full TETR.IO attack values for all clear types |
| **All Clear** | Perfect Clear detection → 10 lines attack |
| **Garbage Queue** | Buffered incoming garbage with cancellation |
| **Column Persistence** | Holes share columns within an attack, shift between attacks |
| **Sickness / Scatter** | Forces column scatter after sustained stalling |
| **Garbage Meter** | Visual bar showing queued incoming lines |
| **Sandbox Mode** | Auto-generates garbage every 5 seconds for practice |
| **Action Popups** | Animated text: "T-Spin Double!", "B2B ×3", "ALL CLEAR" |
| **APM Stat** | Attacks Per Minute, live |
| **B2B Bar** | Visual indicator of B2B chain depth |
| **Spin Glow** | T-piece glows purple when a T-spin is "charged" |

---

## T-Spin Detection

### The 3-Corner Rule

TETR.IO uses the **3-corner rule** to determine if a T-piece placement counts as a T-spin. The T-piece has 4 diagonal corners relative to its pivot. After any rotation, we check how many of those corners are occupied (by a locked cell or a wall):

```
T-piece at rotation 0 (spawn):

  BL  .  BR         BL = back-left  corner
   . [T]  .         BR = back-right corner
  FL  .  FR         FL = front-left corner
                    FR = front-right corner

"Front" = the direction the T's bump points
```

**Rules:**
- `< 3 corners filled` → not a T-spin
- `3+ corners filled, both FRONT corners filled` → **Full T-Spin**
- `3+ corners filled, FRONT corners NOT both filled` → **T-Spin Mini**
- `kick index ≥ 3` (used one of the "far" SRS kicks) → always **Full T-Spin**
- `4 corners filled` → always **Full T-Spin**

```js
// Corner offsets [dr, dc] for each T rotation state
// [back-left, back-right, front-left, front-right]
const T_CORNERS = [
  [[-1,-1],[-1,1],[1,-1],[1,1]],   // rot 0
  [[-1,-1],[1,-1],[-1,1],[1,1]],   // rot 1 (CW)
  [[1,-1],[1,1],[-1,-1],[-1,1]],   // rot 2 (180°)
  [[-1,1],[1,1],[-1,-1],[1,-1]],   // rot 3 (CCW)
];
```

### Kick Index Tracking

`tryRotate()` now returns `{ piece, kickIndex }`. The kick index is stored in `lastKickIndex` and passed to `detectTSpin()` at lock time. If the player **moves** after rotating, `lastSpinType` is cleared — the spin must be the final action before lock.

### Immobile Detection

As a secondary check, `isImmobile()` verifies the piece cannot move in any of the 4 cardinal directions. This is used in TETR.IO's "All-Spin" modes and serves as a fallback in edge cases.

---

## B2B Chain (Back-to-Back)

A **B2B-eligible** clear is any Quad (4-line) or any T-spin/Mini that clears at least 1 line.

```
First eligible clear:        b2bLevel = 1  (chain starts, no bonus yet)
Second consecutive eligible: b2bLevel = 2  (+1 attack bonus applied)
Each subsequent eligible:    b2bLevel++
Any non-eligible clear:      b2bLevel = 0  (chain broken)
```

**B2B Attack Bonus:**

| B2B Level | Bonus Lines |
|---|---|
| 0 | +0 |
| 1–3 | +1 |
| 4–7 | +2 |
| 8+ | +3 |

The B2B bar in the UI fills up to level 8, turning the chain depth into a visible pressure indicator.

---

## Attack Table

### Base Attack (lines sent per clear type)

| Clear Type | 0L | 1L | 2L | 3L | 4L |
|---|---|---|---|---|---|
| Normal | 0 | 0 | 1 | 2 | 4 |
| T-Spin | 0 | 2 | 4 | 6 | — |
| T-Mini | 0 | 0 | 1 | — | — |
| All Clear | — | **10** | **10** | **10** | **10** |

### Combo Multiplier System

TETR.IO does **not** use the standard Guideline flat combo table (`+1 line per combo`). Instead it uses a **multiplier** applied to the base attack:

| Combo Count | Multiplier |
|---|---|
| 0–1 | ×1.0 |
| 2 | ×1.2 |
| 3 | ×1.4 |
| 4 | ×1.6 |
| 5+ | ×1.8 |

This caps the benefit of pure combo play (like 4-wide) while rewarding efficient high-attack clears (T-spin combos, Quad combos) significantly. A 4-wide player sending singles gets boosted to ×1.8 max; a T-spin Double player also gets ×1.8 but starts from 4 base lines.

### All Clear (Perfect Clear)

After a clear, if the board is completely empty:
- Attack = **10 lines** (overrides all other calculations)
- Score = **3000 × level**

---

## Garbage System

### Garbage Queue

Incoming garbage is buffered in `garbageQueue[]`. It does **not** land immediately — it waits until the player places their next piece. At that point:

1. Any attack the player sends **cancels** queued garbage first (front of queue first)
2. Remaining uncancelled garbage lands on the board

```
Player sends 3 attack:
  garbageQueue = [{ count: 2 }, { count: 4 }]
  Cancel 2 from first entry → removed
  Cancel 1 from second entry → { count: 3 } remains
  → 3 lines land
```

### Column Persistence

Within a single attack batch, all garbage lines share the **same hole column** — this lets players dig cleanly. When a new attack arrives, the hole column shifts:

```js
function nextGarbageCol(prng, lastCol) {
  let col = prng.nextInt(COLS);
  if (col === lastCol) col = (col + 1) % COLS;  // Never same column
  return col;
}
```

This uses the **shared MINSTD PRNG state** — same instance as the bag randomizer. Correct replay requires consuming these in exact order.

### Sickness / Scatter System

TETR.IO tracks a hidden **sickness counter** when a player repeatedly cancels garbage without clearing their own lines. After `SCATTER_THRESHOLD = 8` consecutive non-clearing placements, scatter mode activates:

```js
// In scatter mode: each garbage LINE gets a DIFFERENT hole column
if (sickness >= SCATTER_THRESHOLD) {
  col = nextGarbageCol(prng, col);  // Re-roll per line
}
```

This prevents indefinite stalling at the board bottom.

### Sandbox Mode

Phase 2 adds a **Sandbox** game mode that auto-generates 1–4 lines of garbage every 300 ticks (~5 seconds). This lets players practice T-spin defense and garbage management without a real opponent.

---

## Action Popup System

After every piece lock with a notable clear, floating text appears beside the board:

```
ALL CLEAR          ← gold, highest priority
B2B ×3             ← purple, shows chain level
T-Spin Double      ← magenta
[blank]            ← for normal clears (Quad shown in cyan)
3 combo            ← orange
```

Popups use CSS `opacity` + `translateX` transitions (no canvas). They auto-hide after 1.8 seconds.

### T-Spin "Charge" Glow

When a T-piece has been rotated (and the move flag hasn't been cleared), the active T-piece renders with a purple border — a visual cue that a T-spin is "armed" and will count if the piece locks now.

---

## File Structure

```
tetrio-clone-phase2.html
├── <style>          Extended CSS: popup, garbage meter, B2B bar, sandbox mode
└── <script>
    ├── §1   MINSTD PRNG (unchanged)
    ├── §2   Piece definitions (unchanged)
    ├── §3   SRS kick tables (unchanged)
    ├── §4   7-Bag randomizer (unchanged)
    ├── §5   Board helpers (unchanged)
    ├── §6   Active piece — tryRotate() now returns kick metadata
    ├── §7   T-spin detection (3-corner rule + kick index)
    ├── §8   Attack / garbage table + combo multiplier
    ├── §9   Garbage system (queue, column persistence, scatter)
    ├── §10  Scoring / gravity (unchanged)
    ├── §11  Game state (extended: b2bLevel, totalAttack, sickness...)
    ├── §12  Init (extended for garbage state)
    ├── §13  Hold (clears spin type on hold)
    ├── §14  Hard drop & lock (full attack pipeline)
    ├── §15  Action popup display
    ├── §16  Garbage meter UI
    ├── §17  Physics tick (extended: sandbox timer, sickness)
    ├── §18  Input handling (doRotate stores kick metadata)
    ├── §19  Game loop (unchanged)
    ├── §20  Rendering (T-spin glow, garbage color)
    ├── §21  Stats (APM, B2B bar, attack counter)
    └── §22  Lifecycle (sandbox mode button, end screen shows attack)
```

---

## Controls

Same as Phase 1, plus:

| Key | Action |
|---|---|
| `A` | Rotate 180° (TETR.IO-specific) |

Mode selector now includes **Sandbox** — auto-garbage for practice.

---

## Key Design Decisions & Trade-offs

**Why store `lastSpinType` on rotation, not at lock time?**
Because we need to know whether the *last action* before lock was a rotation. The T-spin must be the final move. Storing the kick index at rotation time and voiding it on move/soft-drop replicates TETR.IO's exact behavior.

**Why floor the combo multiplier result?**
`Math.floor(attack * mult)` matches TETR.IO's integer attack system — you can't send fractional lines.

**Why does garbage land at piece placement, not immediately?**
This matches TETR.IO's "delay before landing" mechanic, giving players one piece to react to incoming garbage by attacking back (cancelling).

---

## Sources & References

- Community-documented TETR.IO attack table (TETR.IO Discord, archived)
- [TetrisWiki — T-spin](https://tetris.wiki/T-spin) — 3-corner rule explanation
- [TetrisWiki — Back-to-Back](https://tetris.wiki/Back-to-back) — B2B eligibility
- [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) — garbage system references
- Poyo's TETR.IO Network Protocol Docs — garbage column PRNG ordering
- Phase 1 documentation (this repo)

---

## What's Next — Phase 3

- Ribbon WebSocket protocol (sequence/ack layer)
- Real-time 1v1 multiplayer (local server)
- Garbage send/receive between two clients
- Room system with spectator state
- Ping / heartbeat / disconnect resilience
