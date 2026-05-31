# TEZA

> **teza.ke &nbsp;·&nbsp; Built in Kenya 🇰🇪**

A competitive multiplayer block-stacking game — a faithful reimplementation of [TETR.IO](https://tetr.io) mechanics built from publicly available reverse-engineering documentation.

*Teza* is Swahili for **"to play"**.

> **AI Disclosure:** This project was designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). All architecture, documentation, and source code were produced through a directed conversation between the project author and the AI assistant. Claude contributed system design, algorithm implementation, protocol engineering, inline documentation, and this README. Every non-trivial decision is explained in the phase docs and inline code comments.

---

## Quick Start (Phase 3 — Multiplayer)

```bash
npm install
npm start
# Open http://localhost:3000 in two tabs
# Tab 1: Create Room → share the 6-char code
# Tab 2: Enter code → Join → match starts
```

No build step. Node.js ≥ 18 required.

---

## Project Goal

Build a complete TETR.IO clone in documented phases — each fully playable — using only public information:

- Official TETR.IO `.ttr` / `.ttrm` replay format spec
- Community reverse-engineering (Poyo's Ribbon protocol docs, awesome-tetrio)
- TetrisWiki documentation on guideline mechanics
- osk's (the developer's) public Discord messages

No decompilation. No proprietary access. No ToS violations.

---

## Phases

| Phase | Status | Scope |
|---|---|---|
| **Phase 1** | ✅ Complete | Solo engine: MINSTD PRNG, SRS, lock delay, Sprint/Blitz |
| **Phase 2** | ✅ Complete | T-spins, B2B chains, garbage system, attack table, Sandbox |
| **Phase 3** | ✅ Complete | Ribbon WebSocket, 1v1 multiplayer, room system, client-side prediction |
| **Phase 4** | 🔧 Planned | Glicko-2 / TR rating, matchmaking, spectator mode, replays |

---

## Architecture

```
teza-phase3/
├── shared/engine.js   ← Deterministic game core (Node.js + browser)
├── server/server.js   ← Authoritative server + Ribbon protocol
├── client/index.html  ← Browser client + rendering + input
└── package.json
```

### The Determinism Principle

The entire game — piece order, garbage holes, board state — flows from a single **MINSTD PRNG** seeded per match:

```
X(n+1) = (16807 × X(n)) mod 2147483647
```

This means `{ seed, inputs[] }` is enough to reconstruct any game. Replays, anti-cheat, and spectating all follow from this.

### Ribbon Protocol (Simplified)

Every WebSocket message carries a sequence/ack envelope:

```json
{ "t": "input", "s": 42, "a": 38, "d": { "input": { "type": "hardDrop" } } }
```

Both sides buffer the last 100 sent packets. On reconnect, the client sends its last `a` (ack ID) and the server replays any missed packets — games survive brief disconnects without desyncing.

### Client-Side Prediction

Inputs are applied to the **local engine immediately** for zero-latency feel, then forwarded to the server. The server is authoritative on conflicts (garbage, game-over, opponent state).

---

## Controls

| Key | Action |
|---|---|
| `← →` | Move |
| `↑` | Rotate CW |
| `Z` | Rotate CCW |
| `A` | Rotate 180° |
| `↓` | Soft drop |
| `Space` | Hard drop |
| `C` / `Shift` | Hold |
| `P` | Pause |

---

## Documentation

| File | Contents |
|---|---|
| [`PHASE1.md`](./PHASE1.md) | MINSTD PRNG, SRS, fixed timestep, board coordinate system |
| [`PHASE2.md`](./PHASE2.md) | T-spin detection, B2B chains, attack table, garbage sickness |
| [`PHASE3.md`](./PHASE3.md) | Ribbon protocol, shared engine, client prediction, room system |

---

## Sources

| Source | Used For |
|---|---|
| [TETR.IO GitHub](https://github.com/tetrio/issues) | Replay format, input key names |
| [TetrisWiki — TETR.IO](https://tetris.wiki/TETR.IO) | MINSTD formula, mechanics |
| [TetrisWiki — T-spin](https://tetris.wiki/T-spin) | 3-corner rule |
| [TetrisWiki — SRS](https://tetris.wiki/Super_Rotation_System) | Kick tables |
| [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) | Community resource index |
| Poyo's TETR.IO Bot Docs | Ribbon protocol, garbage PRNG ordering |
| TETR.IO Discord (archived) | Attack table, 180° kicks, sickness system |

---

## License

Fan reimplementation for educational purposes.  
TETR.IO is created by osk and is not affiliated with this project.  
Tetris® is a trademark of The Tetris Company.

---

*TEZA — teza.ke — Built in Kenya 🇰🇪*
