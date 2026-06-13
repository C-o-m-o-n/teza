# TEZA — Complete Developer Guide

> Written in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6).  
> This guide is meant to give you a deep understanding of every system in the codebase — the *why*, not just the *what* — so you can extend, fix, and build on TEZA confidently.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [How the Game Loop Works](#2-how-the-game-loop-works)
3. [The PRNG — Randomness Foundation](#3-the-prng--randomness-foundation)
4. [The Board — Coordinates & Memory Layout](#4-the-board--coordinates--memory-layout)
5. [Pieces — Definitions & Rotation](#5-pieces--definitions--rotation)
6. [SRS Rotation System & Kick Tables](#6-srs-rotation-system--kick-tables)
7. [The 7-Bag Randomizer](#7-the-7-bag-randomizer)
8. [Movement, Collision & the Ghost Piece](#8-movement-collision--the-ghost-piece)
9. [Lock Delay — The Infinity System](#9-lock-delay--the-infinity-system)
10. [T-Spin Detection](#10-t-spin-detection)
11. [Attack & Garbage System](#11-attack--garbage-system)
12. [The Engine State Object](#12-the-engine-state-object)
13. [stepEngine — Input Processing](#13-stepengine--input-processing)
14. [tickEngine — Gravity & Auto-lock](#14-tickengine--gravity--auto-lock)
15. [The Ribbon WebSocket Protocol](#15-the-ribbon-websocket-protocol)
16. [Room System & Match Lifecycle](#16-room-system--match-lifecycle)
17. [Client-Side Prediction](#17-client-side-prediction)
18. [Glicko-2 Rating System](#18-glicko-2-rating-system)
19. [Tetra Rating (TR) Formula](#19-tetra-rating-tr-formula)
20. [Matchmaking Queue](#20-matchmaking-queue)
21. [Spectator Mode](#21-spectator-mode)
22. [Replay System (.teza format)](#22-replay-system-teza-format)
23. [Player Profile Store](#23-player-profile-store)
24. [The Client UI — Screens & State](#24-the-client-ui--screens--state)
25. [Rendering Pipeline](#25-rendering-pipeline)
26. [Common Bugs & How to Fix Them](#26-common-bugs--how-to-fix-them)
27. [How to Add New Features](#27-how-to-add-new-features)
28. [Full Message Reference](#28-full-message-reference)

---

## 1. Project Structure

```
teza/
├── shared/
│   └── engine.js          ← The game engine. Runs on server AND browser.
├── server/
│   └── server.js          ← Node.js server: Ribbon, rooms, ratings, replays.
├── client/
│   └── index.html         ← Single-file browser client: UI, rendering, input.
├── data/
│   ├── players.json       ← Auto-created. All player profiles + ratings.
│   └── replays/           ← Auto-created. One .teza file per match.
└── package.json
```

### The Golden Rule: shared/engine.js

The most important architectural decision in this codebase is that `engine.js` is **the same file** running on both the server and the browser. It has zero dependencies — no DOM, no WebSocket, no `require`. It is pure deterministic logic.

Because of this:
- The server can run the game authoritatively for validation and garbage routing.
- The client can run the same game locally for instant input feedback.
- Given only a `seed` + `inputs[]`, any game can be fully reconstructed — enabling replays, spectating, and anti-cheat.

The UMD wrapper at the top of `engine.js` handles the dual export:

```js
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();   // Node.js
  } else {
    root.TezaEngine = factory();  // Browser: window.TezaEngine
  }
}(typeof window !== 'undefined' ? window : global, function () {
  // ... all engine code here ...
  return { createEngine, stepEngine, tickEngine, ... };
}));
```

This is the **UMD (Universal Module Definition)** pattern. The factory function runs once and returns the public API. Everything inside stays scoped — no global pollution.

---

## 2. How the Game Loop Works

Understanding this is essential before reading anything else.

### The Fixed Timestep Accumulator

The browser's `requestAnimationFrame` fires at the display refresh rate — 60Hz, 144Hz, or anything else. If we ran game logic directly in rAF, the game would run at different speeds on different screens.

Instead, we use a **fixed timestep accumulator**:

```js
const TICK_MS = 1000 / 60;   // 16.666ms per physics tick
let accumulator = 0;
let lastTime = performance.now();

function loop(now) {
  let delta = now - lastTime;
  lastTime  = now;
  if (delta > 250) delta = 250;   // cap: prevents spiral of death

  accumulator += delta;

  while (accumulator >= TICK_MS) {
    processDAS();        // held-key repeat
    tickEngine(eng);     // one physics step
    accumulator -= TICK_MS;
  }

  render();              // once per display frame
  requestAnimationFrame(loop);
}
```

**What this means:**
- On a 144Hz screen: each rAF fires every ~6.9ms. The `while` loop drains the accumulator, usually running 0 or 1 tick per frame. Physics stays at 60Hz.
- On a 30Hz screen: each rAF fires every ~33ms. The loop runs 2 ticks to catch up. Physics stays at 60Hz.
- The leftover in `accumulator` after draining is the **subframe** — the fractional tick position. TETR.IO's `.ttr` replay files store input timestamps with subframe precision so inputs can be applied at the exact right moment during replay.

**The 250ms cap** prevents the "spiral of death": if the tab is backgrounded for 5 seconds and then foregrounded, `delta` would be 5000ms. Without the cap, the loop would run 300 ticks at once, causing the game to warp forward in time. We cap at 250ms (~15 ticks) so there's a small freeze instead.

### Server vs. Client ticking

On the **server**, there's no rAF. The tick loop is a `setInterval`:

```js
this.tickInt = setInterval(() => this._tick(), 1000/60);
```

This is slightly less precise than the browser's rAF loop because `setInterval` can drift. For Phase 5, this could be improved with a high-resolution timer loop in a Worker thread.

The server's `_tick()` calls `tickEngine()` for each player's authoritative engine, then routes any resulting events (attacks, game-overs) to the other player.

---

## 3. The PRNG — Randomness Foundation

```js
class MINSTD {
  constructor(seed) {
    this.state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  }
  next() {
    this.state = Number(
      (BigInt(16807) * BigInt(this.state)) % BigInt(2147483647)
    );
    return (this.state - 1) / 2147483646;
  }
  nextInt(n) { return Math.floor(this.next() * n); }
}
```

This is the **MINSTD Linear Congruential Generator** — specifically the Park-Miller variant documented in TETR.IO's TetrisWiki entry.

**Formula:** `X(n+1) = (16807 × X(n)) mod 2147483647`

- **16807** = 7⁵, a primitive root modulo 2147483647
- **2147483647** = 2³¹ − 1, a Mersenne prime
- This combination gives a full-period generator: it cycles through all 2,147,483,646 possible values before repeating

**Why BigInt?** JavaScript stores numbers as 64-bit floats (IEEE 754 double precision). The largest integer representable exactly is 2⁵³ = 9,007,199,254,740,992. The intermediate value `16807 × 2147483646 ≈ 3.6 × 10¹³` exceeds 2⁵³, so multiplying as regular numbers would lose precision. BigInt handles arbitrary precision.

**Why this matters for the entire game:** TETR.IO uses a **single shared PRNG instance** for:
1. Shuffling the 7-bag (piece order)
2. Choosing garbage hole columns
3. Re-rolling hole columns during scatter mode

All three systems consume the same state in sequence. If you create a separate PRNG for garbage, replays desync because the piece order and garbage holes are no longer in lockstep with the original.

**The seed** for solo play comes from `Date.now()`. For multiplayer, the server generates a random seed and sends it to both clients in `matchStart`. Both clients call `createEngine(seed)` — their engines are then byte-for-byte identical from tick 0.

**Seeding rules:**
- Seed must be in range [1, 2147483646] — never 0 (0 is an absorbing state: 16807 × 0 = 0)
- The constructor `+1` ensures seed 0 becomes 1

---

## 4. The Board — Coordinates & Memory Layout

```
Total height: 40 rows (TOTAL_ROWS)
├── Rows 0–19:  Buffer zone   (invisible — spawn area)
└── Rows 20–39: Visible zone  (what the player sees)

Width: 10 columns (COLS)

board[row][col]:
  0         → empty cell
  '#rrggbb' → occupied, hex color string of the piece that locked here
```

**Why 40 rows?** The Tetris Guideline mandates a 20-row buffer zone above the visible area. Pieces spawn in this buffer and fall into the visible area. If a piece locks entirely within the buffer (all rows < 20 = `VIS_START`), that's a "Lock Out" — game over.

**Coordinate origin:** Row 0 is the top of the buffer (highest up). Row 39 is the floor. Column 0 is the left wall, column 9 is the right wall. Positive row direction = downward. This is standard for array-based grid games.

**Memory:** `createBoard()` creates a 40×10 array. Each cell is either `0` or a color string. Using a color string instead of a piece ID is convenient for rendering — you can pass it directly to `ctx.fillStyle` without a lookup table.

**Line clearing algorithm:**

```js
function clearLines(board) {
  let n = 0;
  for (let r = TOTAL_ROWS-1; r >= 0; r--) {
    if (board[r].every(c => c !== 0)) {
      board.splice(r, 1);           // remove full row
      board.unshift(new Array(COLS).fill(0));  // add empty row at top
      n++;
      r++;  // re-check this index (now contains what was above)
    }
  }
  return n;
}
```

We scan bottom-to-top. When a full row is found:
- `splice(r, 1)` removes it — the array gets shorter by one
- `unshift(...)` adds a new empty row at the top — array is back to 40
- `r++` counteracts the loop's `r--` so we re-examine the same index (which now holds what was one row above)

This correctly handles multiple consecutive full rows.

---

## 5. Pieces — Definitions & Rotation

Each piece is defined as 4 rotation states. Each state is an array of 4 `[row_offset, col_offset]` pairs relative to the piece's **rotation pivot** (its `row`/`col` position in the engine state).

```js
T: { color:'#b642d4', states:[
  [[-1,1],[0,0],[0,1],[0,2]],   // State 0: spawn (flat, bump up)
  [[-1,1],[0,1],[0,2],[1,1]],   // State 1: CW (bump right)
  [[0,0],[0,1],[0,2],[1,1]],    // State 2: 180° (bump down)
  [[-1,1],[0,0],[0,1],[1,1]],   // State 3: CCW (bump left)
]}
```

**Visualizing T at rotation 0** (pivot at row P, col P):
```
. X .      ← row P-1: offset [-1,1]
X X X      ← row P:   offsets [0,0], [0,1], [0,2]
```

**Rotation states are fixed** — stored as absolute offsets, not computed by matrix multiplication. This is more predictable and easier to debug than runtime rotation math.

**getCells()** translates from local offsets to absolute board coordinates:

```js
function getCells(piece) {
  return PIECES[piece.type].states[piece.rot]
    .map(([dr, dc]) => [piece.row + dr, piece.col + dc]);
}
```

**Spawn position:** `row: VIS_START - 1 = 19`, `col: 3`. After applying offsets, most pieces appear at rows 18–19 (the bottom of the buffer, just above the visible area). They "fall into" visibility naturally on the first gravity tick.

---

## 6. SRS Rotation System & Kick Tables

When a rotation would cause the piece to overlap a wall or locked cell, SRS attempts a series of **offset kicks** — position adjustments — in order. The first one that results in a valid position is used. If all fail, the rotation is rejected.

**Three kick tables are used:**

### JLSTZ kicks (all pieces except I)

```js
const SRS_JLSTZ = {
  '0>1': [[ 0,-1],[-1,-1],[2,0],[2,-1]],  // CW from spawn
  '1>0': [[ 0, 1],[ 1, 1],[-2,0],[-2,1]], // CCW back to spawn
  // ... etc
}
```

Key: `'fromState>toState'` (e.g. `'0>1'` = rotating CW from spawn state).  
Value: Array of `[row_delta, col_delta]` offsets to try, in order.

### I-piece kicks

The I-piece has a different kick table because its long shape interacts with walls differently. When it rotates CW near the right wall, it needs to kick left more than other pieces.

### 180° kicks (TEZA-specific, not in standard Tetris Guideline)

```js
const KICKS_180 = {
  0: [[0,0],[0,-1],[0,1],[-1,0],[1,0]],
  1: [[0,0],[1,0],[-1,0],[0,1],[0,-1]],
  // ...
}
```

This is TETR.IO's custom 180° rotation (the `A` key), documented by the community. Standard Tetris Guideline has no 180° rotation. The kicks are indexed by the **starting** rotation state (0–3).

### How tryRotate works

```js
function tryRotate(board, piece, dir) {
  const from = piece.rot;
  const to   = dir === 2 ? (from+2)%4 : ((from+dir)+4)%4;
  const rot  = {...piece, rot: to};

  // 180° uses its own kick table
  if (dir === 2) {
    for (const [dr,dc] of KICKS_180[from]) {
      const k = {...rot, row:rot.row+dr, col:rot.col+dc};
      if (isValid(board, getCells(k))) return {piece:k, kickIndex:-1};
    }
    return null;
  }

  // CW/CCW: first try with no offset (kickIndex -1 = no kick)
  if (isValid(board, getCells(rot))) return {piece:rot, kickIndex:-1};

  // Then try each kick in order
  const key   = `${from}>${to}`;
  const table = piece.type === 'I' ? SRS_I : SRS_JLSTZ;
  for (let i=0; i<kicks.length; i++) {
    const k = {...rot, row:rot.row+kicks[i][0], col:rot.col+kicks[i][1]};
    if (isValid(board, getCells(k))) return {piece:k, kickIndex:i};
  }
  return null;  // rotation fails
}
```

`kickIndex` is returned alongside the piece because T-spin detection needs to know **which kick was used**. A high kick index (3 or 4) indicates the T-piece rotated into a tight space — a strong signal that it's a full T-spin rather than a mini.

---

## 7. The 7-Bag Randomizer

The 7-bag system guarantees you never wait more than 12 pieces for any piece type (2 bags worst case).

**How it works:**
1. Start with `['I','O','T','S','Z','J','L']`
2. Apply a Fisher-Yates shuffle using the MINSTD PRNG
3. Pieces are drawn from the front; when the queue gets low, shuffle a new bag and append it

**Fisher-Yates shuffle:**

```js
_fill() {
  const b = [...PIECE_NAMES];       // ['I','O','T','S','Z','J','L']
  for (let i = 6; i > 0; i--) {
    const j = this.prng.nextInt(i + 1);  // random index in [0, i]
    [b[i], b[j]] = [b[j], b[i]];        // swap
  }
  this.queue.push(...b);
}
```

This iterates from the end backward, swapping each element with a random earlier element. After 6 swaps, every permutation is equally likely.

**PRNG consumption:** Each `_fill()` call consumes exactly 6 random numbers from the PRNG (one per swap). The constructor calls `_fill()` twice, consuming 12 values before the first piece is dealt. This is important for replay determinism — the garbage column system must account for these pre-consumed values.

**peek(n):** Returns the next `n` pieces without consuming them. Used by the client to render the "Next" queue (5 pieces). Does not advance the PRNG.

---

## 8. Movement, Collision & the Ghost Piece

### isValid

```js
function isValid(board, cells) {
  for (const [r, c] of cells) {
    if (c < 0 || c >= COLS || r >= TOTAL_ROWS) return false;  // wall/floor
    if (r >= 0 && board[r][c]) return false;                   // occupied cell
  }
  return true;
}
```

Note: `r < 0` is explicitly allowed. This is intentional — pieces can exist in negative row space during spawn (above the buffer). There's no ceiling to collide with.

### tryMove

```js
function tryMove(board, piece, dr, dc) {
  const m = {...piece, row: piece.row+dr, col: piece.col+dc};
  return isValid(board, getCells(m)) ? m : null;
}
```

Returns the new piece state if the move is valid, or `null` if blocked. The caller decides what to do with `null` (typically: do nothing for lateral moves, trigger lock for downward moves).

### Ghost piece

```js
function getGhost(board, piece) {
  let g = {...piece};
  while (true) {
    const d = {...g, row: g.row+1};
    if (!isValid(board, getCells(d))) break;
    g = d;
  }
  return g;
}
```

Drops the piece one row at a time until it can't drop anymore. The last valid position is the ghost. This runs every render frame — it's fast enough because pieces are small (4 cells) and boards are shallow (40 rows).

**To add a "sonic drop" (instantly move to ghost position without locking):** call `eng.active = getGhost(board, eng.active)` and reset `eng.gravTimer = 0`. Don't call `_lock()`.

---

## 9. Lock Delay — The Infinity System

When a piece touches the floor (or the top of the stack), a lock delay timer starts. The piece doesn't lock immediately — the player has time to slide or rotate it.

**Three counters:**

| Variable | Purpose | Limit |
|---|---|---|
| `lockTimer` | Ticks since last surface contact | 30 ticks (500ms) |
| `lockResets` | Times the timer has been reset by a move/rotate | 15 |
| `lockFloor` | Total ticks spent on any surface this piece | 60 ticks (1 second) |

Any one of these reaching its cap triggers an immediate lock.

**Reset on move/rotate:**
```js
if (eng.lockResets < LOCK_RESET_MAX) {
  eng.lockTimer = 0;
  eng.lockResets++;
}
```

Once `lockResets` reaches 15, the timer is no longer reset — the piece locks after 30 more ticks of surface contact.

**`lockFloor`** accumulates across all resets. Even if a player has 14 resets left, if they've spent a combined 60 ticks on any surface, the piece locks. This prevents stalling with micro-movements.

**`lockTimer` resets to 0 when the piece lifts off the surface** (leaves the floor by rotating up into the stack). This is intentional — it's part of the Infinity system.

**To tune for different game modes:**
- Faster locking: reduce `LOCK_DELAY` (30 → 20)
- More resets: increase `LOCK_RESET_MAX` (15 → 20)
- To disable Infinity (use Entry Reset instead): set `LOCK_RESET_MAX = 0`

---

## 10. T-Spin Detection

This is the most complex detection in the engine. It runs at the moment a T-piece locks, before the board is updated.

### The 3-Corner Rule

The T-piece has 4 diagonal corners relative to its center pivot. We categorize them as **front** (the direction the bump points) and **back** (the opposite side):

```js
// [back-left, back-right, front-left, front-right]
const T_CORNERS = [
  [[-1,-1],[-1,1],[1,-1],[1,1]],   // rot 0: bump points up → front = bottom
  [[-1,-1],[1,-1],[-1,1],[1,1]],   // rot 1: bump points right → front = right
  [[1,-1],[1,1],[-1,-1],[-1,1]],   // rot 2: bump points down → front = top
  [[-1,1],[1,1],[-1,-1],[1,-1]],   // rot 3: bump points left → front = left
]
```

Corners 0,1 = back corners. Corners 2,3 = front corners.

```js
function detectTSpin(board, piece, kickIndex) {
  if (piece.type !== 'T') return null;
  const corners = T_CORNERS[piece.rot];
  const filled  = corners.map(([dr,dc]) => isCellFilled(board, piece.row+dr, piece.col+dc));
  const count   = filled.filter(Boolean).length;

  if (count < 3) return null;              // need at least 3 corners filled
  if (kickIndex >= 3) return 'tspin';      // far kick always = full T-spin
  if (filled[2] && filled[3]) return 'tspin';  // both front corners = full
  if (count === 4) return 'tspin';         // all 4 corners = full
  return 'mini';                           // 3 corners but not both front = mini
}
```

**`isCellFilled`** treats walls and floor as "filled" — so a T-piece wedged against a wall with 3 wall-corners counts correctly.

### Kick Index as a spin signal

The kick index from `tryRotate()` indicates which SRS kick was used. Kick index 3 or 4 means the T-piece used one of the far kicks — it squeezed into a tight space. TETR.IO treats this as a full T-spin regardless of corner counts.

Kick index -1 means no kick was needed (rotated freely), or it was a 180° rotation.

### The `lastSpin` / `lastKick` system

The engine tracks whether the **last action** before a lock was a rotation:

- `rotate` input → sets `eng.lastSpin = 'candidate'`, `eng.lastKick = kickIndex`
- `move` or `softDrop` input → clears `eng.lastSpin = null`
- At lock time: if `lastSpin === 'candidate'`, run `detectTSpin()`

This is critical: a T-spin must be the final action. Moving the piece after rotating voids the spin. This matches TETR.IO's behavior.

---

## 11. Attack & Garbage System

### Base Attack Table

```js
const BASE_ATTACK = {
  null:  [0, 0, 1, 2, 4],    // index = lines cleared (0-4)
  tspin: [0, 2, 4, 6],        // T-spin: 0/1/2/3 line(s)
  mini:  [0, 0, 1],           // Mini: 0/1/2 line(s)
};
```

For example: a T-spin Double (2 lines, spin='tspin') → `BASE_ATTACK.tspin[2] = 4` lines sent.

### B2B (Back-to-Back) Bonus

B2B-eligible clears: Quads and any T-spin/Mini with lines. These chain together.

```js
// At lock time:
if (isB2BEligible(spin, cleared)) eng.b2b++;
else eng.b2b = 0;  // chain broken

// Attack bonus:
if (b2b > 0 && isB2BEligible(spin, cleared)) {
  atk += b2b >= 8 ? 3 : b2b >= 4 ? 2 : 1;
}
```

The first B2B-eligible clear **starts** the chain (b2b becomes 1) but gets **no bonus** yet. The second consecutive eligible clear gets +1. The bonus grows at levels 4 and 8.

### Combo Multiplier

TETR.IO doesn't use the standard Guideline flat `+1 per combo`. Instead it uses a multiplier on the base attack:

```js
const COMBO_MULT = [1.0, 1.0, 1.2, 1.4, 1.6, 1.8, 1.8];
// combo 0 = ×1.0, combo 1 = ×1.0, combo 2 = ×1.2, ...
```

This nerfs pure combo strategies (like 4-wide) because they send many singles at ×1.8 = still just singles. T-spin combos start with more base attack so the multiplier amplifies them more.

### All Clear (Perfect Clear)

```js
const ac = cleared > 0 && boardIsEmpty(eng.board);
if (allClear) return 10;  // overrides everything: 10 lines sent
```

After clearing lines, if the board is completely empty, that's an All Clear. The 10-line attack is applied regardless of spin type or B2B.

### Garbage Queue & Cancellation

Incoming garbage is buffered in `eng.garbageQueue = [{ count: N }, ...]`. It does **not** land immediately. Instead, when you place a piece:

1. Your attack lines cancel queued garbage front-first:
   ```js
   let rem = atk;
   while (rem > 0 && garbageQueue.length > 0) {
     const f = garbageQueue[0];
     if (f.count <= rem) { rem -= f.count; garbageQueue.shift(); }
     else { f.count -= rem; rem = 0; }
   }
   ```
2. After cancellation, any remaining queued garbage lands on the board immediately.

This means a player can "counter" incoming garbage by attacking on the same piece placement. It creates the core tension of multiplayer.

### Garbage Line Format

Each garbage line fills all 10 columns except one (the "hole"):

```js
const line = new Array(COLS).fill(GARBAGE_COL);  // '#444460'
line[col] = 0;  // hole
board.push(line);  // after board.shift() to make room
```

### Column Persistence & Sickness

**Persistence:** Within one attack batch, all lines share the same hole column (allows clean digging). When a new attack arrives, the column re-rolls but ensures it's different from the last.

**Sickness:** If a player places pieces repeatedly without clearing their own lines (just cancelling incoming garbage), `eng.sickness` increments. Above `SCATTER_THRESHOLD = 8`, each garbage line gets a **different** column — the well scatters, making it impossible to dig cleanly.

```js
eng.sickness = (cleared === 0 && atk === 0)
  ? Math.min(eng.sickness + 1, SCATTER_THRESHOLD + 2)
  : 0;  // resets on any clear or attack
```

---

## 12. The Engine State Object

`createEngine(seed)` returns this object. Every field here is part of the authoritative game state:

```js
{
  // Core systems (created once, mutated throughout)
  prng:         MINSTD instance,     // shared randomness source
  bag:          BagRandomizer,       // piece queue

  // Board
  board:        number[][],          // 40×10 grid (0 or color string)

  // Active piece
  active: {
    type:  string,   // 'I'|'O'|'T'|'S'|'Z'|'J'|'L'
    rot:   number,   // 0|1|2|3 (rotation state)
    row:   number,   // pivot row (0-indexed from buffer top)
    col:   number,   // pivot column
  },

  held:         string|null,   // held piece type, or null
  canHold:      boolean,       // false after holding until next piece spawns

  // Lock delay
  lockTimer:    number,        // ticks since last surface contact
  lockResets:   number,        // move/rotate resets used this piece
  lockFloor:    number,        // total ticks on any surface this piece

  // Gravity
  gravTimer:    number,        // ticks since last gravity drop

  // Scoring & rating
  score:        number,
  lines:        number,
  level:        number,        // floor(lines/10) + 1
  combo:        number,        // consecutive clears
  b2b:          number,        // back-to-back chain level
  attack:       number,        // total lines sent this match

  // Garbage
  garbageQueue: Array<{count:number}>,  // incoming garbage waiting to land
  lastGarbCol:  number,        // last garbage hole column (-1 = none yet)
  sickness:     number,        // scatter counter

  // Spin detection
  lastSpin:     'candidate'|null,  // 'candidate' if last action was a rotation
  lastKick:     number,            // kick index used in last rotation (-1 = no kick)

  // Lifecycle
  dead:         boolean,       // true after game-over
}
```

**To add a new stat** (e.g. "pieces placed"): add `piecesPlaced: 0` to `createEngine()`, increment it inside `_spawnNext()`, and read it in the client/server.

---

## 13. stepEngine — Input Processing

`stepEngine(eng, input)` takes one input and returns an array of **events**:

```js
// Input types:
{ type: 'move',           value: -1|1 }    // -1=left, 1=right
{ type: 'rotate',         value: -1|1|2 }  // -1=CCW, 1=CW, 2=180°
{ type: 'softDrop' }
{ type: 'hardDrop' }
{ type: 'hold' }
{ type: 'gravity' }        // internal: called by tickEngine
{ type: 'lockTick' }       // internal: called by tickEngine
{ type: 'receiveGarbage',  value: N }      // from server: N lines incoming

// Events returned:
{ type: 'attack',    lines, spin, b2b, combo, allClear }
{ type: 'garbage',   lines }
{ type: 'allClear' }
{ type: 'gameOver' }
```

**Key behaviors:**

- `move`: clears `lastSpin` (moving after rotating voids T-spin)
- `rotate`: sets `lastSpin = 'candidate'` (for T), stores `kickIndex`
- `softDrop`: clears `lastSpin`, resets `gravTimer`, awards +1 score
- `hardDrop`: teleports to ghost, awards +2 score per row, then locks
- `hold`: swaps active with held (or stashes if empty), sets `canHold = false`
- `gravity` / `lockTick`: internal — don't call these from user input
- `receiveGarbage`: pushes to `garbageQueue`, emits a `garbage` event

---

## 14. tickEngine — Gravity & Auto-lock

Called once per physics tick (60Hz). Handles:

1. **Gravity**: increment `gravTimer`. When it reaches `getGravity(level)`, drop the piece one row. Reset `gravTimer`.
2. **Lock delay**: if the piece is resting (can't drop), run `lockTick`. If not resting, reset `lockTimer`.

```js
function tickEngine(eng) {
  if (eng.dead) return [];
  const events = [];

  eng.gravTimer++;
  if (eng.gravTimer >= getGravity(eng.level)) {
    eng.gravTimer = 0;
    stepEngine(eng, { type: 'gravity' });
  }

  const resting = !tryMove(eng.board, eng.active, 1, 0);
  if (resting) {
    events.push(...stepEngine(eng, { type: 'lockTick' }));
  } else {
    eng.lockTimer = 0;
  }

  return events;
}
```

**Gravity table** (`GRAVITY_TABLE`): ticks per row drop at each level. Level 1 = 48 ticks (0.8 seconds per row). Level 30 = 1 tick (instant, effectively 20G). Values are based on the Tetris Guideline speed curve.

**To add 20G mode** (piece instantly falls to ghost on spawn): after `_spawnNext`, run gravity until the piece can't drop. The existing gravity loop handles this naturally if you set the gravity value to 1 or just directly call `eng.active = getGhost(eng.board, eng.active)` after spawn.

---

## 15. The Ribbon WebSocket Protocol

Every message is a JSON object with this envelope:

```json
{ "t": "input", "s": 42, "a": 38, "d": { "input": { "type": "hardDrop" } } }
```

| Field | Type | Meaning |
|---|---|---|
| `t` | string | Message type |
| `s` | integer | **Sequence ID** — increments with every message sent by this peer |
| `a` | integer | **Ack ID** — the last `s` value received from the other peer |
| `d` | object | The actual payload |

### Send Buffer

Both sides maintain a rolling buffer of the last 100 sent packets:

```js
this.sendBuf.push({ s: packet.s, raw });
if (this.sendBuf.length > MAX_BUF) this.sendBuf.shift();
```

### Reconnect Flow

When a WebSocket drops and reconnects:

```
Client → Server: { t: "resume", d: { roomId: "TEZA42", peerAck: 38 } }
Server finds sendBuf entries where s > 38
Server re-sends those entries in order
Game state is fully caught up without any desync
```

This makes matches resilient to brief disconnects (mobile network switching, etc.).

### Heartbeat

```
Server → Client: ping  (every 5 seconds)
Client → Server: pong  (immediate)

Client → Server: ping  (every 3 seconds, for latency display)
Server → Client: pong
```

If no pong is received within 10 seconds, `ws.terminate()` is called.

### The `pendingAction` pattern (client-side)

The UI buttons (Create Room, Join Room) need the WebSocket to be open before they can send. But the connection takes ~100ms to establish. To avoid the fragile `setTimeout(300ms)` anti-pattern:

```js
let pendingAction = null;

function connectAndDo(action) {
  if (ribbon && ribbon.ws.readyState === WebSocket.OPEN) {
    action();  // already connected, do it now
  } else {
    pendingAction = action;  // queue it
    connectRibbon();         // start connecting
  }
}

// In the _connected handler:
ribbon.on('_connected', () => {
  if (pendingAction) {
    const a = pendingAction;
    pendingAction = null;
    a();  // fire queued action
  }
});
```

---

## 16. Room System & Match Lifecycle

### State machine

```
'waiting' → (2 players join) → 'playing' → (someone dies) → 'finished'
```

### Full match sequence

```
[Both clients open the page]

Client A: createRoom → Server creates Room, adds A as player[0]
Server → A: roomJoined { roomId: "TEZA42", playerIndex: 0 }

Client B: joinRoom "TEZA42" → Server adds B as player[1]
Server → B: roomJoined { playerIndex: 1 }
Room._startMatch() called:
  - Creates two engine instances with the same seed
  - Sends matchStart to both clients
  - Starts a 5-second fallback timer

Client A receives matchStart:
  - Creates local engine with the seed
  - Shows "Get Ready..." overlay
  - Sends clientReady after one rAF frame

Client B does the same.

Server receives both clientReady:
  - Cancels the 5-second fallback
  - Calls _startTick() → starts setInterval at 60Hz
  - Broadcasts matchLive to both

Clients receive matchLive:
  - Set gameActive = true
  - Hide the "Get Ready..." overlay
  - Game begins

[Match in progress]
Client A presses Space (hardDrop):
  1. Client A: stepEngine(localEng, {type:'hardDrop'})  ← instant local feedback
  2. Client A: ribbon.send('input', {input:{type:'hardDrop'}})
  3. Server: room.handleInput(connA, {type:'hardDrop'})
  4. Server: stepEngine(engines[0], {type:'hardDrop'})
  5. Server: events include {type:'attack', lines:4}
  6. Server: stepEngine(engines[1], {type:'receiveGarbage', value:4})
  7. Server → B: incomingGarbage { lines:4 }
  8. Server → A: attackSent { lines:4 }

Client B receives incomingGarbage:
  - Pushes { count:4 } to localEng.garbageQueue
  - Updates garbage meter
  - Flashes red border

[Player B's stack reaches the top]
Server engine[1] emits gameOver
Server: deadFlags[1] = true → _endMatch(0)  ← player 0 wins

Server → A: matchOver { won:true, trDelta:+142, ... }
Server → B: matchOver { won:false, trDelta:-87, ... }

Both clients:
  - gameActive = false
  - localEng.dead = true
  - Show overlays
  - After 2.2s → show result screen
```

### clientReady handshake — why it matters

Without this handshake, the server's tick loop starts immediately after `_startMatch()`. The server fires 300+ ticks before the browser has rendered a single frame. Pieces lock and garbage accumulates during those ticks. When the player finally sees the board, it looks like garbage appeared from nowhere.

With the handshake, the server waits until both browsers confirm they've rendered a frame. The 5-second fallback prevents the game from never starting if a client is slow.

---

## 17. Client-Side Prediction

The client applies inputs to its **local engine** immediately — before the server has received or processed the input. This gives zero-latency feel even on 150ms+ connections.

```
Player presses Space:
  ├── Local: stepEngine(localEng, hardDrop)  → piece locks instantly on screen
  └── Network: ribbon.send('input', hardDrop) → arrives at server 75ms later
```

The server processes the same input on its authoritative engine. If both engines received the same inputs in the same order, they produce identical results (determinism guarantee).

**Where prediction can diverge:**

The local engine and server engine can get out of sync if:
1. A network packet is dropped/reordered
2. The client's 60Hz loop drifts from the server's 60Hz loop (gravity ticks happen at slightly different times)

**Current handling:** The server's board snapshots sent to spectators (`boardSnapshot`) would allow the server to also send corrections to players. This is implemented as a stub — `stateReport` is in the router but does nothing. To implement full reconciliation in Phase 5:

1. Server sends a board hash every N ticks to the player
2. Client hashes its local board and compares
3. On mismatch: client requests full board state, overwrites local engine

---

## 18. Glicko-2 Rating System

### Why not ELO?

ELO assumes your skill uncertainty is constant. Glicko-2 tracks **Rating Deviation (RD)** — a measure of how uncertain we are about your skill. New players have RD=350 (very uncertain, rating moves fast). Established players have RD=30 (very certain, rating barely moves).

### The three numbers

| Symbol | Name | Initial | Meaning |
|---|---|---|---|
| `r` | Rating | 1500 | Your skill estimate |
| `RD` | Rating Deviation | 350 | Uncertainty in your rating |
| `σ` | Volatility | 0.06 | How erratic your performance is |

### Internal scale conversion

Glicko-2 works on a different scale to make the math cleaner:

```js
μ = (r - 1500) / 173.7178    // rating on Glicko-2 scale
φ = RD / 173.7178             // deviation on Glicko-2 scale
```

`173.7178` = `400 / ln(10)`. This is the Glicko-2 constant that normalizes the scale.

### Update algorithm (step by step)

Given: player `{r, RD, σ}` played against opponent `{r_j, RD_j}` with result `s` (1=win, 0=loss):

**Step 1:** Convert to μ, φ scale.

**Step 2:** Compute g and E:
```
g(φ_j) = 1 / √(1 + 3φ_j² / π²)
E(μ, μ_j, φ_j) = 1 / (1 + exp(-g(φ_j)(μ - μ_j)))
```
`g` reduces the impact of uncertain opponents. `E` is the expected score (like ELO's expected win probability).

**Step 3:** Variance:
```
v = 1 / (g² × E × (1 - E))
```
How much information this match gives us about the player's true skill.

**Step 4:** Delta (improvement estimate):
```
Δ = v × g × (s - E)
```
Positive if you won when expected to lose, negative if you lost when expected to win.

**Step 5:** New volatility σ' via the **Illinois algorithm** (iterative root-finding):

This is the most complex step. It finds the new volatility that satisfies a transcendental equation. The Illinois algorithm is a bracketed root-finding method similar to bisection but faster. It converges in <100 iterations for all practical inputs (enforced by the `i<100` loop limit).

The `EPSILON = 0.000001` convergence threshold means we stop when the bracket is narrower than one millionth — sufficient precision for rating display.

**Step 6:** Pre-period deviation:
```
φ* = √(φ² + σ'²)
```
Inflates φ slightly to account for the uncertainty that builds up between rating periods.

**Step 7:** New μ and φ:
```
φ' = 1 / √(1/φ*² + 1/v)
μ' = μ + φ'² × g × (s - E)
```

**Step 8:** Convert back:
```
r'  = μ' × 173.7178 + 1500
RD' = max(30, φ' × 173.7178)
```

**`RD_MIN = 30`:** The floor. Even the most certain rating can't go below this — we're never 100% sure of anyone's skill.

---

## 19. Tetra Rating (TR) Formula

This converts Glicko-2's `r` and `RD` into a single display number from 0 to 25,000:

```js
function calcTR(r, rd) {
  const ln10  = Math.log(10);
  const denom = GLICKO_SCALE * Math.sqrt(3 * ln10 * ln10 * rd * rd + Math.PI * Math.PI);
  return 25000 / (1 + Math.pow(10, (R_INITIAL - r) * Math.PI / denom));
}
```

This is the community-documented TETR.IO formula. It's a **sigmoid function** that:
- Maps a player with `r=1500, RD=350` → TR ≈ 12,500 (middle of the scale)
- Increases TR as `r` grows
- **Decreases TR as `RD` grows** — high uncertainty is penalized, preventing unranked players from camping the leaderboard with lucky wins

**RD visibility rule (`RD_HIDDEN = 100`):** If `RD > 100`, TR is shown as `null` in `sanitizeProfile()`. The client renders this as "?" until the player has played enough games to calibrate. This takes roughly 15–20 games from a fresh account.

---

## 20. Matchmaking Queue

```js
const queue = [];  // [{ conn, tr, range, timer }]

function joinQueue(conn) {
  const entry = { conn, tr: profileTR, range: 500 };
  entry.timer = setInterval(() => {
    entry.range += 500;   // expand search radius
    tryMatch();
  }, 10000);
  queue.push(entry);
  tryMatch();             // immediately check for a match
}

function tryMatch() {
  for (let i=0; i<queue.length; i++)
    for (let j=i+1; j<queue.length; j++) {
      const a=queue[i], b=queue[j];
      if (Math.abs(a.tr - b.tr) <= Math.max(a.range, b.range)) {
        // matched — create ranked room
      }
    }
}
```

**Range expansion:** Every 10 seconds, each player's accepted TR difference grows by 500. After 60 seconds, the range is 3500 — effectively matching anyone. This prevents players waiting forever.

**Fair matching:** `Math.max(a.range, b.range)` means the larger of the two ranges wins. If player A has been waiting 40 seconds (range=2500) and player B just joined (range=500), the match is made if `|tr_a - tr_b| <= 2500`. This is intentional — long-waiting players shouldn't be penalized for waiting.

**Unranked players:** Use `R_INITIAL = 1500` (middle TR) as their queue TR. They'll match against calibrating players and low-ranked players first.

---

## 21. Spectator Mode

Spectators join a room after it's full or already in progress. They receive:

1. **Immediate state snapshot** on join (current board, both players)
2. **Board snapshots every 250ms** while the match runs

```js
// On spectator join:
room.addSpectator(conn);
this._sendSnap(conn);  // immediate current state

// In _startTick():
this.snapInt = setInterval(() => {
  if (this.spectators.length) this._broadcastSnap();
}, 250);
```

The snapshot contains both boards' full state:

```js
{
  boards:  [board_p0, board_p1],   // 40×10 arrays
  held:    [held_p0, held_p1],
  active:  [active_p0, active_p1],
  stats:   [{ attack, lines, b2b, garbageQueue }, ...],
  players: ['alice', 'bob'],
}
```

The client injects these into fake engine objects for rendering:

```js
ribbon.on('boardSnapshot', ({ boards, held, active, stats, players }) => {
  localEng.board  = boards[0];
  localEng.active = active[0];
  remoteEng.board = boards[1];
  remoteEng.active = active[1];
  // renderAll() picks these up on next rAF frame
});
```

**250ms snapshot rate** is a balance between bandwidth and smoothness. At 10 columns × 40 rows × 2 players, each snapshot is roughly 800 values + metadata. At 4 per second: manageable. For production, you'd compress this (delta encoding, run-length encoding, or protobuf).

**To add replay scrubbing:** Instead of snapshots, record all inputs server-side (already done in replay recording). A scrubber would re-simulate from the start at high speed to reach any point in the game.

---

## 22. Replay System (.teza format)

Every match generates a `.teza` file:

```json
{
  "version": "0.4.0",
  "seed": 1705312200123,
  "inputs": [
    { "tick": 0,  "pi": 0, "input": { "type": "move", "value": -1 } },
    { "tick": 42, "pi": 1, "input": { "type": "hardDrop" } }
  ],
  "events": [
    { "tick": 42, "pi": 1, "e": { "type": "attack", "lines": 4 } }
  ],
  "meta": {
    "startedAt": "2024-01-15T10:30:00.000Z",
    "duration":  92000,
    "players":   ["alice", "bob"],
    "ranked":    true,
    "result":    { "winnerIdx": 0, "players": ["alice", "bob"] }
  }
}
```

**`inputs[]`:** Every player input with its server tick. This is the minimum data needed to reconstruct the entire game — given the same seed, feeding the same inputs at the same ticks produces the same board state.

**`events[]`:** Pre-computed game events (attacks, clears, game-over). Stored separately so a replay viewer can show what happened at any point without re-simulating from the beginning (just scrub the events array).

**`pi`:** Player index (0 or 1). Used to route inputs to the correct engine during replay.

**To implement a replay player:**

```js
function replayMatch(teza) {
  const engines = [createEngine(teza.seed), createEngine(teza.seed)];
  let tick = 0;
  let inputIdx = 0;

  function step() {
    // Apply all inputs for this tick
    while (inputIdx < teza.inputs.length && teza.inputs[inputIdx].tick === tick) {
      const { pi, input } = teza.inputs[inputIdx];
      stepEngine(engines[pi], input);
      inputIdx++;
    }
    // Advance physics
    tickEngine(engines[0]);
    tickEngine(engines[1]);
    tick++;
    renderBothBoards(engines);
    if (tick < maxTick) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
```

**Replay files are saved at:** `data/replays/<timestamp>-<random>.teza`  
**Downloadable via:** `GET /api/replay/<id>` (HTTP) or the result screen button.

---

## 23. Player Profile Store

### Data format

```js
// playerStore (in-memory, also data/players.json)
{
  "alice": {
    username:    "alice",
    createdAt:   "2024-01-15T10:00:00.000Z",
    r:           1642.3,   // Glicko-2 rating
    rd:          87.4,     // rating deviation
    vol:         0.059,    // volatility
    tr:          14820,    // Tetra Rating (display)
    gamesPlayed: 23,
    wins:        14,
    losses:      9,
    totalAttack: 834,
    totalLines:  1204,
    bestAPM:     87,
    bestPPS:     0.82,
    replayIds:   ["1705312200123-abc", "1705398600456-def", ...],  // last 20
  }
}
```

Keys are **lowercased usernames** (`playerStore["alice"]` not `playerStore["Alice"]`). The `username` field preserves the original casing for display.

### sanitizeProfile

Before sending to clients, profiles are sanitized:

```js
function sanitizeProfile(p) {
  return {
    username, tr: p.rd <= RD_HIDDEN ? Math.round(p.tr) : null,
    rd: Math.round(p.rd), gamesPlayed, wins, losses,
    winRate: Math.round(wins/gamesPlayed*100),
    bestAPM, bestPPS, createdAt, replayIds,
  };
}
```

Internal Glicko-2 values (`r`, `vol`) are never sent to clients. TR is null if RD > 100 (not yet calibrated).

### Persistence

`savePlayers()` writes `JSON.stringify(playerStore, null, 2)` to disk after every match. This is synchronous (`fs.writeFileSync`) — fine for a game with <1000 players. For production: use async writes, or better, replace with SQLite.

**To migrate to SQLite (Phase 5):** Replace `loadPlayers()`, `savePlayers()`, `getPlayer()`, `createPlayer()`, and `recordResult()` with equivalent database calls. The rest of the server code is entirely decoupled from the storage layer.

---

## 24. The Client UI — Screens & State

The client has four screens managed by a simple CSS class system:

```js
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
```

| Screen ID | When shown |
|---|---|
| `login-screen` | On load, or after logout |
| `lobby-screen` | After successful login |
| `game-screen` | During a match (player or spectator) |
| `result-screen` | After match ends |

### Client state variables

```js
let ribbon      = null;    // RibbonClient instance (null until first action)
let myUsername  = null;    // logged-in username
let myProfile   = null;    // profile object from server
let localEng    = null;    // local engine (client-side prediction)
let remoteEng   = null;    // opponent's engine (display only)
let gameActive  = false;   // physics runs only when true
let isSpectator = false;   // spectator = no inputs, board comes from snapshots
let isRanked    = false;   // affects result screen display
let rafId       = null;    // requestAnimationFrame ID
```

---

## 25. Rendering Pipeline

Three canvases are used:
- `local-board` (280×560px = 10×20 cells @ 28px each)
- `remote-board` (same size, scaled down 75% via CSS)
- `local-hold`, `remote-hold` (80×60px mini previews)
- `local-next`, `remote-next` (80×360px, 5 piece slots)

### Board rendering

```js
function renderBoard(ctx, eng, isLocal) {
  // 1. Clear
  ctx.clearRect(0, 0, COLS*CELL, VIS_ROWS*CELL);

  // 2. Grid lines (subtle background)
  ctx.strokeStyle = '#1a1a28'; ctx.lineWidth = 0.5;
  // ... draw horizontal and vertical lines

  // 3. Locked cells (rows 20-39 of the 40-row board)
  for (let r = VIS_START; r < TOTAL_ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (eng.board[r][c]) drawCell(ctx, r - VIS_START, c, eng.board[r][c]);

  // 4. Ghost piece (semi-transparent)
  // 5. Active piece (+ T-spin glow if armed)
}
```

**Key:** `r - VIS_START` maps board rows 20–39 to canvas rows 0–19. Buffer rows (0–19) are never rendered.

### drawCell

```js
function drawCell(ctx, r, c, color, alpha=1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle   = color;
  ctx.fillRect(c*CELL+1, r*CELL+1, CELL-2, CELL-2);  // 1px inset on all sides
  ctx.fillStyle = lighten(color, 0.25);                // highlight
  ctx.fillRect(c*CELL+2, r*CELL+2, CELL-6, 3);        // top edge highlight
  ctx.fillRect(c*CELL+2, r*CELL+2, 3, CELL-6);        // left edge highlight
  ctx.globalAlpha = 1;
}
```

The 1px inset + highlight create the classic "beveled block" Tetris look. `lighten()` shifts each RGB channel toward white by the given amount.

---

## 26. Common Bugs & How to Fix Them

### "Garbage appeared at the start of the game"

**Cause:** The server's tick loop started before the client was ready. Pieces locked during those early ticks, and garbage was applied.

**Fix (already implemented):** The `clientReady` handshake. Both clients send this after their first `requestAnimationFrame`, and the server only starts the tick loop when both have confirmed.

**If it happens again:** Check that `gameActive` is `false` in `startMatch()` and only becomes `true` in the `matchLive` handler. Also verify the server is correctly waiting for both `ready[0] && ready[1]`.

### "Winner shows 'You Lost' after opponent dies"

**Cause:** The local engine on the winner's side kept receiving gravity ticks after `gameActive` was set to false, eventually triggering a local game-over event that overwrote the win overlay.

**Fix (already implemented):** In `matchOver` handler, set `localEng.dead = true`. The `handleLocalEvents()` function checks `ev.type === 'gameOver'` and only acts on it — since `dead = true` prevents further `stepEngine` calls, no new `gameOver` events are generated.

**If it happens again:** Check that `stepEngine(eng, input)` returns early when `eng.dead === true` (it does — line 1 of `stepEngine`). Also verify `tickEngine` checks `eng.dead` at the top.

### "Pieces move at wrong speed / gravity too fast or slow"

**Cause:** Usually the tick loop is running at the wrong rate, or `GRAVITY_TABLE` values are wrong for a new mode.

**Debug:** Add `console.log(eng.gravTimer, getGravity(eng.level))` inside `tickEngine`. The timer should reach the gravity value and reset. At 60Hz, level 1 gravity (48 ticks) means a piece drops every 0.8 seconds.

### "T-spin not detected"

**Cause:** Player moved after rotating (clearing `lastSpin`), or the corner fill conditions weren't met.

**Debug:** Add a temporary log inside `detectTSpin`:
```js
console.log('Corners:', filled, 'Count:', count, 'Kick:', kickIndex);
```
Verify that 3+ corners are filled and that `kickIndex` is within expectations.

### "Ratings not updating after ranked match"

**Cause:** Either `conn.username` is null (player not logged in), or the match was created as casual (`ranked: false`).

**Debug:** Add `console.log(this.ranked, wConn.username, lConn.username)` inside `_endMatch`. Both usernames must be set and `this.ranked` must be `true`.

### "WebSocket closes immediately on reconnect"

**Cause:** Often the `ws.terminate()` in the heartbeat fires too soon. Check `PING_TIMEOUT` (10 seconds). If the server is under load and pong responses are slow, increase this.

### "Board desyncs between client and server"

**Cause:** Inputs arrive out of order, or the client's gravity timer drifts from the server's. Currently there's no correction mechanism.

**Long-term fix (Phase 5):** Implement state reconciliation — server sends a board hash every N ticks, client compares, requests full resync if they differ.

---

## 27. How to Add New Features

### Adding a new game mode (e.g. "Ultra" — max score in 3 minutes)

1. **Server:** Add `'ultra'` as a valid mode in `Room` and track `blitzTime = 180000`.
2. **Engine:** The engine doesn't know about modes — it just runs. Track the timer in the server/client.
3. **Client:** Add an "Ultra" button in the lobby. In `matchStart`, set `isUltra = data.mode === 'ultra'`. Show a countdown timer in the UI. When time runs out, the server calls `_endMatch(highScorePlayerIndex)`.

### Adding a new input (e.g. "sonic drop" — drop without locking)

1. **Engine (`stepEngine`):** Add a new case:
   ```js
   case 'sonicDrop': {
     eng.active = getGhost(eng.board, eng.active);
     eng.gravTimer = 0;
     eng.lastSpin = null;
     break;
   }
   ```
2. **Client:** Map a key to `sendInput({type:'sonicDrop'})`.
3. **Replay:** Automatically recorded since it goes through `handleInput`.

### Adding a new stat (e.g. "T-spins performed")

1. **Engine state:** Add `tspins: 0` to `createEngine()`.
2. **Engine `_lock()`:** After T-spin detection, increment: `if (spin === 'tspin') eng.tspins++`.
3. **Server match stats:** In `handleInput`, copy `eng.tspins` to `matchStats[idx]`.
4. **Client:** Display `localEng.tspins` in the stats panel.
5. **Profile:** Add `bestTspins` to the player profile schema and update in `recordResult()`.

### Adding sound

The engine emits events — listen to them in the client:

```js
const evs = stepEngine(localEng, input);
for (const ev of evs) {
  if (ev.type === 'attack') playSound('clear', ev.lines);
  if (ev.type === 'allClear') playSound('allclear');
}
```

Use the Web Audio API or a library like Howler.js.

### Replacing the flat JSON store with SQLite

Install `better-sqlite3`:
```bash
npm install better-sqlite3
```

Replace the four store functions:
```js
// Old:
function getPlayer(username) { return playerStore[username.toLowerCase()] || null; }
function savePlayers() { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playerStore)); }

// New:
const db = new Database('data/teza.db');
db.exec(`CREATE TABLE IF NOT EXISTS players (
  username TEXT PRIMARY KEY,
  data     TEXT NOT NULL
)`);
function getPlayer(username) {
  const row = db.prepare('SELECT data FROM players WHERE username=?').get(username.toLowerCase());
  return row ? JSON.parse(row.data) : null;
}
function savePlayers() { /* not needed — save per player */ }
function savePlayer(p) {
  db.prepare('INSERT OR REPLACE INTO players (username, data) VALUES (?,?)').run(p.username.toLowerCase(), JSON.stringify(p));
}
```

---

## 28. Full Message Reference

### Client → Server

| Message | Payload | Description |
|---|---|---|
| `login` | `{ username }` | Login or create account |
| `createRoom` | — | Create a casual room |
| `joinRoom` | `{ roomId }` | Join by room code (becomes spectator if full) |
| `spectate` | `{ roomId }` | Explicitly join as spectator |
| `joinQueue` | — | Join ranked matchmaking (requires login) |
| `leaveQueue` | — | Cancel ranked search |
| `clientReady` | — | Sent after first rAF frame; triggers tick loop start |
| `input` | `{ input }` | Game input (see input types in §13) |
| `resume` | `{ roomId, peerAck }` | Reconnect with last-known ack ID |
| `getProfile` | `{ username? }` | Request a player's profile |
| `getLeaderboard` | — | Request top 50 ranked players |
| `ping` | — | Latency measurement |
| `pong` | — | Heartbeat response |

### Server → Client

| Message | Payload | Description |
|---|---|---|Documentation
| `hello` | `{ id, version, brand }` | Connection established, assigned ID |
| `loginOk` | `{ username, profile }` | Login successful |
| `loginError` | `{ msg }` | Login failed (invalid username) |
| `roomJoined` | `{ roomId, playerIndex, playerCount, ranked }` | Joined a room |
| `spectatorJoined` | `{ roomId, state, players }` | Joined as spectator |
| `matchStart` | `{ seed, playerIndex, opponent, ranked, opponentProfile }` | Match about to begin |
| `matchLive` | — | Both clients ready; game starts now |
| `incomingGarbage` | `{ lines, from, spin, b2b }` | Opponent sent you garbage |
| `attackSent` | `{ lines, spin, b2b, allClear }` | Your attack was confirmed |
| `boardSnapshot` | `{ boards, held, active, stats, players }` | State broadcast (spectators + opponent display) |
| `matchOver` | `{ won, winnerIdx, replayId, myStats, oppStats, trOld, trNew, trDelta }` | Match ended |
| `allClear` | `{ player }` | A player got an All Clear |
| `opponentDisconnected` | `{ grace }` | Opponent dropped; N ms to reconnect |
| `opponentReconnected` | — | Opponent came back |
| `queueJoined` | `{ position, tr }` | In matchmaking queue |
| `queueLeft` | — | Left the queue |
| `profileData` | `{ profile }` | Requested profile data |
| `leaderboard` | `{ entries }` | Top 50 ranked players |
| `error` | `{ msg, code }` | Server error |
| `ping` | — | Heartbeat check |
| `pong` | — | Heartbeat response |

### REST API

| Route | Method | Returns |
|---|---|---|
| `/api/profile/:username` | GET | Sanitized player profile JSON |
| `/api/leaderboard` | GET | Array of top 50 profiles |
| `/api/replay/:id` | GET | Raw .teza replay file |

---

*TEZA — teza.ke — Built in Kenya 🇰🇪*  
*Documentation written in collaboration with Claude (Anthropic, Claude Sonnet 4.6)*