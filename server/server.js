/**
 * ============================================================
 * TEZA — server/server.js  (Phase 4)
 * ============================================================
 * Extends Phase 3 with:
 *   §1  HTTP server (static files + REST API)
 *   §2  RibbonConn (unchanged from Phase 3)
 *   §3  Glicko-2 Rating System + Tetra Rating (TR)
 *   §4  Player Profile Store (flat JSON, no DB required)
 *   §5  Matchmaking Queue (TR-range based, expanding)
 *   §6  Room System (spectators, replay recording, ranked)
 *   §7  Replay Store (.teza format)
 *   §8  WebSocket message router (extended)
 *   §9  Startup
 *
 * STORAGE (no database):
 *   data/players.json  — all player profiles + ratings
 *   data/replays/      — one .teza file per completed match
 * ============================================================
 */

'use strict';

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const initSqlJs = require('sql.js');
const bcrypt    = require('bcryptjs');
const { createEngine, stepEngine, tickEngine, hashEngine } = require('../shared/engine');

const PORT         = process.env.PORT || 3000;
const DATA_DIR     = path.join(__dirname, '../data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const REPLAYS_DIR  = path.join(DATA_DIR, 'replays');

fs.mkdirSync(DATA_DIR,    { recursive: true });
fs.mkdirSync(REPLAYS_DIR, { recursive: true });

/* ============================================================
 * §1  HTTP SERVER + REST API
 * ============================================================ */
const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);

  let filePath = req.url === '/' ? '/index.html' : req.url;
  const ext    = path.extname(filePath);
  const mime   = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
  };

  for (const base of [path.join(__dirname,'../client'), path.join(__dirname,'..')]) {
    const p = path.join(base, filePath);
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      fs.createReadStream(p).pipe(res);
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
});

function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url;

  // GET /api/profile/:username
  const pm = url.match(/^\/api\/profile\/(.+)$/);
  if (pm && req.method === 'GET') {
    const p = getPlayer(pm[1]);
    if (p) res.end(JSON.stringify(sanitizeProfile(p)));
    else { res.writeHead(404); res.end(JSON.stringify({ error:'Not found' })); }
    return;
  }

  // GET /api/leaderboard
  if (url === '/api/leaderboard' && req.method === 'GET') {
    stmtLeaderboard.bind({ $rd: RD_HIDDEN });
    const rows = [];
    while(stmtLeaderboard.step()) rows.push(stmtLeaderboard.getAsObject());
    stmtLeaderboard.reset();
    
    const board = rows.map(_dbRowToProfile).map(sanitizeProfile);
    res.end(JSON.stringify(board));
    return;
  }

  // GET /api/replay/:id
  const rm = url.match(/^\/api\/replay\/(.+)$/);
  if (rm && req.method === 'GET') {
    const f = path.join(REPLAYS_DIR, rm[1] + '.teza');
    if (fs.existsSync(f)) res.end(fs.readFileSync(f));
    else { res.writeHead(404); res.end(JSON.stringify({ error:'Not found' })); }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error:'Unknown route' }));
}

/* ============================================================
 * §2  RIBBON CONNECTION (unchanged)
 * ============================================================ */
const MAX_BUF       = 100;
const PING_INTERVAL = 5000;
const PING_TIMEOUT  = 10000;

class RibbonConn {
  constructor(ws, id) {
    this.ws       = ws;
    this.id       = id;
    this.sendSeq  = 0;
    this.recvAck  = 0;
    this.sendBuf  = [];
    this.alive    = true;
    this.roomId   = null;
    this.username = null;
    this._startHeartbeat();
  }
  send(type, data = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const packet = { t:type, s:this.sendSeq++, a:this.recvAck, d:data };
    const raw    = JSON.stringify(packet);
    this.sendBuf.push({ s:packet.s, raw });
    if (this.sendBuf.length > MAX_BUF) this.sendBuf.shift();
    this.ws.send(raw);
  }
  replayFrom(peerAck) {
    for (const b of this.sendBuf.filter(b => b.s > peerAck))
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b.raw);
  }
  _startHeartbeat() {
    this._pingTimer = setInterval(() => {
      if (!this.alive) { this.ws.terminate(); return; }
      this.alive = false;
      this.send('ping');
      this._pongTimeout = setTimeout(() => { if (!this.alive) this.ws.terminate(); }, PING_TIMEOUT);
    }, PING_INTERVAL);
  }
  pong() { this.alive = true; clearTimeout(this._pongTimeout); }
  destroy() { clearInterval(this._pingTimer); clearTimeout(this._pongTimeout); }
}

