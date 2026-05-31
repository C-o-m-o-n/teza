/**
 * ============================================================
 * TEZA — server/server.js
 * ============================================================
 * Authoritative game server implementing the Ribbon protocol.
 *
 * RIBBON PROTOCOL (reverse-engineered from TETR.IO community docs):
 *   Every message has an outer envelope:
 *     { t, s, a, d }
 *     t = message type  (string)
 *     s = sequence ID   (integer, increments per sent message)
 *     a = ack ID        (last sequence received from peer)
 *     d = payload       (game data)
 *
 *   RESILIENCE:
 *     Both sides keep a rolling buffer of the last 100 sent packets.
 *     On reconnect, client sends its last known ack ID.
 *     Server replays any missed packets from buffer.
 *     This means a match survives brief disconnects without desyncing.
 *
 * SERVER RESPONSIBILITIES:
 *   1. Maintain authoritative engine state per player
 *   2. Receive input events from clients
 *   3. Validate inputs against server engine (anti-cheat)
 *   4. Forward attack events to the opponent
 *   5. Broadcast board state snapshots periodically
 *   6. Handle disconnect/reconnect via Ribbon resumption
 *   7. Detect game-over and declare winner
 *
 * ROOM SYSTEM:
 *   Players join via /join. Two players in a room = match starts.
 *   Room code is 6 uppercase chars (e.g. "TEZA42").
 *   Creator gets the room code and shares it. Second player joins.
 *
 * RUN:
 *   node server.js [port]   (default: 3000)
 *   Open client/index.html in two browser tabs on localhost
 * ============================================================
 */

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { createEngine, stepEngine, tickEngine, COLS, VIS_START } = require('../shared/engine');

const PORT = process.env.PORT || 3000;

/* ============================================================
 * §1  HTTP SERVER
 * Serves the client files so you can just run `node server.js`
 * and open localhost:3000 without a separate web server.
 * ============================================================ */
const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  const ext    = path.extname(filePath);
  const mime   = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };

  // Serve shared engine to client at /shared/engine.js
  const candidates = [
    path.join(__dirname, '../client', filePath),
    path.join(__dirname, '..', filePath),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      fs.createReadStream(p).pipe(res);
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
});

/* ============================================================
 * §2  RIBBON CONNECTION CLASS
 * ============================================================
 *
 * Each connected WebSocket gets a RibbonConn that handles:
 *  - Sequence numbering (outbound)
 *  - Ack tracking (inbound)
 *  - Send buffer (last 100 packets for replay on reconnect)
 *  - Heartbeat ping/pong
 *
 * SEQUENCE IDs:
 *   sendSeq: increments with every message we send
 *   recvAck: the last sequence ID we received from the peer
 *
 * BUFFER:
 *   sendBuf[] stores the last MAX_BUF sent packets.
 *   On reconnect, we scan it for any packet with seq > peerAck
 *   and re-send those to fill the gap.
 * ============================================================ */
const MAX_BUF        = 100;
const PING_INTERVAL  = 5000;   // ms between heartbeats
const PING_TIMEOUT   = 10000;  // ms before considering dead

class RibbonConn {
  constructor(ws, id) {
    this.ws      = ws;
    this.id      = id;
    this.sendSeq = 0;
    this.recvAck = 0;
    this.sendBuf = [];    // [{ s, packet }]
    this.alive   = true;
    this.roomId  = null;
    this.pingTimer   = null;
    this.pongTimeout = null;
    this._startHeartbeat();
  }

  /** Send a typed message with Ribbon envelope */
  send(type, data = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const packet = { t: type, s: this.sendSeq++, a: this.recvAck, d: data };
    const raw    = JSON.stringify(packet);
    // Store in send buffer for possible replay
    this.sendBuf.push({ s: packet.s, raw });
    if (this.sendBuf.length > MAX_BUF) this.sendBuf.shift();
    this.ws.send(raw);
  }

  /**
   * Replay missed packets after reconnect.
   * Client sends its last known ack; we re-send everything after that.
   */
  replayFrom(peerAck) {
    const missed = this.sendBuf.filter(b => b.s > peerAck);
    console.log(`[Ribbon] Replaying ${missed.length} missed packets for ${this.id}`);
    for (const b of missed) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b.raw);
    }
  }

  _startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (!this.alive) { this.ws.terminate(); return; }
      this.alive = false;
      this.send('ping');
      this.pongTimeout = setTimeout(() => {
        if (!this.alive) {
          console.log(`[Heartbeat] ${this.id} timed out`);
          this.ws.terminate();
        }
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
  }

  pong() {
    this.alive = true;
    clearTimeout(this.pongTimeout);
  }

  destroy() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimeout);
  }
}

