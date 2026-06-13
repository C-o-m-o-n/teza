/**
 * ============================================================
 * TEZA — shared/engine.js
 * ============================================================
 * Pure game engine: no DOM, no WebSocket, no side effects.
 * Runs identically on the SERVER (for validation/anti-cheat)
 * and in the BROWSER (for local prediction + rendering).
 *
 * DETERMINISM GUARANTEE:
 *   Given the same seed and the same input stream, this engine
 *   will always produce the same board state. This is what
 *   makes replays, spectating, and anti-cheat possible.
 *
 * ARCHITECTURE:
 *   - createEngine(seed)         → fresh engine state object
 *   - stepEngine(state, input)   → apply one input, return events
 *   - tickEngine(state)          → advance one physics tick (gravity/lock)
 *
 * BROWSER/NODE DUAL EXPORT:
 *   The entire module is wrapped in an IIFE so that `const`,
 *   `class`, and `function` declarations do NOT leak into the
 *   browser's global scope. This prevents "redeclaration of
 *   const PIECE_NAMES" errors when the client HTML also uses
 *   destructuring. Only `window.TezaEngine` is exported globally.
 *
 *   In Node.js, `module.exports` is set instead.
 * ============================================================
 */

(function (root, factory) {
  /* Universal Module Definition (UMD) pattern:
   * Works as CommonJS (Node.js require) AND as a browser
   * <script> tag without any bundler. */
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser global — attach to window as TezaEngine
    root.TezaEngine = factory();
  }
}(typeof window !== 'undefined' ? window : global, function () {
'use strict';

/* ============================================================
 * §1  MINSTD PRNG
 * X(n+1) = (16807 * X(n)) mod 2147483647
 * ============================================================ */
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
  clone()    { const m = new MINSTD(1); m.state = this.state; return m; }
}

/* ============================================================
 * §2  PIECE DEFINITIONS
 * ============================================================ */
const PIECES = {
  I: { color:'#41b0d8', states:[
    [[-1,0],[-1,1],[-1,2],[-1,3]],
    [[-2,2],[-1,2],[0,2],[1,2]],
    [[0,0],[0,1],[0,2],[0,3]],
    [[-2,1],[-1,1],[0,1],[1,1]],
  ]},
  O: { color:'#f7d000', states:[
    [[-1,1],[-1,2],[0,1],[0,2]],[[-1,1],[-1,2],[0,1],[0,2]],
    [[-1,1],[-1,2],[0,1],[0,2]],[[-1,1],[-1,2],[0,1],[0,2]],
  ]},
  T: { color:'#b642d4', states:[
    [[-1,1],[0,0],[0,1],[0,2]],
    [[-1,1],[0,1],[0,2],[1,1]],
    [[0,0],[0,1],[0,2],[1,1]],
    [[-1,1],[0,0],[0,1],[1,1]],
  ]},
  S: { color:'#3ddc84', states:[
    [[-1,1],[-1,2],[0,0],[0,1]],
    [[-1,1],[0,1],[0,2],[1,2]],
    [[0,1],[0,2],[1,0],[1,1]],
    [[-1,0],[0,0],[0,1],[1,1]],
  ]},
  Z: { color:'#e84545', states:[
    [[-1,0],[-1,1],[0,1],[0,2]],
    [[-1,2],[0,1],[0,2],[1,1]],
    [[0,0],[0,1],[1,1],[1,2]],
    [[-1,1],[0,0],[0,1],[1,0]],
  ]},
  J: { color:'#3c6bff', states:[
    [[-1,0],[0,0],[0,1],[0,2]],
    [[-1,1],[-1,2],[0,1],[1,1]],
    [[0,0],[0,1],[0,2],[1,2]],
    [[-1,1],[0,1],[1,0],[1,1]],
  ]},
  L: { color:'#ff7b2e', states:[
    [[-1,2],[0,0],[0,1],[0,2]],
    [[-1,1],[0,1],[1,1],[1,2]],
    [[0,0],[0,1],[0,2],[1,0]],
    [[-1,0],[-1,1],[0,1],[1,1]],
  ]},
};
const PIECE_NAMES = ['I','O','T','S','Z','J','L'];

/* ============================================================
 * §3  SRS KICK TABLES
 * ============================================================ */
const SRS_JLSTZ = {
  '0>1':[[ 0,-1],[-1,-1],[2,0],[2,-1]],
  '1>0':[[ 0, 1],[ 1, 1],[-2,0],[-2,1]],
  '1>2':[[ 0, 1],[ 1, 1],[-2,0],[-2,1]],
  '2>1':[[ 0,-1],[-1,-1],[2,0],[2,-1]],
  '2>3':[[ 0, 1],[-1, 1],[2,0],[2, 1]],
  '3>2':[[ 0,-1],[ 1,-1],[-2,0],[-2,-1]],
  '3>0':[[ 0,-1],[ 1,-1],[-2,0],[-2,-1]],
  '0>3':[[ 0, 1],[-1, 1],[2,0],[2, 1]],
};
const SRS_I = {
  '0>1':[[ 0,-2],[0,1],[-1,-2],[2,1]],
  '1>0':[[ 0, 2],[0,-1],[1,2],[-2,-1]],
  '1>2':[[ 0,-1],[0,2],[2,-1],[-1,2]],
  '2>1':[[ 0, 1],[0,-2],[-2,1],[1,-2]],
  '2>3':[[ 0, 2],[0,-1],[-1,2],[2,-1]],
  '3>2':[[ 0,-2],[0,1],[1,-2],[-2,1]],
  '3>0':[[ 0, 1],[0,-2],[2,1],[-1,-2]],
  '0>3':[[ 0,-1],[0,2],[-2,-1],[1,2]],
};
const KICKS_180 = {
  0:[[ 0,0],[0,-1],[0,1],[-1,0],[1,0]],
  1:[[ 0,0],[1,0],[-1,0],[0,1],[0,-1]],
  2:[[ 0,0],[0,1],[0,-1],[1,0],[-1,0]],
  3:[[ 0,0],[-1,0],[1,0],[0,-1],[0,1]],
};

/* ============================================================
 * §4  7-BAG RANDOMIZER
 * ============================================================ */
class BagRandomizer {
  constructor(prng) {
    this.prng  = prng;
    this.queue = [];
    this._fill(); this._fill();
  }
  _fill() {
    const b = [...PIECE_NAMES];
    for (let i = 6; i > 0; i--) {
      const j = this.prng.nextInt(i + 1);
      [b[i], b[j]] = [b[j], b[i]];
    }
    this.queue.push(...b);
  }
  next()  { if (this.queue.length < 6) this._fill(); return this.queue.shift(); }
  peek(n) { while (this.queue.length < n+1) this._fill(); return this.queue.slice(0,n); }
}

/* ============================================================
 * §5  BOARD CONSTANTS & HELPERS
 * ============================================================ */
const TOTAL_ROWS = 40;
const VIS_START  = 20;
const COLS       = 10;
const VIS_ROWS   = 20;
const GARBAGE_COL = '#444460';

function createBoard() {
  return Array.from({length: TOTAL_ROWS}, () => new Array(COLS).fill(0));
}
function isValid(board, cells) {
  for (const [r,c] of cells) {
    if (c < 0 || c >= COLS || r >= TOTAL_ROWS) return false;
    if (r >= 0 && board[r][c]) return false;
  }
  return true;
}
function getCells(piece) {
  return PIECES[piece.type].states[piece.rot]
    .map(([dr,dc]) => [piece.row+dr, piece.col+dc]);
}
function lockPiece(board, cells, color) {
  for (const [r,c] of cells) if (r >= 0) board[r][c] = color;
}
function clearLines(board) {
  let n = 0;
  for (let r = TOTAL_ROWS-1; r >= 0; r--) {
    if (board[r].every(c => c !== 0)) {
      board.splice(r,1);
      board.unshift(new Array(COLS).fill(0));
      n++; r++;
    }
  }
  return n;
}
function boardIsEmpty(board) {
  return board.every(row => row.every(c => c === 0));
}
function isCellFilled(board, r, c) {
  if (c < 0 || c >= COLS || r >= TOTAL_ROWS) return true;
  if (r < 0) return false;
  return board[r][c] !== 0;
}

/* ============================================================
 * §6  MOVEMENT & ROTATION
 * ============================================================ */
function tryMove(board, piece, dr, dc) {
  const m = {...piece, row: piece.row+dr, col: piece.col+dc};
  return isValid(board, getCells(m)) ? m : null;
}
function tryRotate(board, piece, dir) {
  const from = piece.rot;
  const to   = dir === 2 ? (from+2)%4 : ((from+dir)+4)%4;
  const rot  = {...piece, rot: to};
  if (dir === 2) {
    for (const [dr,dc] of KICKS_180[from]) {
      const k = {...rot, row:rot.row+dr, col:rot.col+dc};
      if (isValid(board, getCells(k))) return {piece:k, kickIndex:-1};
    }
    return null;
  }
  const key   = `${from}>${to}`;
  const table = piece.type === 'I' ? SRS_I : SRS_JLSTZ;
  if (isValid(board, getCells(rot))) return {piece:rot, kickIndex:-1};
  const kicks = table[key] || [];
  for (let i=0; i<kicks.length; i++) {
    const [dr,dc] = kicks[i];
    const k = {...rot, row:rot.row+dr, col:rot.col+dc};
    if (isValid(board, getCells(k))) return {piece:k, kickIndex:i};
  }
  return null;
}
function getGhost(board, piece) {
  let g = {...piece};
  while (true) {
    const d = {...g, row:g.row+1};
    if (!isValid(board, getCells(d))) break;
    g = d;
  }
  return g;
}

/* ============================================================
 * §7  T-SPIN DETECTION
 * ============================================================ */
const T_CORNERS = [
  [[-1,-1],[-1,1],[1,-1],[1,1]],
  [[-1,-1],[1,-1],[-1,1],[1,1]],
  [[1,-1],[1,1],[-1,-1],[-1,1]],
  [[-1,1],[1,1],[-1,-1],[1,-1]],
];
function detectTSpin(board, piece, kickIndex) {
  if (piece.type !== 'T') return null;
  const corners = T_CORNERS[piece.rot];
  const filled  = corners.map(([dr,dc]) => isCellFilled(board, piece.row+dr, piece.col+dc));
  const count   = filled.filter(Boolean).length;
  if (count < 3) return null;
  if (kickIndex >= 3)           return 'tspin';
  if (filled[2] && filled[3])   return 'tspin';
  if (count === 4)              return 'tspin';
  return 'mini';
}

/* ============================================================
 * §8  ATTACK TABLE
 * ============================================================ */
const BASE_ATTACK = {
  null:  [0,0,1,2,4],
  tspin: [0,2,4,6],
  mini:  [0,0,1],
};
const COMBO_MULT = [1.0,1.0,1.2,1.4,1.6,1.8,1.8];
function isB2BEligible(spin, lines) {
  if (!lines) return false;
  return spin === 'tspin' || spin === 'mini' || lines >= 4;
}
function calcAttack(spin, lines, b2b, combo, allClear) {
  if (allClear) return 10;
  if (!lines)   return 0;
  const tbl = BASE_ATTACK[spin] ?? BASE_ATTACK[null];
  let atk   = tbl[Math.min(lines, tbl.length-1)];
  if (b2b > 0 && isB2BEligible(spin, lines)) {
    atk += b2b >= 8 ? 3 : b2b >= 4 ? 2 : 1;
  }
  if (combo >= 1 && atk > 0) {
    atk = Math.floor(atk * COMBO_MULT[Math.min(combo, COMBO_MULT.length-1)]);
  }
  return atk;
}

/* ============================================================
 * §9  GARBAGE
 * ============================================================ */
const SCATTER_THRESHOLD = 8;
function nextGarbageCol(prng, last) {
  let c = prng.nextInt(COLS);
  if (c === last) c = (c+1) % COLS;
  return c;
}
function applyGarbage(board, count, prng, lastCol, sickness) {
  let col = nextGarbageCol(prng, lastCol);
  for (let i = 0; i < count; i++) {
    if (sickness >= SCATTER_THRESHOLD) col = nextGarbageCol(prng, col);
    board.shift();
    const line = new Array(COLS).fill(GARBAGE_COL);
    line[col] = 0;
    board.push(line);
  }
  return col;
}

/* ============================================================
 * §10  GRAVITY & LOCK CONSTANTS
 * ============================================================ */
const GRAVITY_TABLE  = [48,43,38,33,28,23,18,13,8,6,5,5,5,4,4,4,3,3,3,2,2,2,2,2,2,2,2,2,2,1];
const LOCK_DELAY     = 30;
const LOCK_RESET_MAX = 15;
const LOCK_FLOOR_MAX = 60;
function getGravity(level) {
  return GRAVITY_TABLE[Math.min(level-1, GRAVITY_TABLE.length-1)];
}

/* ============================================================
 * §11  ENGINE FACTORY
 * ============================================================ */
function createEngine(seed) {
  const prng = new MINSTD(seed);
  const bag  = new BagRandomizer(prng);
  return {
    prng, bag,
    board:       createBoard(),
    active:      _spawn(bag.next()),
    held:        null,
    canHold:     true,
    lockTimer:   0,
    lockResets:  0,
    lockFloor:   0,
    gravTimer:   0,
    score:       0,
    lines:       0,
    level:       1,
    combo:       0,
    b2b:         0,
    attack:      0,
    garbageQueue:[],
    lastGarbCol: -1,
    sickness:    0,
    lastSpin:    null,
    lastKick:    -1,
    dead:        false,
  };
}

function _spawn(type) {
  return { type, rot:0, row: VIS_START-1, col:3 };
}
function _resetLock(eng) {
  eng.lockTimer=0; eng.lockResets=0; eng.lockFloor=0; eng.canHold=true;
}
function _spawnNext(eng, events) {
  eng.active = _spawn(eng.bag.next());
  _resetLock(eng);
  eng.gravTimer = 0;
  eng.lastSpin  = null;
  eng.lastKick  = -1;
  if (!isValid(eng.board, getCells(eng.active))) {
    eng.dead = true;
    events.push({ type:'gameOver' });
  }
}
function _lock(eng, events) {
  const cells = getCells(eng.active);
  const spin  = eng.lastSpin === 'candidate'
    ? detectTSpin(eng.board, eng.active, eng.lastKick)
    : null;

  lockPiece(eng.board, cells, PIECES[eng.active.type].color);

  if (cells.every(([r]) => r < VIS_START)) {
    eng.dead = true; events.push({ type:'gameOver' }); return;
  }

  const cleared = clearLines(eng.board);
  eng.lines    += cleared;
  eng.level     = Math.floor(eng.lines/10)+1;
  const ac      = cleared > 0 && boardIsEmpty(eng.board);

  if (cleared > 0) {
    if (isB2BEligible(spin, cleared)) eng.b2b++;
    else eng.b2b = 0;
    eng.combo++;
  } else {
    eng.combo = 0;
  }

  const atk = calcAttack(
    spin, cleared,
    eng.b2b - (isB2BEligible(spin, cleared) ? 1 : 0),
    eng.combo - (cleared > 0 ? 1 : 0),
    ac
  );
  eng.attack += atk;

  let rem = atk;
  while (rem > 0 && eng.garbageQueue.length > 0) {
    const f = eng.garbageQueue[0];
    if (f.count <= rem) { rem -= f.count; eng.garbageQueue.shift(); }
    else { f.count -= rem; rem = 0; }
  }

  eng.sickness = (cleared===0 && atk===0)
    ? Math.min(eng.sickness+1, SCATTER_THRESHOLD+2) : 0;

  if (eng.garbageQueue.length > 0) {
    for (const g of eng.garbageQueue)
      eng.lastGarbCol = applyGarbage(eng.board, g.count, eng.prng, eng.lastGarbCol, eng.sickness);
    eng.garbageQueue = [];
  }

  if (atk > 0) events.push({ type:'attack', lines:atk, spin, b2b:eng.b2b, combo:eng.combo, allClear:ac });
  if (ac)      events.push({ type:'allClear' });
  _spawnNext(eng, events);
}

function stepEngine(eng, input) {
  if (eng.dead) return [];
  const events = [];
  switch (input.type) {
    case 'move': {
      const m = tryMove(eng.board, eng.active, 0, input.value);
      if (m) {
        eng.active=m; eng.lastSpin=null; eng.lastKick=-1;
        if (eng.lockResets<LOCK_RESET_MAX) { eng.lockTimer=0; eng.lockResets++; }
      }
      break;
    }
    case 'rotate': {
      const r = tryRotate(eng.board, eng.active, input.value);
      if (r) {
        eng.active=r.piece;
        eng.lastSpin = eng.active.type==='T' ? 'candidate' : null;
        eng.lastKick = r.kickIndex;
        if (eng.lockResets<LOCK_RESET_MAX) { eng.lockTimer=0; eng.lockResets++; }
      }
      break;
    }
    case 'softDrop': {
      const d = tryMove(eng.board, eng.active, 1, 0);
      if (d) { eng.active=d; eng.score+=1; eng.gravTimer=0; eng.lastSpin=null; }
      break;
    }
    case 'hardDrop': {
      const g = getGhost(eng.board, eng.active);
      eng.score += (g.row - eng.active.row) * 2;
      eng.active  = g;
      _lock(eng, events);
      break;
    }
    case 'hold': {
      if (!eng.canHold) break;
      eng.canHold=false; eng.lastSpin=null; eng.lastKick=-1;
      if (eng.held===null) { eng.held=eng.active.type; _spawnNext(eng,events); }
      else { const t=eng.held; eng.held=eng.active.type; eng.active=_spawn(t); _resetLock(eng); }
      break;
    }
    case 'gravity': {
      const d = tryMove(eng.board, eng.active, 1, 0);
      if (d) { eng.active=d; eng.lastSpin=null; }
      break;
    }
    case 'lockTick': {
      eng.lockTimer++; eng.lockFloor++;
      if (eng.lockTimer>=LOCK_DELAY || eng.lockFloor>=LOCK_FLOOR_MAX) _lock(eng,events);
      break;
    }
    case 'receiveGarbage': {
      eng.garbageQueue.push({ count: input.value });
      events.push({ type:'garbage', lines: input.value });
      break;
    }
  }
  return events;
}

function tickEngine(eng) {
  if (eng.dead) return [];
  const events = [];
  eng.gravTimer++;
  if (eng.gravTimer >= getGravity(eng.level)) {
    eng.gravTimer = 0;
    stepEngine(eng, { type:'gravity' });
  }
  const resting = !tryMove(eng.board, eng.active, 1, 0);
  if (resting) {
    events.push(...stepEngine(eng, { type:'lockTick' }));
  } else {
    eng.lockTimer = 0;
  }
  return events;
}

function hashEngine(eng) {
  let h = 0;
  for (let r=0; r<TOTAL_ROWS; r++) {
    for (let c=0; c<COLS; c++) {
      if (eng.board[r][c]) h = (h * 31 + eng.board[r][c].charCodeAt(1)) | 0;
    }
  }
  h = (h * 31 + eng.score) | 0;
  h = (h * 31 + eng.lines) | 0;
  if (eng.active) {
    h = (h * 31 + eng.active.row) | 0;
    h = (h * 31 + eng.active.col) | 0;
    h = (h * 31 + eng.active.rot) | 0;
  }
  return h;
}

/* ============================================================
 * EXPORTS — returned from the IIFE factory function
 * ============================================================ */
return {
  MINSTD, BagRandomizer, PIECES, PIECE_NAMES,
  COLS, VIS_ROWS, VIS_START, TOTAL_ROWS, GARBAGE_COL,
  createEngine, stepEngine, tickEngine, hashEngine,
  getCells, getGhost, tryMove, tryRotate, createBoard,
};

})); // end IIFE / UMD wrapper
