# TETRIO Clone

A faithful browser-based re-implementation of [TETR.IO](https://tetr.io), built from publicly available reverse-engineering documentation, community format specs, and the official TETR.IO replay file schema.

> **AI Disclosure:** This project was designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). All architecture, documentation, and source code were produced through a directed conversation between the project author and the AI assistant. Claude contributed system design, algorithm implementation, inline documentation, and this README. Every non-trivial decision is explained in the phase docs and inline comments.

---

## Project Goal

To build a complete TETR.IO clone in stages — each phase fully playable and documented — using only public information:

- The official TETR.IO `.ttr` / `.ttrm` replay format spec
- Community reverse-engineering (Poyo's Ribbon protocol docs, awesome-tetrio)
- The TETR.IO open-source acknowledgements page
- TetrisWiki documentation on guideline mechanics
- osk's (the developer's) public Discord messages

No decompilation, no proprietary access, no ToS violations.

---

## Phases

| Phase | File | Status | Scope |
|---|---|---|---|
| **Phase 1** | `tetrio-clone-phase1.html` | ✅ Complete | Solo engine: PRNG, SRS, lock delay, Sprint/Blitz |
| **Phase 2** | `tetrio-clone-phase2.html` | ✅ Complete | T-spins, B2B, garbage table, attack system, Sandbox |
| **Phase 3** | *(in progress)* | 🔧 Planned | Ribbon WebSocket, 1v1 multiplayer, room system |
| **Phase 4** | *(planned)* | 📋 Planned | Glicko-2 / Tetra Rating, leaderboard |

---

## Quick Start

No build step. No dependencies.

```bash
# Clone or download the repo
# Open any phase file directly in a browser:
open tetrio-clone-phase2.html
```

Works in Chrome, Firefox, Safari, Edge. Requires ES2020 (BigInt support).

---

## Architecture Summary

### The PRNG Foundation

Every randomness decision in TETR.IO flows from a single **MINSTD Linear Congruential Generator**:

```
X(n+1) = (16807 × X(n)) mod 2147483647
```

One instance per match, seeded by the server (or timestamp in solo play). The same state drives:
1. Fisher-Yates 7-bag shuffle (piece order)
2. Garbage hole column selection
3. Scatter column re-rolls (sickness system)

This is why `.ttr` replay files only need `{ seed, inputs[] }` — the entire game is reconstructable.

### Fixed 60Hz Timestep

Physics runs at exactly 60 ticks/second via a **delta-time accumulator**, independent of monitor refresh rate. The fractional remainder of the accumulator is the **subframe** value stored in replay inputs.

```
accumulator += (now - lastTime)
while accumulator >= 16.666ms:
    tick()
    accumulator -= 16.666ms
render()
```

### T-Spin Detection Pipeline

```
Player presses rotate
  → tryRotate() returns { piece, kickIndex }
  → lastKickIndex = kickIndex
  → lastSpinType = 'candidate'   (if T-piece)

Player presses move or soft-drop
  → lastSpinType = null           (spin voided)

Piece locks
  → detectTSpin(board, piece, lastKickIndex)
  → 3-corner rule + kick index → 'tspin' | 'mini' | null
  → attack calculated from result
```

---

## Controls

| Key | Action |
|---|---|
| `← →` | Move |
| `↑` | Rotate CW |
| `Z` | Rotate CCW |
| `A` | Rotate 180° (TETR.IO custom) |
| `↓` | Soft drop |
| `Space` | Hard drop |
| `C` / `Shift` | Hold |
| `P` | Pause |

---

## Documentation

Each phase has its own detailed doc:

- [`PHASE1.md`](./PHASE1.md) — PRNG, SRS, board system, fixed timestep
- [`PHASE2.md`](./PHASE2.md) — T-spin detection, B2B, attack table, garbage system

---

## Sources

| Source | Used For |
|---|---|
| [TETR.IO GitHub (Issues / Format Specs)](https://github.com/tetrio/issues) | Replay format, input key names |
| [TetrisWiki — TETR.IO](https://tetris.wiki/TETR.IO) | MINSTD formula, confirmed mechanics |
| [TetrisWiki — T-spin](https://tetris.wiki/T-spin) | 3-corner rule |
| [TetrisWiki — SRS](https://tetris.wiki/Super_Rotation_System) | Kick tables |
| [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) | Community resource index |
| Poyo's TETR.IO Bot Docs | Ribbon protocol, garbage PRNG ordering |
| Community-documented attack table | TETR.IO Discord (archived) |
| osk public Discord messages | 180° kick table, sickness system |

---

## License

This project is an independent fan re-implementation for educational purposes. TETR.IO is created by osk and is not affiliated with this project. Tetris® is a trademark of The Tetris Company.