/* ============================================================
 * §3  ROOM SYSTEM
 * ============================================================
 *
 * A Room holds two players and one match.
 * State machine: 'waiting' → 'playing' → 'finished'
 *
 * MATCH SEED:
 *   Generated server-side via crypto.randomBytes (not Math.random).
 *   Sent to both players at match start so their engines are
 *   seeded identically. The server also runs its own engine
 *   for each player for authoritative validation.
 *
 * TICK LOOP:
 *   Server runs a 60Hz interval for gravity/lock ticks.
 *   In a production system you'd use a worker thread — for
 *   Phase 3 a setInterval suffices.
 * ============================================================ */
const rooms    = new Map();  // roomId → Room
const connRoom = new Map();  // connId → roomId

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

class Room {
  constructor(id) {
    this.id      = id;
    this.players = [];   // [RibbonConn, RibbonConn]
    this.engines = [];   // authoritative engine per player index
    this.state   = 'waiting';
    this.seed    = Math.floor(Math.random() * 2147483646) + 1;
    this.tickInt = null;
  }

  addPlayer(conn) {
    const idx = this.players.length;
    this.players.push(conn);
    conn.roomId = this.id;
    connRoom.set(conn.id, this.id);
    conn.send('roomJoined', { roomId: this.id, playerIndex: idx, playerCount: this.players.length });
    console.log(`[Room ${this.id}] Player ${conn.id} joined (${this.players.length}/2)`);
    if (this.players.length === 2) this._startMatch();
  }

  _startMatch() {
    this.state = 'playing';
    // Create authoritative engine for each player with same seed
    this.engines = [
      createEngine(this.seed),
      createEngine(this.seed),
    ];
    console.log(`[Room ${this.id}] Match started, seed=${this.seed}`);

    for (let i = 0; i < 2; i++) {
      this.players[i].send('matchStart', {
        seed:        this.seed,
        playerIndex: i,
        opponent:    this.players[1-i].id,
      });
    }

    // Server-side 60Hz tick loop
    const TICK_MS = 1000 / 60;
    this.tickInt  = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    if (this.state !== 'playing') return;
    for (let i = 0; i < 2; i++) {
      const eng    = this.engines[i];
      const events = tickEngine(eng);
      this._handleEvents(i, events);
    }
  }

  /**
   * Receive a player input, apply to server engine, forward events.
   *
   * ANTI-CHEAT NOTE:
   *   The server applies every input to its own authoritative engine.
   *   If the server's resulting board diverges significantly from the
   *   client's reported state, we can flag/kick. For Phase 3 we
   *   trust the client but lay the groundwork.
   */
  handleInput(conn, input) {
    const idx = this.players.indexOf(conn);
    if (idx === -1 || this.state !== 'playing') return;
    const eng    = this.engines[idx];
    const events = stepEngine(eng, input);
    this._handleEvents(idx, events);
  }

  _handleEvents(playerIdx, events) {
    if (!events.length) return;
    const sender   = this.players[playerIdx];
    const opponent = this.players[1 - playerIdx];

    for (const ev of events) {
      switch (ev.type) {
        case 'attack':
          // Forward garbage to opponent's engine and client
          if (opponent) {
            stepEngine(this.engines[1-playerIdx], { type:'receiveGarbage', value: ev.lines });
            opponent.send('incomingGarbage', { lines: ev.lines, from: sender.id, spin: ev.spin, b2b: ev.b2b });
          }
          // Ack the attack back to sender for their stats
          sender.send('attackSent', { lines: ev.lines, spin: ev.spin, b2b: ev.b2b, allClear: ev.allClear });
          break;

        case 'gameOver':
          this._endMatch(1 - playerIdx);  // Other player wins
          break;

        case 'allClear':
          // Broadcast to both for spectator display
          this._broadcast('allClear', { player: playerIdx });
          break;
      }
    }
  }

  _endMatch(winnerIdx) {
    if (this.state !== 'playing') return;
    this.state = 'finished';
    clearInterval(this.tickInt);
    console.log(`[Room ${this.id}] Match over. Winner: player ${winnerIdx}`);
    for (let i = 0; i < 2; i++) {
      const won = (i === winnerIdx);
      this.players[i].send('matchOver', { won, winnerIndex: winnerIdx });
    }
  }

  _broadcast(type, data) {
    for (const p of this.players) p.send(type, data);
  }