/* ============================================================
 * §3  GLICKO-2 RATING SYSTEM
 * ============================================================
 *
 * Based on Mark Glickman's 2012 paper (glicko.net/glicko/glicko2.pdf)
 *
 * INTERNAL SCALE:
 *   μ   = (r  - 1500) / 173.7178   (rating on Glicko-2 scale)
 *   φ   = RD / 173.7178             (deviation on Glicko-2 scale)
 *   σ   = volatility                (unchanged scale)
 *
 * SYSTEM CONSTANT τ = 0.6:
 *   Constrains how much volatility can change per period.
 *   Range 0.3–1.2; TETR.IO documented as 0.5–0.7; we use 0.6.
 *
 * RD BOUNDS:
 *   Initial: 350 (high uncertainty for new players)
 *   Floor:    30  (can never be perfectly certain)
 *   Hidden:  100  (TR not shown publicly above this RD)
 *
 * TETRA RATING (TR) FORMULA (community-documented TETR.IO formula):
 *   TR = 25000 × σ((r-1500)π / (173.7178·√(3ln²(10)·RD²+π²)))
 *   where σ(x) = 1/(1+10^(-x/400)) — maps rating to 0–25000 range.
 * ============================================================ */
const GLICKO_TAU   = 0.6;
const GLICKO_SCALE = 173.7178;
const R_INITIAL    = 1500;
const RD_INITIAL   = 350;
const RD_MIN       = 30;
const RD_HIDDEN    = 100;
const VOL_INITIAL  = 0.06;
const EPSILON      = 0.000001;

function g(phi)       { return 1/Math.sqrt(1+3*phi*phi/(Math.PI*Math.PI)); }
function E(mu,muj,pj) { return 1/(1+Math.exp(-g(pj)*(mu-muj))); }

/**
 * Full Glicko-2 update for a single match result.
 * score: 1=win, 0=loss, 0.5=draw
 */
function updateGlicko2(player, opp, score) {
  const mu  = (player.r  - R_INITIAL) / GLICKO_SCALE;
  const phi = player.rd  / GLICKO_SCALE;
  const muj = (opp.r     - R_INITIAL) / GLICKO_SCALE;
  const pj  = opp.rd     / GLICKO_SCALE;

  const gj  = g(pj);
  const ej  = E(mu, muj, pj);

  // Step 3: estimated variance
  const v = 1 / (gj*gj*ej*(1-ej));

  // Step 4: estimated improvement
  const delta = v * gj * (score - ej);

  // Step 5: new volatility via Illinois algorithm
  let A  = Math.log(player.vol * player.vol);
  let B  = delta*delta > phi*phi+v
    ? Math.log(delta*delta - phi*phi - v)
    : (()=>{ let k=1; while (f(A-k*GLICKO_TAU)<0) k++; return A-k*GLICKO_TAU; })();

  function f(x) {
    const ex = Math.exp(x);
    const d2 = phi*phi+v+ex;
    return ex*(delta*delta-phi*phi-v-ex)/(2*d2*d2) - (x-A)/(GLICKO_TAU*GLICKO_TAU);
  }

  let fA = f(A), fB = f(B);
  for (let i=0; i<100 && Math.abs(B-A)>EPSILON; i++) {
    const C=A+(A-B)*fA/(fB-fA), fC=f(C);
    if (fC*fB<=0){A=B;fA=fB;}else fA/=2;
    B=C; fB=fC;
  }
  const newVol  = Math.exp(A/2);

  // Step 6-7: update φ and μ
  const phiStar = Math.sqrt(phi*phi + newVol*newVol);
  const newPhi  = 1/Math.sqrt(1/(phiStar*phiStar)+1/v);
  const newMu   = mu + newPhi*newPhi*gj*(score-ej);

  return {
    r:   newMu*GLICKO_SCALE + R_INITIAL,
    rd:  Math.max(RD_MIN, newPhi*GLICKO_SCALE),
    vol: newVol,
  };
}

/**
 * Tetra Rating display formula (community-documented TETR.IO formula).
 * Maps Glicko-2 r/RD into a 0–25000 display score.
 * Players with RD > 100 have TR hidden (shown as null publicly).
 */
