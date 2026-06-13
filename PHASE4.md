# TEZA — Phase 4: Ratings, Profiles, Matchmaking, Spectator & Replays

> **AI Disclosure:** Designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). Glicko-2 math, TR formula, matchmaking algorithm, spectator architecture, and replay format were all coded and documented with AI assistance.

---

## Overview

Phase 4 transforms TEZA from a multiplayer game into a **competitive platform**. Players now have persistent identities, rated matches, and a path to climb the leaderboard.

---

## What's New

| System | Details |
|---|---|
| **Login** | Username-based profiles, auto-created on first login |
| **Glicko-2 Rating** | Full implementation: μ, φ, σ, Illinois algorithm for volatility |
| **Tetra Rating (TR)** | TETR.IO-sourced display formula, 0–25000 range |
| **RD Calibration** | TR hidden until RD ≤ 100, floor at 30 |
| **Profile Card** | TR, W/L, win rate, best APM/PPS, RD calibration bar |
| **Matchmaking Queue** | TR-range matching, expands ±500 every 10s |
| **Ranked Matches** | Rating updates applied after result |
| **Result Screen** | TR delta, stats comparison, replay download |
| **Spectator Mode** | Watch any live match; 250ms board snapshots |
| **Replay System** | `.teza` JSON format, saved per match, downloadable |
| **REST API** | `/api/profile/:username`, `/api/leaderboard`, `/api/replay/:id` |
| **Leaderboard** | Top 50 ranked players (≥10 games, RD ≤ 100) |
| **Flat JSON Store** | `data/players.json` — no database required |

---

## Glicko-2 Implementation

### Why Glicko-2?

TETR.IO uses Glicko-2 (documented in community reverse-engineering). It improves on plain ELO by tracking *rating deviation* (RD) — how certain we are of a player's skill. New players have high RD and their rating moves quickly; established players have low RD and change slowly.

### Internal Scale

The algorithm works on μ/φ (Glicko-2 scale), converted from r/RD:

```
μ = (r - 1500) / 173.7178
φ = RD / 173.7178
```

### Update Steps (per Glickman 2012)

```
1. Convert r, RD → μ, φ
2. Compute g(φ_j) = 1 / √(1 + 3φ²/π²)
3. Compute E(μ, μ_j, φ_j) = 1 / (1 + exp(-g(φ_j)(μ - μ_j)))
4. v = estimated variance = 1 / (g²·E·(1-E))
5. Δ = estimated improvement = v · g · (score - E)
6. New σ' via Illinois algorithm (iterative root-finding)
7. φ* = √(φ² + σ'²)  ← pre-rating-period deviation
8. φ' = 1 / √(1/φ*² + 1/v)
9. μ' = μ + φ'² · g · (score - E)
10. Convert back: r' = μ'·173.7178 + 1500, RD' = max(30, φ'·173.7178)
```

### System Constant τ = 0.6

Controls how much volatility (σ) can change per match. TETR.IO documented as 0.5–0.7. We use 0.6 — a moderate value that prevents wild rating swings from single matches.

### Tetra Rating (TR) Formula

Community-documented TETR.IO formula. Maps r/RD to a 0–25,000 display number:

```
TR = 25000 / (1 + 10^( (1500 - r)·π / (173.7178·√(3·ln²(10)·RD²+π²)) ))
```

- At r=1500, RD=350: TR ≈ 12,500 (exactly middle)
- Increasing r raises TR; increasing RD lowers it (uncertainty penalty)
- RD > 100: TR hidden publicly (shown as "?" until calibrated)

---

## Matchmaking Queue

```
Player joins queue → { tr, range: 500 }
Every 10s: range += 500

Matching: for each pair in queue:
  if |tr_a - tr_b| ≤ max(range_a, range_b):
    → create ranked room, remove both
```

After 60 seconds (range = 3500), effectively matches anyone. This prevents indefinite waiting.

---

## Spectator Mode

Any client can join a live room as a spectator. The server sends **board snapshots** every 250ms containing both players' full board arrays, active pieces, held pieces, and stats. Spectators render both boards using the shared engine's rendering helpers but send no inputs.

```
Server → Spectator (every 250ms):
{
  t: "boardSnapshot",
  d: {
    boards:  [board_p0, board_p1],
    held:    [held_p0, held_p1],
    active:  [active_p0, active_p1],
    stats:   [{ attack, lines, b2b, garbageQueue }, ...],
    players: ["alice", "bob"]
  }
}
```

---

## Replay Format (.teza)

```json
{
  "version": "1.0.0",
  "seed": 1234567890,
  "inputs": [
    { "tick": 42,  "pi": 0, "input": { "type": "hardDrop" } },
    { "tick": 61,  "pi": 1, "input": { "type": "move", "value": -1 } }
  ],
  "events": [
    { "tick": 42, "pi": 0, "e": { "type": "attack", "lines": 4 } }
  ],
  "meta": {
    "startedAt": "2024-01-15T10:30:00Z",
    "duration":  92000,
    "players":   ["alice", "bob"],
    "ranked":    true,
    "result":    { "winnerIdx": 0, "players": ["alice", "bob"] }
  }
}
```

**To replay:** `createEngine(seed)`, advance `tickEngine()` per tick, feed `inputs` at their tick boundaries. The `events` array is pre-computed for fast UI scrubbing without re-simulation.

---

## REST API

| Route | Method | Description |
|---|---|---|
| `/api/profile/:username` | GET | Public profile data |
| `/api/leaderboard` | GET | Top 50 ranked players |
| `/api/replay/:id` | GET | Download a .teza replay file |

---

## Data Storage

No database. All data in `data/`:

```
data/
├── players.json       ← all profiles + ratings (flushed after each match)
└── replays/
    ├── 1705312200000-a4b2c.teza
    └── 1705312800000-x9y1z.teza
```

For production (Phase 5): replace `players.json` with SQLite or PostgreSQL. The `getPlayer`/`createPlayer`/`savePlayers` interface is the only coupling — swap the implementation behind it.

---

## New WebSocket Messages

| Type | Direction | Description |
|---|---|---|
| `login` | C→S | `{ username }` — login/register |
| `loginOk` | S→C | `{ username, profile }` |
| `loginError` | S→C | `{ msg }` |
| `joinQueue` | C→S | Join ranked matchmaking |
| `queueJoined` | S→C | `{ position, tr }` |
| `leaveQueue` | C→S | Cancel search |
| `spectate` | C→S | `{ roomId }` — watch a match |
| `spectatorJoined` | S→C | Confirmed spectator |
| `boardSnapshot` | S→C | `{ boards, held, active, stats, players }` |
| `matchStart` | S→C | Now includes `ranked`, `opponentProfile` |
| `matchOver` | S→C | Now includes `trOld`, `trNew`, `trDelta`, `myStats`, `oppStats` |
| `getProfile` | C→S | `{ username }` |
| `profileData` | S→C | `{ profile }` |
| `getLeaderboard` | C→S | Request top 50 |
| `leaderboard` | S→C | `{ entries }` |

---

## Running

```bash
npm install
npm start
open http://localhost:3000

# Two tabs:
# Tab 1: enter username → Create Room
# Tab 2: enter username → enter code → Join
# Or: both click "Find Ranked Match"
```

---

## Sources

- Mark Glickman, "Example of the Glicko-2 system" (2012) — glicko.net
- Community-documented TETR.IO TR formula (TETR.IO Discord, archived)
- [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) — rating system references
- Phases 1–3 documentation (this repo)
