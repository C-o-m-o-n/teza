# CHANGELOG

All notable changes to TEZA are documented here.

---

## [1.0.0] — 2026-06-13 — First Major Release

This is the first stable, feature-complete release of TEZA.

### ✨ New in 1.0.0

#### Solo Practice Mode
- Added a **Solo Practice** button to both the Login screen (play instantly without an account) and the Lobby screen
- Solo mode runs a fully local game engine instance — no server connection required during play
- Piece spawning, SRS rotation, lock delay, soft/hard drop, hold, and ghost piece all work identically to multiplayer
- No garbage injection in solo mode — pure sandbox practice, faithful to TETR.IO's "play vs nobody" feel
- Leaving solo returns cleanly to the lobby without disrupting any live server session

#### Stability & Cleanup
- Removed duplicate keyboard event listeners that caused double-input registration
- Input isolation: keyboard events are not forwarded over WebSocket when in solo mode
- Cleaned up `btn-leave` logic to correctly distinguish solo vs. multiplayer sessions

---

## [0.4.0] — Phase 4: Ratings, Profiles & Competitive Play

- Glicko-2 rating system (μ, φ, σ) with Illinois algorithm for volatility
- Tetra Rating (TR) display formula (0–25,000), hidden until RD ≤ 100
- Persistent username-based player profiles (flat JSON, no database)
- Matchmaking queue — TR-range matching, expands ±500 every 10 s
- Result screen with TR delta and stat comparison
- Spectator mode — watch any live match (250 ms board snapshots)
- `.teza` replay format — deterministic, downloadable per match
- REST API: `/api/profile/:username`, `/api/leaderboard`, `/api/replay/:id`
- Leaderboard (top 50 calibrated players)

---

## [0.3.0] — Phase 3: Multiplayer

- Ribbon WebSocket protocol (`{ t, s, a, d }`) with reconnect buffering
- Authoritative server with client-side prediction for zero-latency feel
- Room system — Create / Join by code, 1v1 matches
- Shared `engine.js` runs identically on server and browser

---

## [0.2.0] — Phase 2: Attack & Garbage

- T-spin detection (3-corner rule)
- Back-to-Back chains
- Attack table (singles → quads, T-spins)
- Garbage system with PRNG hole positioning and sickness counter

---

## [0.1.0] — Phase 1: Solo Engine

- MINSTD PRNG (Park-Miller) — piece bag & garbage holes
- SRS rotation with full kick tables + 180° kicks
- Fixed-timestep game loop (60 Hz physics, uncapped render)
- Lock delay, soft drop, hard drop, hold
- Sprint (40-line) and Blitz (2-minute) modes