function calcTR(r, rd) {
  const ln10   = Math.log(10);
  const denom  = GLICKO_SCALE * Math.sqrt(3*ln10*ln10*rd*rd + Math.PI*Math.PI);
  return 25000 / (1 + Math.pow(10, (R_INITIAL-r)*Math.PI/denom));
}

/* ============================================================
 * §4  PLAYER PROFILE STORE
 * ============================================================
 * SQLite database store using sql.js (in-memory, saved to disk)
 * ============================================================ */
const DB_FILE = path.join(DATA_DIR, 'teza.db');
let db;

function initDatabase(SQL) {
  if (fs.existsSync(DB_FILE)) {
    const filebuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      username TEXT PRIMARY KEY,
      password_hash TEXT,
      created_at TEXT,
      r REAL,
      rd REAL,
      vol REAL,
      tr REAL,
      games_played INTEGER,
      wins INTEGER,
      losses INTEGER,
      total_attack INTEGER,
      total_lines INTEGER,
      best_apm REAL,
      best_pps REAL,
      replay_ids TEXT
    )
  `);
}

function _saveDbToDisk() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  } catch (e) {
    console.error('[Store] Save failed:', e.message);
  }
}

function _dbRowToProfile(row) {
  if (!row) return null;
  return {
    username: row.username,
    password_hash: row.password_hash || null,
    createdAt: row.created_at,
    r:           row.r    ?? R_INITIAL,
    rd:          row.rd   ?? RD_INITIAL,
    vol:         row.vol  ?? VOL_INITIAL,
    tr:          row.tr   ?? calcTR(R_INITIAL, RD_INITIAL),
    gamesPlayed: row.games_played  ?? 0,
    wins:        row.wins          ?? 0,
    losses:      row.losses        ?? 0,
    totalAttack: row.total_attack  ?? 0,
    totalLines:  row.total_lines   ?? 0,
    bestAPM:     row.best_apm      ?? 0,
    bestPPS:     row.best_pps      ?? 0,
    replayIds:   JSON.parse(row.replay_ids || '[]')
  };
}

function getPlayer(username) {
  const stmt = db.prepare('SELECT * FROM players WHERE username = $username');
  const row = stmt.getAsObject({ $username: username.toLowerCase() });
  stmt.free();
  if (!row || Object.keys(row).length === 0) return null;
  return _dbRowToProfile(row);
}

function createPlayer(username, password_hash) {
  const key = username.toLowerCase();
  const now = new Date().toISOString();
  const tr = calcTR(R_INITIAL, RD_INITIAL);
  db.run(`
    INSERT INTO players (
      username, password_hash, created_at,
      r, rd, vol, tr,
      games_played, wins, losses,
      total_attack, total_lines, best_apm, best_pps,
      replay_ids
    ) VALUES (
      $username, $password_hash, $created_at,
      $r, $rd, $vol, $tr,
      $games_played, $wins, $losses,
      $total_attack, $total_lines, $best_apm, $best_pps,
      $replay_ids
    )
  `, {
    $username: key,
    $password_hash: password_hash,
    $created_at: now,
    $r: R_INITIAL,
    $rd: RD_INITIAL,
    $vol: VOL_INITIAL,
    $tr: tr,
    $games_played: 0,
    $wins: 0,
    $losses: 0,
    $total_attack: 0,
    $total_lines: 0,
    $best_apm: 0,
    $best_pps: 0,
    $replay_ids: '[]'
  });
  _saveDbToDisk();
  return getPlayer(key);
}

function savePlayer(p) {
  db.run(`
    UPDATE players SET
      r = $r, rd = $rd, vol = $vol, tr = $tr,
      games_played = $games_played, wins = $wins, losses = $losses,
      total_attack = $total_attack, total_lines = $total_lines, best_apm = $best_apm, best_pps = $best_pps,
      replay_ids = $replay_ids
    WHERE username = $username
  `, {
    $r: p.r,
    $rd: p.rd,
    $vol: p.vol,
    $tr: p.tr,
    $games_played: p.gamesPlayed,
    $wins: p.wins,
    $losses: p.losses,
    $total_attack: p.totalAttack,
    $total_lines: p.totalLines,
    $best_apm: p.bestAPM,
    $best_pps: p.bestPPS,
    $replay_ids: JSON.stringify(p.replayIds),
    $username: p.username.toLowerCase()
  });
  _saveDbToDisk();
}

function recordResult(winnerName, loserName, wStats, lStats, replayId) {
  const W = getPlayer(winnerName);
  const L = getPlayer(loserName);
  if (!W || !L) return null;

  const wPre = { r:W.r, rd:W.rd };
  const lPre = { r:L.r, rd:L.rd };

  const wNew = updateGlicko2({r:W.r,rd:W.rd,vol:W.vol}, lPre, 1.0);
  Object.assign(W, wNew);
  W.tr = calcTR(W.r, W.rd);
  W.gamesPlayed++; W.wins++;
  W.totalAttack += wStats.attack||0; W.totalLines += wStats.lines||0;
  W.bestAPM = Math.max(W.bestAPM, wStats.apm||0);
  W.bestPPS = Math.max(W.bestPPS, wStats.pps||0);
  if (replayId) { W.replayIds.unshift(replayId); W.replayIds = W.replayIds.slice(0,20); }

  const lNew = updateGlicko2({r:L.r,rd:L.rd,vol:L.vol}, wPre, 0.0);
  Object.assign(L, lNew);
  L.tr = calcTR(L.r, L.rd);
  L.gamesPlayed++; L.losses++;
  L.totalAttack += lStats.attack||0; L.totalLines += lStats.lines||0;
  L.bestAPM = Math.max(L.bestAPM, lStats.apm||0);
  L.bestPPS = Math.max(L.bestPPS, lStats.pps||0);
  if (replayId) { L.replayIds.unshift(replayId); L.replayIds = L.replayIds.slice(0,20); }

  savePlayer(W);
  savePlayer(L);
  console.log(`[Rating] ${winnerName} TR: ${Math.round(wPre.r)} → ${Math.round(W.tr)}`);
  console.log(`[Rating] ${loserName}  TR: ${Math.round(lPre.r)} → ${Math.round(L.tr)}`);
  return { wOld: wPre, lOld: lPre, wNew: W, lNew: L };
}

function sanitizeProfile(p) {
  const gp  = p.gamesPlayed ?? 0;
  const w   = p.wins        ?? 0;
  const l   = p.losses      ?? 0;
  return {
    username:    p.username,
    tr:          (p.rd ?? RD_INITIAL) <= RD_HIDDEN ? Math.round(p.tr ?? 0) : null,
    rd:          Math.round(p.rd ?? RD_INITIAL),
    gamesPlayed: gp,
    wins:        w,
    losses:      l,
    winRate:     gp > 0 ? Math.round(w / gp * 100) : 0,
    bestAPM:     Math.round(p.bestAPM ?? 0),
    bestPPS:     (p.bestPPS ?? 0).toFixed(2),
    createdAt:   p.createdAt,
    replayIds:   p.replayIds || [],
  };
}



/* ============================================================
 * §5  MATCHMAKING QUEUE
 * ============================================================
 *
 * Algorithm:
 *   - Players enter queue with their current TR (or 1500 default)
 *   - Every RANGE_EXPAND_MS seconds, accepted TR difference widens
 *   - When two players' ranges overlap, they are paired
 *
 * RANGE LOGIC:
 *   Initial acceptable difference: ±500 TR
 *   Expands by +500 every 10s until a match is found.
 *   After 60s with no match: accept any opponent.
 * ============================================================ */
const INITIAL_RANGE    = 500;
const RANGE_EXPAND     = 500;
const RANGE_EXPAND_MS  = 10000;

const queue = [];   // [{ conn, tr, range, timer }]

function joinQueue(conn) {
  leaveQueue(conn);
  const profile = conn.username ? getPlayer(conn.username) : null;
  const tr      = profile?.tr ?? R_INITIAL;
  const entry   = { conn, tr, range: INITIAL_RANGE };
  entry.timer   = setInterval(() => { entry.range += RANGE_EXPAND; tryMatch(); }, RANGE_EXPAND_MS);
  queue.push(entry);
  conn.send('queueJoined', { position: queue.length, tr: Math.round(tr) });
  console.log(`[Queue] ${conn.id} joined (TR≈${Math.round(tr)}, size=${queue.length})`);
  tryMatch();
}
function leaveQueue(conn) {
  const i = queue.findIndex(e => e.conn === conn);
  if (i === -1) return;
  clearInterval(queue[i].timer);
  queue.splice(i, 1);
}
function tryMatch() {
  for (let i=0; i<queue.length; i++) {
    for (let j=i+1; j<queue.length; j++) {
      const a=queue[i], b=queue[j];
      if (Math.abs(a.tr-b.tr) <= Math.max(a.range,b.range)) {
        clearInterval(a.timer); clearInterval(b.timer);
        queue.splice(j,1); queue.splice(i,1);
        console.log(`[Queue] Matched ${a.conn.id} vs ${b.conn.id}`);
        const roomId = makeRoomId();
        const room   = new Room(roomId, true);
        rooms.set(roomId, room);
        room.addPlayer(a.conn);
        room.addPlayer(b.conn);
        return;
      }
    }
  }
}

/* ============================================================
 * §6  ROOM (extended: spectators, replay recording, rated)
 * ============================================================ */
const rooms    = new Map();
const connRoom = new Map();
const RECONNECT_GRACE   = 15000;
const SNAPSHOT_MS       = 250;   // spectator board update rate

function makeRoomId() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

class Room {
  constructor(id, ranked=false) {
    this.id         = id;
    this.ranked     = ranked;
    this.players    = [];
    this.spectators = [];
    this.engines    = [];
    this.state      = 'waiting';
    this.seed       = Math.floor(Math.random()*2147483646)+1;
    this.tickInt    = null;
    this.snapInt    = null;
    this.ready      = [false,false];
    this.deadFlags  = [false,false];
    this.matchStats = [];
    /*
     * REPLAY RECORDER
     * Records { seed, inputs[], events[], meta } — enough to
     * deterministically reconstruct any match from scratch.
     * Saved as a .teza JSON file when the match ends.
     */
    this.replay = { version:'0.4.0', seed:this.seed, inputs:[], events:[], meta:{}, tick:0 };
  }

  addPlayer(conn) {
    const idx = this.players.length;
    this.players.push(conn);
    conn.roomId = this.id;
    connRoom.set(conn.id, this.id);
    conn.send('roomJoined',{
      roomId:this.id, playerIndex:idx,
      playerCount:this.players.length, ranked:this.ranked,
    });
    if (this.players.length===2) this._startMatch();
  }

  addSpectator(conn) {
    this.spectators.push(conn);
    conn.roomId = this.id;
    connRoom.set(conn.id, this.id);
    conn.send('spectatorJoined',{
      roomId:this.id, state:this.state,
      players: this.players.map(p=>p.username||p.id),
    });
    if (this.engines.length) this._sendSnap(conn);
  }

  _startMatch() {
    this.state     = 'playing';
    this.ready     = [false,false];
    this.deadFlags = [false,false];
    this.tickInt   = null;
    this.engines   = [createEngine(this.seed), createEngine(this.seed)];
    this.matchStats = [
      {attack:0,lines:0,apm:0,pps:0,pieces:0,t0:Date.now()},
      {attack:0,lines:0,apm:0,pps:0,pieces:0,t0:Date.now()},
    ];
    this.replay.seed        = this.seed;
    this.replay.meta        = {
      startedAt: new Date().toISOString(),
      players:   this.players.map(p=>p.username||p.id),
      ranked:    this.ranked,
    };
    console.log(`[Room ${this.id}] Match start (${this.ranked?'RANKED':'casual'}), seed=${this.seed}`);
    for (let i=0;i<2;i++) {
      const opp = this.players[1-i];
      this.players[i].send('matchStart',{
        seed:        this.seed,
        playerIndex: i,
        opponent:    opp.username||opp.id,
        ranked:      this.ranked,
        opponentProfile: opp.username ? sanitizeProfile(getPlayer(opp.username)) : null,
      });
    }
    this._broadcastSpecs('spectatorMatchStart',{ players:this.replay.meta.players });
    this._readyTimeout = setTimeout(()=>{ if(!this.tickInt) this._startTick(); }, 5000);
  }

  playerReady(conn) {
    const idx = this.players.indexOf(conn);
    if (idx===-1) return;
    this.ready[idx]=true;
    if (this.ready[0]&&this.ready[1]) { clearTimeout(this._readyTimeout); this._startTick(); }
  }

  _startTick() {
    if (this.tickInt) return;
    this.tickInt = setInterval(()=>this._tick(), 1000/60);
    this.snapInt = setInterval(()=>{ if(this.spectators.length) this._broadcastSnap(); }, SNAPSHOT_MS);
    this._broadcast('matchLive',{});
    console.log(`[Room ${this.id}] Live`);
  }

  _tick() {
    if (this.state!=='playing') return;
    this.replay.tick++;
    for (let i=0;i<2;i++) {
      if (this.deadFlags[i]) continue;
      const evs = tickEngine(this.engines[i]);
      if (evs.length) {
        evs.forEach(e=>this.replay.events.push({tick:this.replay.tick,pi:i,e}));
        this._handleEvents(i,evs);
      }
    }

    if (this.replay.tick % 60 === 0) {
      for (let i=0;i<2;i++) {
        if (!this.deadFlags[i]) {
          this.players[i].send('syncHash', {
            tick: this.replay.tick,
            hash: hashEngine(this.engines[i])
          });
        }
      }
    }
  }

  handleInput(conn, input) {
    const idx = this.players.indexOf(conn);
    if (idx===-1||this.state!=='playing'||this.deadFlags[idx]) return;
    this.replay.inputs.push({tick:this.replay.tick, pi:idx, input});
    const evs = stepEngine(this.engines[idx], input);
    // Update live stats
    const eng=this.engines[idx], st=this.matchStats[idx];
    st.attack=eng.attack; st.lines=eng.lines;
    const sec=(Date.now()-st.t0)/1000;
    st.apm=sec>0?(eng.attack/sec)*60:0;
    st.pps=sec>0?eng.lines/sec*0.5:0;
    this._handleEvents(idx,evs);
  }

  _handleEvents(pi, evs) {
    const sender = this.players[pi];
    const opp    = this.players[1-pi];
    for (const ev of evs) {
      if (ev.type==='attack') {
        if (opp) {
          stepEngine(this.engines[1-pi],{type:'receiveGarbage',value:ev.lines});
          opp.send('incomingGarbage',{lines:ev.lines,from:sender.id,spin:ev.spin,b2b:ev.b2b});
        }
        sender.send('attackSent',{lines:ev.lines,spin:ev.spin,b2b:ev.b2b,allClear:ev.allClear});
        this._broadcastSpecs('specAttack',{pi,lines:ev.lines,spin:ev.spin});
      } else if (ev.type==='gameOver') {
        if (!this.deadFlags[pi]) { this.deadFlags[pi]=true; this._endMatch(1-pi); }
      } else if (ev.type==='allClear') {
        this._broadcast('allClear',{player:pi});
      }
    }
  }

  _endMatch(winnerIdx) {
    if (this.state!=='playing') return;
    this.state='finished';
    clearInterval(this.tickInt); clearInterval(this.snapInt);
    clearTimeout(this._readyTimeout);
    this.tickInt=null;

    // Finalize stats
    for (let i=0;i<2;i++) {
      const st=this.matchStats[i], sec=(Date.now()-st.t0)/1000;
      st.apm=sec>0?(this.engines[i].attack/sec)*60:0;
      st.pps=sec>0?this.engines[i].lines/sec*0.4:0;
    }

    // Save replay
    this.replay.meta.duration = Date.now()-new Date(this.replay.meta.startedAt).getTime();
    this.replay.meta.result   = { winnerIdx, players:this.replay.meta.players };
    const replayId = this._saveReplay();

    // Update ratings if ranked + both logged in
    let ratingData = null;
    if (this.ranked) {
      const wConn=this.players[winnerIdx], lConn=this.players[1-winnerIdx];
      if (wConn.username && lConn.username) {
        ratingData = recordResult(
          wConn.username, lConn.username,
          this.matchStats[winnerIdx], this.matchStats[1-winnerIdx],
          replayId
        );
      }
    }

    console.log(`[Room ${this.id}] Winner: P${winnerIdx} | Replay: ${replayId}`);

    for (let i=0;i<2;i++) {
      const won   = i===winnerIdx;
      const trOld = ratingData && this.players[i].username
        ? Math.round(won ? ratingData.wOld.r : ratingData.lOld.r)
        : null;
      const trNew = ratingData && this.players[i].username
        ? Math.round(won ? ratingData.wNew.tr : ratingData.lNew.tr)
        : null;
      this.players[i].send('matchOver',{
        won, winnerIdx, replayId,
        myStats:  this.matchStats[i],
        oppStats: this.matchStats[1-i],
        trOld, trNew,
        trDelta: (trNew!=null&&trOld!=null) ? trNew-trOld : null,
      });
    }
    this._broadcastSpecs('specMatchOver',{ winnerIdx, replayId });
  }

  _saveReplay() {
    const id  = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    try {
      fs.writeFileSync(path.join(REPLAYS_DIR,`${id}.teza`), JSON.stringify(this.replay));
      console.log(`[Replay] Saved ${id}.teza (${this.replay.inputs.length} inputs)`);
    } catch(e) { console.error('[Replay] Save failed:',e.message); }
    return id;
  }

  _sendSnap(conn) {
    if (!this.engines.length) return;
    conn.send('boardSnapshot',{
      boards:  this.engines.map(e=>e.board),
      held:    this.engines.map(e=>e.held),
      active:  this.engines.map(e=>e.active),
      stats:   this.engines.map((e,i)=>({
        attack:e.attack, lines:e.lines, b2b:e.b2b,
        garbageQueue:e.garbageQueue,
      })),
      players: this.players.map(p=>p.username||p.id),
    });
  }
  _broadcastSnap() { for(const s of this.spectators) this._sendSnap(s); }
  _broadcast(t,d) { for(const p of this.players) p.send(t,d); }
  _broadcastSpecs(t,d) { for(const s of this.spectators) s.send(t,d); }

  handleDisconnect(conn) {
    const idx=this.players.indexOf(conn);
    if (idx!==-1) {
      this.players[1-idx]?.send('opponentDisconnected',{grace:RECONNECT_GRACE});
      conn._dcTimer=setTimeout(()=>{ if(this.state==='playing') this._endMatch(1-idx); },RECONNECT_GRACE);
    }
    const si=this.spectators.indexOf(conn);
    if (si!==-1) this.spectators.splice(si,1);
  }
  handleReconnect(conn,peerAck) {
    const idx=this.players.indexOf(conn);
    if (idx===-1) return;
    clearTimeout(conn._dcTimer);
    conn.replayFrom(peerAck);
    this.players[1-idx]?.send('opponentReconnected',{});
  }
  cleanup() {
    clearInterval(this.tickInt); clearInterval(this.snapInt);
    clearTimeout(this._readyTimeout);
  }
}

/* ============================================================
 * §7  REPLAY STORE — see _saveReplay() inside Room
 *
 * .teza file format:
 * {
 *   version:  "0.4.0",
 *   seed:     number,
 *   inputs:   [{ tick, pi, input }],
 *   events:   [{ tick, pi, e }],
 *   meta:     { startedAt, duration, players, ranked, result }
 * }
 *
 * Replay: createEngine(seed), advance tickEngine() per tick,
 * feed inputs at their recorded tick boundaries.
 * ============================================================ */

/* ============================================================
 * §8  WEBSOCKET SERVER + MESSAGE ROUTER
 * ============================================================ */
const wss   = new WebSocket.Server({ server:httpServer });
const conns = new Map();
let nextId  = 1;

wss.on('connection',(ws,req)=>{
  const id   = `p${nextId++}`;
  const conn = new RibbonConn(ws,id);
  conns.set(id,conn);
  conn.send('hello',{id,version:'0.4.0',brand:'teza'});
  console.log(`[WS] ${id} connected`);

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    if(typeof msg.a==='number') conn.recvAck=msg.a;
    const{t:type,d:data={}}=msg;

    switch(type){
      case 'pong': conn.pong(); break;

      /* ── AUTH ─────────────────────────────────────────────── */
      case 'login':{
        const u=(data.username||'').trim().slice(0,20);
        const pw=(data.password||'').trim();
        if(!u||!/^[a-zA-Z0-9_\-]+$/.test(u)){
          conn.send('loginError',{msg:'Invalid username. Letters, numbers, _ or - only.'}); break;
        }
        if(pw.length < 4){
          conn.send('loginError',{msg:'Password must be at least 4 characters.'}); break;
        }
        
        let profile = getPlayer(u);
        if (profile) {
          if (!profile.password_hash) {
            // Legacy account (pre-auth) — set password on first login
            const hash = bcrypt.hashSync(pw, 10);
            db.run('UPDATE players SET password_hash = $hash WHERE username = $username', {
              $hash: hash, $username: u.toLowerCase()
            });
            _saveDbToDisk();
            profile.password_hash = hash;
          } else if (!bcrypt.compareSync(pw, profile.password_hash)) {
            conn.send('loginError',{msg:'Incorrect password.'}); break;
          }
        } else {
          const hash = bcrypt.hashSync(pw, 10);
          profile = createPlayer(u, hash);
        }

        conn.username=u;
        conn.send('loginOk',{username:u,profile:sanitizeProfile(profile)});
        break;
      }

      /* ── ROOM ─────────────────────────────────────────────── */
      case 'createRoom':{
        const roomId=makeRoomId();
        const room=new Room(roomId,false);
        rooms.set(roomId,room);
        room.addPlayer(conn);
        break;
      }
      case 'joinRoom':{
        const room=rooms.get((data.roomId||'').toUpperCase());
        if(!room){conn.send('error',{msg:'Room not found',code:'NO_ROOM'});break;}
        if(room.state!=='waiting'||room.players.length>=2) room.addSpectator(conn);
        else room.addPlayer(conn);
        break;
      }
      case 'spectate':{
        const room=rooms.get((data.roomId||'').toUpperCase());
        if(!room){conn.send('error',{msg:'Room not found',code:'NO_ROOM'});break;}
        room.addSpectator(conn);
        break;
      }

      /* ── MATCHMAKING ──────────────────────────────────────── */
      case 'joinQueue':{
        if(!conn.username){conn.send('error',{msg:'Login required for ranked play',code:'NO_LOGIN'});break;}
        joinQueue(conn);
        break;
      }
      case 'leaveQueue':{ leaveQueue(conn); conn.send('queueLeft',{}); break; }

      /* ── RECONNECT ────────────────────────────────────────── */
      case 'resume':{
        const room=rooms.get(data.roomId);
        if(room) room.handleReconnect(conn,data.peerAck||0);
        break;
      }

      /* ── GAME ─────────────────────────────────────────────── */
      case 'clientReady':{
        const room=rooms.get(connRoom.get(conn.id));
        if(room) room.playerReady(conn);
        break;
      }
      case 'input':{
        const room=rooms.get(connRoom.get(conn.id));
        if(room) room.handleInput(conn,data.input);
        break;
      }
      case 'requestSync':{
        const room=rooms.get(connRoom.get(conn.id));
        if (room && room.state==='playing') {
          const idx = room.players.indexOf(conn);
          if (idx !== -1) {
            const eng = room.engines[idx];
            conn.send('fullSync', {
              tick: room.replay.tick,
              state: {
                board: eng.board,
                active: eng.active,
                held: eng.held,
                canHold: eng.canHold,
                score: eng.score,
                lines: eng.lines,
                level: eng.level,
                combo: eng.combo,
                b2b: eng.b2b,
                attack: eng.attack,
                garbageQueue: eng.garbageQueue,
                sickness: eng.sickness
              }
            });
          }
        }
        break;
      }

      /* ── PROFILES / LEADERBOARD ───────────────────────────── */
      case 'getProfile':{
        const u=data.username||conn.username;
        const p=u?getPlayer(u):null;
        if(p) conn.send('profileData',{profile:sanitizeProfile(p)});
        else conn.send('error',{msg:'Profile not found',code:'NO_PROFILE'});
        break;
      }
      case 'getLeaderboard':{
        const stmt = db.prepare(`
          SELECT * FROM players
          WHERE games_played >= 10 AND rd <= $rd
          ORDER BY tr DESC
          LIMIT 50
        `);
        stmt.bind({ $rd: RD_HIDDEN });
        const rows = [];
        while(stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        
        const board = rows.map(_dbRowToProfile).map(sanitizeProfile);
        conn.send('leaderboard',{entries:board});
        break;
      }

      default: break;
    }
  });

  ws.on('close',()=>{
    leaveQueue(conn);
    const room=rooms.get(connRoom.get(id));
    if(room) room.handleDisconnect(conn);
    conn.destroy(); conns.delete(id); connRoom.delete(id);
    console.log(`[WS] ${id} disconnected`);
  });
  ws.on('error',e=>console.error(`[WS] Error ${id}:`,e.message));
});

/* ============================================================
 * §9  START
 * ============================================================ */
initSqlJs().then(SQL => {
  initDatabase(SQL);
  
  httpServer.listen(PORT,()=>{
    console.log(`
  ╔══════════════════════════════════════════╗
  ║  TEZA — Game Server v0.4.0               ║
  ║  teza.ke  ·  Built in Kenya 🇰🇪           ║
  ╠══════════════════════════════════════════╣
  ║  HTTP  →  http://localhost:${PORT}           ║
  ║  WS    →  ws://localhost:${PORT}             ║
  ║                                          ║
  ║  Phase 4:  Ratings · Profiles            ║
  ║  Matchmaking · Spectator · Replays       ║
  ╚══════════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error("Failed to initialize sql.js:", err);
  process.exit(1);
});
