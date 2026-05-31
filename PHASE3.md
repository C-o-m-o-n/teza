# TEZA — Phase 3: Ribbon Multiplayer Protocol

> **AI Disclosure:** This phase was designed and implemented in collaboration with [Claude](https://claude.ai) (Anthropic, Claude Sonnet 4.6). The Ribbon protocol architecture, server room system, client-side prediction model, and reconnection resilience logic were all derived from community reverse-engineering of TETR.IO's network layer, then coded and documented with AI assistance.

---

## Overview

Phase 3 is the largest architectural shift in the project. The single-file game becomes a **networked client-server system**:

```
teza-phase3/
├── shared/
│   └── engine.js        ← Deterministic game engine (runs on BOTH sides)
├── server/
│   └── server.js        ← Authoritative Node.js server + Ribbon protocol
├── client/
│   └── index.html       ← Browser client: rendering, input, prediction
└── package.json
```

The key insight enabling all of this is the **shared engine**: because the game is fully deterministic given a seed and input stream, the same `engine.js` module runs on the server (Node.js / CommonJS) and in the browser (global `window.TezaEngine`) without any changes.

---

## What's New in Phase 3

| System | Details |
|---|---|
| **Ribbon Protocol** | Sequence/ack envelope, 100-packet send buffer, replay on reconnect |
| **Heartbeat** | Ping/pong every 5s, 10s timeout before disconnect |
| **Room System** | 6-char room codes, 2-player match, creator shares code |
| **Authoritative Server** | Server runs its own engine per player for validation |
| **Client-Side Prediction** | Inputs apply locally before server ack for zero-latency feel |
| **Garbage Forwarding** | Server routes attack events to opponent's engine |
| **Disconnect Grace** | 15-second reconnection window before forfeit |
| **Reconnect Resumption** | Client sends last ack ID; server replays missed packets |
| **Solo Mode** | Full game without a server (auto-garbage sandbox) |
| **TEZA Branding** | Full rebrand — name, tagline, `teza.ke`, 🇰🇪 |
| **Shared Engine Module** | Extracted from HTML into `shared/engine.js` |

---

## The Ribbon Protocol

### Why Custom Protocol?

Standard WebSocket is unreliable for a real-time game: dropped connections lose all in-flight messages, TCP's retransmit adds unpredictable latency spikes, and there's no built-in way to resume a session. TETR.IO solved this with **Ribbon** — an idempotent session layer on top of WebSocket JSON.

### Packet Envelope

Every message sent by either side is wrapped:

```json
{
  "t": "input",
  "s": 42,
  "a": 38,
  "d": { "input": { "type": "hardDrop" } }
}
```

| Field | Meaning |
|---|---|
| `t` | Message type (string) |
| `s` | Sequence ID — increments with every sent message |
| `a` | Acknowledgment ID — the last `s` we received from the peer |
| `d` | Payload — the actual data |

### Send Buffer

Both client and server keep a rolling buffer of the last **100 sent packets**:

```js
this.sendBuf.push({ s: packet.s, raw });
if (this.sendBuf.length > MAX_BUF) this.sendBuf.shift();
```

### Reconnection Flow

```
1. Client WebSocket drops
2. Client reconnects (auto-retry every 2s)
3. Client sends: { t: "resume", d: { roomId, peerAck: lastReceivedSeq } }
4. Server looks up buffer: filter packets where s > peerAck
5. Server rapid-fires all missed packets
6. Game state is perfectly caught up — no desync
```

This means a **15-second disconnect** during a match can be recovered with zero game-state loss.

### Heartbeat

```
Client → Server: { t: "ping", s: N, a: M }   every 5000ms
Server → Client: { t: "pong", s: N, a: M }   immediate reply

Server → Client: { t: "ping" }                server-initiated
Client → Server: { t: "pong" }                client reply

If no pong within 10s → ws.terminate()
```

Ping round-trip time is displayed in the UI as latency (ms).

---

## Architecture: Shared Engine

The most important decision in Phase 3 is extracting the game engine into `shared/engine.js`.

### Why It Matters

```
Server side:                          Client side:
  const E = require('../shared/engine')   <script src="/shared/engine.js">
  const eng = E.createEngine(seed)        const eng = TezaEngine.createEngine(seed)
  E.stepEngine(eng, input)                TezaEngine.stepEngine(eng, input)
```

Identical API, identical behavior. This enables:

1. **Anti-cheat**: Server can validate every client input against its own engine
2. **Client-side prediction**: Client applies inputs locally before server ack
3. **Spectating**: Any observer can reconstruct the game from seed + inputs
4. **Replay**: Store `{ seed, inputs[] }` — replay by feeding inputs to engine

### Export Pattern

The module uses a dual-export pattern to work in both environments:

```js
const TezaEngine = { createEngine, stepEngine, tickEngine, ... };

if (typeof module !== 'undefined') module.exports = TezaEngine;  // Node.js
else if (typeof window !== 'undefined') window.TezaEngine = TezaEngine;  // Browser
```

---

## Client-Side Prediction

### The Problem

A player in Nairobi connecting to a server in Europe might have 80-150ms RTT. Without prediction, every keypress would feel sluggish — the piece wouldn't move until the server ack'd the input.

### The Solution

```
Player presses ArrowLeft:
  1. Apply input to LOCAL engine immediately   ← zero latency, feels instant
  2. Send { type: 'move', value: -1 } to server
  3. Server applies same input to AUTHORITATIVE engine
  4. Server sends back events (attacks, garbage)
  5. If server state diverges → stateCorrection (Phase 4)
```

The player always sees their own inputs applied instantly. The server is the source of truth for opponent interactions.

### Prediction vs. Authority

| Event | Who decides |
|---|---|
| Piece movement | Client predicts, server validates |
| Gravity / lock | Both run independently (same tick rate) |
| Garbage received | Server decides, client applies on notification |
| Game over | Server declares, client displays |
| Attack sent | Client shows optimistically, server confirms |

---

## Room System

### Flow

```
Player A                    Server                    Player B
   │                           │                           │
   ├── createRoom ────────────►│                           │
   │◄─── roomJoined (TEZA42) ──┤                           │
   │                           │◄──── joinRoom (TEZA42) ───┤
   │◄─── matchStart (seed) ────┤                           │
   │                           ├──── matchStart (seed) ───►│
   │     [game runs]           │     [game runs]           │
```

### Seed Distribution

The match seed is generated server-side:

```js
this.seed = Math.floor(Math.random() * 2147483646) + 1;
```

Sent to **both players** in `matchStart`. Both clients create `createEngine(seed)` — their local engines start identically. The server also creates two engines for authoritative tick processing.

### Server Tick Loop

The server runs a `setInterval` at 60Hz for gravity and lock delay:

```js
const TICK_MS = 1000 / 60;
this.tickInt = setInterval(() => this._tick(), TICK_MS);

_tick() {
  for (let i = 0; i < 2; i++) {
    const events = tickEngine(this.engines[i]);
    this._handleEvents(i, events);  // forward attacks, detect game over
  }
}
```

### Garbage Routing

When Player A sends an attack:

```
Server engine[A] emits: { type:'attack', lines:4 }
  → stepEngine(engines[B], { type:'receiveGarbage', value:4 })
  → players[B].send('incomingGarbage', { lines:4 })
  → players[A].send('attackSent', { lines:4 })
```

Player B's client queues the garbage; it lands when B places their next piece (same mechanic as Phase 2).

---

## Disconnect & Reconnect

### Grace Period

When a player disconnects mid-match, the server does **not** immediately forfeit them. Instead:

```js
const RECONNECT_GRACE = 15000;  // 15 seconds

// Start grace timer
conn._disconnectTimer = setTimeout(() => {
  if (this.state === 'playing') this._endMatch(1 - idx);  // forfeit
}, RECONNECT_GRACE);
```

The opponent is notified with the remaining grace time.

### Resume Flow

On reconnect, the client automatically sends:

```js
if (this.roomId) {
  this.send('resume', { roomId: this.roomId, peerAck: this.recvAck });
}
```

The server cancels the forfeit timer and replays missed packets:

```js
handleReconnect(conn, peerAck) {
  clearTimeout(conn._disconnectTimer);
  conn.replayFrom(peerAck);  // send all buffered packets after peerAck
}
```

---

## File Structure

```
teza-phase3/
├── package.json
│
├── shared/
│   └── engine.js
│       ├── §1   MINSTD PRNG
│       ├── §2   Piece definitions
│       ├── §3   SRS kick tables
│       ├── §4   7-Bag randomizer
│       ├── §5   Board helpers
│       ├── §6   Movement & rotation (tryRotate returns kick metadata)
│       ├── §7   T-spin detection
│       ├── §8   Attack table + combo multiplier
│       ├── §9   Garbage system
│       ├── §10  Gravity & lock constants
│       ├── §11  Engine factory (createEngine, stepEngine)
│       └── §12  Tick helper (tickEngine)
│
├── server/
│   └── server.js
│       ├── §1   HTTP server (serves client files)
│       ├── §2   RibbonConn class (sequence, ack, buffer, heartbeat)
│       ├── §3   Room class (match lifecycle, tick loop, garbage routing)
│       ├── §4   WebSocket server + message routing
│       └── §5   Startup / listen
│
└── client/
    └── index.html
        ├── §1   RibbonClient class (auto-reconnect, resume)
        ├── §2   Rendering helpers (board, mini-piece, next queue)
        ├── §3   Popup system
        ├── §4   Game state variables
        ├── §5   Input handling + DAS/ARR
        ├── §6   Local event handler (prediction output)
        ├── §7   Game loop (RAF + fixed timestep)
        ├── §8   Stats display
        ├── §9   Overlay helpers
        ├── §10  Ribbon message handlers
        ├── §11  Match start
        ├── §12  Solo mode
        └── §13  UI wiring (buttons, lobby)
```

---

## Running Locally

```bash
# 1. Install dependencies
cd teza-phase3
npm install

# 2. Start server
npm start
# → Server running at http://localhost:3000

# 3. Open two browser tabs
open http://localhost:3000
open http://localhost:3000

# 4. Tab 1: click "Create Room" → copy the 6-char code
# 5. Tab 2: paste code → click "Join"
# 6. Match starts automatically
```

**Solo mode** (no server needed): click "Solo Practice" on the lobby screen.

---

## Message Reference

| Type | Direction | Payload | Description |
|---|---|---|---|
| `hello` | S→C | `{ id, version, brand }` | Connection established |
| `createRoom` | C→S | — | Create a new room |
| `joinRoom` | C→S | `{ roomId }` | Join existing room |
| `roomJoined` | S→C | `{ roomId, playerIndex, playerCount }` | Confirmed join |
| `matchStart` | S→C | `{ seed, playerIndex, opponent }` | Match begins |
| `input` | C→S | `{ input }` | Player input event |
| `incomingGarbage` | S→C | `{ lines, from, spin, b2b }` | Opponent attacked you |
| `attackSent` | S→C | `{ lines, spin, b2b, allClear }` | Your attack confirmed |
| `opponentState` | S→C | `{ board, held, bagPeek, ... }` | Opponent board snapshot |
| `matchOver` | S→C | `{ won, winnerIndex }` | Match ended |
| `resume` | C→S | `{ roomId, peerAck }` | Reconnect with last ack |
| `ping` / `pong` | both | — | Heartbeat |
| `error` | S→C | `{ msg, code }` | Server error |

---

## Sources & References

- Poyo's TETR.IO Network Protocol Docs (community, archived via awesome-tetrio)
- [awesome-tetrio](https://github.com/Sup3rFire/awesome-tetrio) — Ribbon protocol references
- TETR.IO community Discord — Ribbon envelope format, reconnect flow
- Phase 1 & Phase 2 documentation (this repo)
- [ws npm package](https://www.npmjs.com/package/ws) — WebSocket server library

---

## What's Next — Phase 4

- Glicko-2 rating system with Tetra Rating (TR) formula
- Persistent player profiles (username, stats)
- Matchmaking queue (ranked mode)
- Spectator mode (watch live matches)
- Replay recording and playback (`.teza` format)
- Anti-cheat: server-side board hash validation
- State correction: server snaps client on divergence