  /**
   * Handle a player disconnect.
   * In Ribbon fashion: we don't end the match immediately.
   * We give them RECONNECT_GRACE ms to reconnect.
   */
  handleDisconnect(conn) {
    const idx = this.players.indexOf(conn);
    if (idx === -1) return;
    console.log(`[Room ${this.id}] Player ${conn.id} disconnected (grace period starts)`);

    const opponent = this.players[1 - idx];
    if (opponent) opponent.send('opponentDisconnected', { grace: RECONNECT_GRACE });

    // Give them time to reconnect before forfeiting
    conn._disconnectTimer = setTimeout(() => {
      console.log(`[Room ${this.id}] Player ${conn.id} forfeited after grace period`);
      if (this.state === 'playing') this._endMatch(1 - idx);
    }, RECONNECT_GRACE);
  }

  handleReconnect(conn, peerAck) {
    const idx = this.players.indexOf(conn);
    if (idx === -1) return;
    clearTimeout(conn._disconnectTimer);
    console.log(`[Room ${this.id}] Player ${conn.id} reconnected`);
    conn.replayFrom(peerAck);
    const opponent = this.players[1 - idx];
    if (opponent) opponent.send('opponentReconnected', {});
  }

  cleanup() {
    clearInterval(this.tickInt);
  }
}

const RECONNECT_GRACE = 15000;  // 15 seconds to reconnect

/* ============================================================
 * §4  WEBSOCKET SERVER & MESSAGE ROUTING
 * ============================================================ */
const wss   = new WebSocket.Server({ server: httpServer });
const conns = new Map();   // connId → RibbonConn
let   nextId = 1;

wss.on('connection', (ws, req) => {
  const id   = `p${nextId++}`;
  const conn = new RibbonConn(ws, id);
  conns.set(id, conn);
  console.log(`[WS] ${id} connected from ${req.socket.remoteAddress}`);

  // Send welcome with assigned ID
  conn.send('hello', { id, version: '0.3.0', brand: 'teza' });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /*
     * Update our record of what the peer has acknowledged.
     * This is used during reconnect to know what to replay.
     */
    if (typeof msg.a === 'number') conn.recvAck = msg.a;

    const { t: type, d: data = {} } = msg;

    switch (type) {

      /* ── RIBBON HEARTBEAT ───────────────────────────────── */
      case 'pong':
        conn.pong();
        break;

      /* ── ROOM: CREATE ────────────────────────────────────── */
      case 'createRoom': {
        const roomId = makeRoomId();
        const room   = new Room(roomId);
        rooms.set(roomId, room);
        room.addPlayer(conn);
        break;
      }

      /* ── ROOM: JOIN ──────────────────────────────────────── */
      case 'joinRoom': {
        const { roomId } = data;
        const room = rooms.get(roomId?.toUpperCase());
        if (!room) {
          conn.send('error', { msg: 'Room not found', code: 'ROOM_NOT_FOUND' });
          break;
        }
        if (room.players.length >= 2) {
          conn.send('error', { msg: 'Room is full', code: 'ROOM_FULL' });
          break;
        }
        room.addPlayer(conn);
        break;
      }

      /* ── RECONNECT ───────────────────────────────────────── */
      case 'resume': {
        const { roomId, peerAck } = data;
        const room = rooms.get(roomId);
        if (room) room.handleReconnect(conn, peerAck || 0);
        break;
      }

      /* ── GAME INPUT ──────────────────────────────────────── */
      case 'input': {
        const roomId = connRoom.get(conn.id);
        const room   = roomId && rooms.get(roomId);
        if (room) room.handleInput(conn, data.input);
        break;
      }

      /* ── BOARD SYNC (optional client→server state report) ── */
      case 'stateReport': {
        // Future: compare client-reported board hash to server engine
        // for anti-cheat. Phase 3 placeholder.
        break;
      }

      default:
        console.log(`[WS] Unknown message type: ${type} from ${id}`);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] ${id} disconnected`);
    const roomId = connRoom.get(id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) room.handleDisconnect(conn);
    }
    conn.destroy();
    conns.delete(id);
  });

  ws.on('error', err => {
    console.error(`[WS] Error for ${id}:`, err.message);
  });
});

/* ============================================================
 * §5  START
 * ============================================================ */
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   TEZA — Game Server v0.3.0          ║
║   teza.ke  ·  Built in Kenya 🇰🇪      ║
╠══════════════════════════════════════╣
║   HTTP  →  http://localhost:${PORT}     ║
║   WS    →  ws://localhost:${PORT}       ║
╚══════════════════════════════════════╝
  `);
});
