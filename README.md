# TEZA

> **teza.ke &nbsp;·&nbsp; Built in Kenya 🇰🇪**

A competitive multiplayer block-stacking game — a faithful re-implementation of [TETR.IO](https://tetr.io) mechanics built from publicly available reverse-engineering documentation, community format specs, and official replay schemas.

*Teza* is Swahili for **"to play"**.

> **AI Disclosure:** This project was designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). All architecture, documentation, and source code were produced through a directed conversation between the project author and the AI. Claude contributed system design, algorithm implementation, protocol engineering, rating math, and documentation. Every decision is explained in the phase docs and inline comments.

---

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000 in two browser tabs
# Each tab: enter a username → Create Room / Join Room
# Or: both click "Find Ranked Match" to be paired by TR
```

Node.js ≥ 18 required. No build step. No database.

---

## Phases

| Phase | Status | Scope |
|---|---|---|
| **Phase 1** | ✅ Complete | Solo engine: MINSTD PRNG, SRS+180° kicks, lock delay, Sprint/Blitz |
| **Phase 2** | ✅ Complete | T-spins, B2B chains, attack table, garbage system, Sandbox |
| **Phase 3** | ✅ Complete | Ribbon WebSocket, 1v1 multiplayer, room system, client-side prediction |
| **Phase 4** | ✅ Complete | Glicko-2 ratings, profiles, matchmaking, spectator mode, replays |
| **v1.0.0** | ✅ Released | Solo Practice mode, input isolation, stability & cleanup |
| **Phase 5** | 🔧 Planned | Auth hardening, database, mobile input, tournament brackets |

---

## Architecture

```
teza/
├── shared/engine.js   ← Deterministic game core (Node.js + browser)
├── server/server.js   ← Authoritative server + Ribbon + ratings
├── client/index.html  ← Browser client: lobby, game, spectator, results
└── data/
    ├── players.json   ← All player profiles + Glicko-2 ratings
    └── replays/       ← .teza match replays (one file per game)
```

### Core Principles

**Determinism:** A single MINSTD PRNG seeded per match drives all randomness (piece order, garbage holes). `{ seed, inputs[] }` reconstructs any game exactly.

**Shared Engine:** `engine.js` runs identically on server (Node.js) and browser. Server validates inputs authoritatively; client predicts locally for zero-latency feel.

**Ribbon Protocol:** Every WebSocket message carries `{ t, s, a, d }`. Both sides buffer 100 sent packets. Reconnects replay missed packets from the buffer — matches survive brief disconnects.

**Glicko-2 + TR:** Full Glicko-2 rating with TETR.IO's community-documented Tetra Rating display formula. TR hidden until RD ≤ 100.

---

## File Index

| File | Description |
|---|---|
| `shared/engine.js` | Shared game engine (PRNG, pieces, SRS, physics, attack) |
| `server/server.js` | Authoritative game server + Ribbon protocol + ratings |
| `client/index.html` | Browser client — lobby, solo, multiplayer, spectator, results |
| `data/players.json` | Persistent player profiles + Glicko-2 ratings |
| `data/replays/` | `.teza` match replay files (one per game) |
| `package.json` | npm/pnpm config — `npm start` runs the server |
| `README.md` | This file |
| `CHANGELOG.md` | Release history |
| `DOCUMENTATION.md` | Deep-dive: engine, protocol, rating math |
| `PHASE4.md` | Glicko-2, TR formula, matchmaking, spectator, replays |

---

## Solo Practice

Play immediately without creating an account. Click **Solo Practice** on the login screen, or **Solo** in the lobby.

- Full game engine running locally — no server required
- No garbage injection — pure sandbox for practice
- All controls, SRS rotation, and mechanics identical to multiplayer
- Press **Leave** to return to lobby at any time

---

## Controls

| Key | Action |
|---|---|
| `← →` | Move |
| `↑` | Rotate CW |
| `Z` | Rotate CCW |
| `A` | Rotate 180° (TEZA / TETR.IO custom) |
| `↓` | Soft drop |
| `Space` | Hard drop |
| `C` / `Shift` | Hold |
| `P` | Pause |

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
| Mark Glickman (2012) | Glicko-2 algorithm |
| TETR.IO Discord (archived) | TR display formula |

---

## License

Fan re-implementation for educational purposes.
TETR.IO is created by osk and is not affiliated with this project.
Tetris® is a trademark of The Tetris Company.

---

*TEZA — teza.ke — Built in Kenya 🇰🇪*
