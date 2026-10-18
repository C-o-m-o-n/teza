import { Bot, BOT_PROFILES, BotProfile } from "../ai/bot";
import { blitzBoost, musicIntensity } from "../audio/music";
import { SOUND_PACKS, packById } from "../audio/packs";
import { music, sfx } from "../audio/sfx";
import { SONGS, songFor } from "../audio/songs";
import { BOARD_H, BUFFER, PieceType, Rotation } from "../engine/constants";
import { Action, Game, GameEvent } from "../engine/game";
import { Recorder, ReplayInput, ReplayPlayer } from "../engine/replay";
import { stepToClock } from "../engine/stepping";
import { MODES, Mode, ModeId, modeById } from "../modes";
import { OnlineClient, OnlineResult } from "../net/online";
import { mergeRecords, passwordError, usernameError } from "../profile";
import { BoardView, formatTime, Renderer } from "../render/renderer";
import { ROOM_CODE } from "../server/match";
import { formatRange, INITIAL_RANGE } from "../server/matchmaking";
import {
  BIND_LABELS, BIND_ORDER, Bind, Records, Settings, defaultSettings, loadGhost, loadRecords, loadSettings, saveGhost,
  saveRecords, saveSettings,
} from "../settings";
import {
  Cooldown, LeaderboardPlayer, Profile, PublicRating, fetchLeaderboard, fetchMe, fetchProfile, finishSession, joinQueue, leaveQueue,
  putRecords, queueStatus, signIn,
} from "./account";
import { classicWordmark, wordmark } from "./brand";
import { newRoom, onlineAvailable } from "./rooms";
import { THEMES, themeById } from "./themes";

type Screen = "title" | "menu" | "bots" | "lobby" | "queue" | "leaderboard" | "profile" | "config" | "account" | "play" | "results";

const GAME_ACTIONS: Action[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];
const COUNTDOWN = [
  { at: 0, text: "READY" },
  { at: 0.75, text: "SET" },
  { at: 1.5, text: "GO!" },
];
const START_AT = 1.5;
const LEDE = "Tetris + cheza — Swahili for play. SRS+, 180 kicks, 7-bag, B2B chaining, with mechanics matched to the modern online stacker.";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v; // through the CSSOM: the CSP (style-src 'self') refuses a style attribute
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

const ARROW_TURN: Record<string, number> = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };

/** Poster Slab's label for a key cap. Arrows are drawn: its fonts have no ← or →, and their ↑ ↓ are hairlines (Classic keeps keyName's). */
function keyLabel(code: string): Node | string {
  const turn = ARROW_TURN[code];
  if (turn === undefined) return keyName(code);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "key-arrow");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${code.slice(5)} arrow`);
  svg.style.transform = `rotate(${turn}deg)`;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 1.5 15 9H10.5v5.5h-5V9H1z");
  svg.append(path);
  return svg;
}

function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "SPACE",
    ShiftLeft: "L-SHIFT", ShiftRight: "R-SHIFT", ControlLeft: "L-CTRL", ControlRight: "R-CTRL",
    AltLeft: "L-ALT", AltRight: "R-ALT", Escape: "ESC", Enter: "ENTER", Backspace: "BKSP",
  };
  return map[code] ?? code.toUpperCase();
}

/** Height of a game's stack in visible rows (0 = empty board). */
function stackRows(game: Game): number {
  for (let y = BUFFER; y < BUFFER + BOARD_H; y++) {
    if (game.board[y].some((c) => c !== null)) return BUFFER + BOARD_H - y;
  }
  return 0;
}

interface Session {
  mode: Mode;
  seed: number;
  player: Game;
  playerView: BoardView;
  bot: Game | null;
  botView: BoardView | null;
  botAI: Bot | null;
  botProfile: BotProfile | null;
  botAcc: number;
  recorder: Recorder | null; // 40 LINES: records the player's inputs
  clock: number; // frames since GO, which the player and bot trail (see advanceTo)
  ghost: ReplayPlayer | null; // 40 LINES: the PB run, raced alongside
  ghostView: BoardView | null;
  t: number; // seconds since session start (countdown included)
  started: boolean;
  last: number; // performance.now() of last sim advance
  endAt: number | null; // when to show results
  outcome: "win" | "lose" | "draw" | "lost" | "clear" | "fail" | null;
  online: OnlineClient | null; // an online match: `bot` is the opponent as the server relays it
  away: number | null; // performance.now() when the absent opponent forfeits
  notice: { text: string; until: number } | null; // a server error, shown over the board for a while
}

const UNAVAILABLE = "Online play isn't available here";
const SIGN_IN_FOR_RANKED = "Sign in to play ranked";
const QUEUE_POLL_MS = 2000; // the queue's keep-alive is 15 s (src/server/matchmaking.ts)
const NO_PLAYERS = "NO CALIBRATED PLAYERS YET";
const NO_SUCH_PLAYER = "No such player";

/** `TR 12,345`, or `TR HIDDEN` while the rating is still being calibrated. */
const trText = (tr: number | null) => (tr === null ? "TR HIDDEN" : `TR ${tr.toLocaleString("en-US")}`);

/** The queue screen's answer to a cooldown (a 429 from queue/join). */
function cooldownText(c: Cooldown): string {
  const wait = `${Math.floor(c.retryAfter / 60)}:${String(c.retryAfter % 60).padStart(2, "0")}`;
  return `You didn't join your last ranked match, so you can search again in ${wait}.`;
}
const OUTCOME_TEXT: Record<OnlineResult["outcome"], [string, string]> = {
  win: ["VICTORY", "YOU WIN"], lose: ["DEFEAT", "YOU LOSE"], draw: ["DRAW", "DRAW"], lost: ["CONNECTION LOST", "NO RESULT"],
};
const REASON_TEXT: Record<string, string> = {
  topout: "BY TOP-OUT", disconnect: "BY DISCONNECT", idle: "IDLE MATCH", connection: "THE CONNECTION DROPPED",
};

export class App {
  private settings: Settings = loadSettings();
  private records: Records = loadRecords();
  private account: string | null = null; // signed-in username
  private rating: PublicRating | null = null; // the signed-in account's TR, as `me` last said
  private renderer: Renderer;
  private root: HTMLElement;
  private screen: Screen = "menu";
  private session: Session | null = null;
  private room: OnlineClient | null = null; // the online lobby's connection, until the match starts
  private queue: { stop: () => void } | null = null; // the ranked queue's polling, while searching
  private ladder: LeaderboardPlayer[] | null = null; // the LEADERBOARD as last fetched, so BACK from a profile is instant
  private held = new Set<Bind>();
  private listening: { bind: Bind; slot: number; btn: HTMLButtonElement } | null = null;
  private lastFrame = performance.now();
  private resultsShownAt = 0;
  private motionQuery: MediaQueryList | null = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

  constructor(canvas: HTMLCanvasElement, root: HTMLElement) {
    this.renderer = new Renderer(canvas);
    this.root = root;
    this.applySettings();
    this.motionQuery?.addEventListener("change", () => this.applySettings());
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    window.addEventListener("blur", () => {
      this.held.clear();
      if (this.session) this.input(this.session, { type: "releaseAll" });
    });
    window.addEventListener("pointerdown", () => this.unlockAudio(), { once: false });
    // Poster Slab opens on its title screen; Classic goes straight to the menu.
    if (this.poster) this.showTitle();
    else this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
    void fetchMe().then((p) => p && this.adoptProfile(p));
  }

  /** Signed in: merge local and server records (better wins), keep the result in both places. */
  private adoptProfile(p: Profile): void {
    this.account = p.username;
    this.rating = p.rating;
    this.records = mergeRecords(this.records, p.records);
    saveRecords(this.records);
    void putRecords(this.records);
    if (this.screen === "menu") this.showMenu(false);
  }

  /** The Poster Slab theme is on (its own markup); every other theme uses Classic's. */
  private get poster(): boolean {
    return this.settings.theme === "poster";
  }

  /** Reduced motion, from CONFIG or the OS. */
  private get still(): boolean {
    return this.settings.reduceMotion || (this.motionQuery?.matches ?? false);
  }

  /** From a user gesture: unlock audio, and start the menu music if nothing is playing yet. */
  private unlockAudio(): void {
    sfx.unlock();
    if (!music.playing) this.syncMusic();
  }

  /**
   * Play the song for where the player is: the mode's song from the countdown until the run ends,
   * the menu song everywhere else (results included). Crossfades; `restart` starts the song afresh.
   */
  private syncMusic(restart = false): void {
    const s = this.session;
    const where = s && s.endAt === null ? s.mode.id : "menu";
    const song = songFor(this.settings.musicTrack, where);
    if (!song) music.stop(0.6);
    else music.play(song, { restart, fade: where === "menu" ? 2.5 : 1.5 });
  }

  private applySettings(): void {
    sfx.volume = this.settings.volume;
    sfx.musicVolume = this.settings.musicVolume;
    sfx.pack = packById(this.settings.soundPack);
    this.renderer.gridOpacity = this.settings.gridOpacity;
    this.renderer.shadowOpacity = this.settings.shadowOpacity;
    for (const v of this.renderer.views) {
      v.bounciness = this.settings.bounciness;
      v.reduceMotion = this.still;
    }
    // index.html set these before the first paint, from the same saved setting
    const theme = themeById(this.settings.theme);
    document.documentElement.dataset.theme = theme.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.themeColor);
  }

  // ------------------------------------------------------------------ loop

  private loop(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.session) this.tickSession(now);
    this.renderer.update(dt);
    this.renderer.draw();
    requestAnimationFrame((t) => this.loop(t));
  }

  private tickSession(now: number): void {
    const s = this.session!;
    const dt = Math.min(0.25, (now - s.last) / 1000);
    s.t += dt;
    if (s.endAt === null) {
      // only the player's board drives the music; Blitz speeds up over its final 30 s
      const obj = s.player.opts.objective;
      const boost = s.mode.id === "blitz" && obj.type === "timed" ? blitzBoost(s.player.frame, obj.frames) : 1;
      const intensity = musicIntensity({
        danger: s.playerView.danger, stackRows: stackRows(s.player), garbage: s.player.pendingGarbage(),
        combo: Math.max(0, s.player.stats.combo - 1), boost,
      });
      music.update(intensity, boost);
      if (s.player.stats.combo === 0) music.endCombo();
    }
    if (!s.started) {
      s.last = now;
      const cd = [...COUNTDOWN].reverse().find((c) => s.t >= c.at);
      if (cd && this.renderer.overlay.countdown !== cd.text) {
        this.renderer.overlay = { countdown: cd.text, countdownT: 0 };
        sfx.countdown(cd.text === "GO!");
      }
      if (s.t >= START_AT) this.startPlay(now);
      return;
    }
    if (this.renderer.overlay.countdown && s.t > START_AT + 0.5) this.renderer.overlay.countdown = null;
    this.advanceTo(now);
    if (s.endAt !== null && s.t >= s.endAt && this.screen === "play") this.showResults();
  }

  private startPlay(now: number): void {
    const s = this.session!;
    s.started = true;
    s.last = now;
    // keys held through the countdown take effect at GO, like the original
    for (const b of this.held) if ((GAME_ACTIONS as string[]).includes(b)) this.input(s, { type: "press", action: b as Action });
  }

  /** Apply an input to the player's game, recording it in 40 LINES; online, the client sends it too. */
  private input(s: Session, input: ReplayInput): void {
    if (s.online) {
      // a blur releases each held action on its own, so the server's engine does the same
      if (input.type === "press") s.online.press(input.action);
      else if (input.type === "release") s.online.release(input.action);
      else s.online.blur();
    } else if (s.recorder) s.recorder.apply(input);
    else if (input.type === "press") s.player.press(input.action);
    else if (input.type === "release") s.player.release(input.action);
    else s.player.releaseAll();
  }

  /**
   * Bring the simulation up to `now` so an input (`input`) lands at the right sub-frame. The player
   * and bot rest only on whole frames between inputs (stepping.ts), so the result does not depend
   * on the display's frame timing, and a 40 LINES replay takes the same steps.
   */
  private advanceTo(now: number, input = false): void {
    const s = this.session;
    if (!s || !s.started) return;
    const dt = Math.min(0.25, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    if (s.endAt !== null) return;
    if (s.online) return this.advanceOnline(s, now);
    s.clock += dt * 60;
    stepToClock(s.player, s.clock, input);
    if (s.ghost && s.ghostView) {
      s.ghost.advanceTo(s.player.frame);
      const lead = s.ghost.game.stats.lines - s.player.stats.lines;
      s.ghostView.marker = lead > 0 ? `GHOST +${lead}` : lead < 0 ? `YOU +${-lead}` : "EVEN";
    }
    if (s.bot && s.botAI && s.botProfile) {
      stepToClock(s.bot, s.clock);
      s.botAcc += dt;
      const interval = 1 / s.botProfile.pps;
      while (s.botAcc >= interval && !s.bot.over) {
        s.botAcc -= interval;
        s.botAI.playPiece();
      }
    }
  }

  /**
   * Online, the client keeps its own clock (the server's, from `start`) and steps both boards; the
   * opponent's only moves when the server relays it. Here: the status lines over the boards.
   */
  private advanceOnline(s: Session, now: number): void {
    const client = s.online!;
    client.update();
    s.clock = client.clock;
    if (s.notice && now >= s.notice.until) s.notice = null;
    s.playerView.marker = s.notice?.text ?? (s.player.over ? "TOPPED OUT · WAITING" : null);
    s.botView!.marker = s.away === null ? null : `OPPONENT DISCONNECTED · ${Math.max(0, Math.ceil((s.away - now) / 1000))}s`;
  }

  // ------------------------------------------------------------------ sessions

  private startSession(modeId: ModeId, profile: BotProfile | null = null): void {
    const mode = modeById(modeId);
    // `?seed=<positive integer>` fixes the piece sequence (the e2e runs use it); otherwise random.
    const param = new URLSearchParams(location.search).get("seed") ?? "";
    const fixed = /^\d{1,10}$/.test(param) ? Number(param) : 0;
    const seed = fixed >= 1 && fixed <= 2147483646 ? fixed : Math.floor(Math.random() * 2147483646) + 1;
    const player = new Game(mode.options(seed), this.settings.handling);
    player.trackFinesse = true;
    const playerView = new BoardView(player, {
      accent: mode.accent, mode: mode.id, objectiveLines: 40, label: mode.id === "vs" ? "YOU" : undefined,
    });
    let bot: Game | null = null;
    let botView: BoardView | null = null;
    let botAI: Bot | null = null;
    const replay = mode.id === "40l" ? loadGhost(this.records["40l"]?.value) : null;
    const ghost = replay ? new ReplayPlayer(replay) : null;
    const ghostView = ghost
      ? new BoardView(ghost.game, { accent: mode.accent, mode: "40l", objectiveLines: 40, label: "PB GHOST", compact: true, ghost: true })
      : null;
    if (ghostView) ghostView.marker = "EVEN";
    if (mode.id === "vs" && profile) {
      bot = new Game(mode.options(seed));
      botView = new BoardView(bot, { accent: mode.accent, mode: "vs", label: `${profile.name} BOT`, compact: true });
      botAI = new Bot(bot, profile);
    }
    this.mount({
      mode, seed, player, playerView, bot, botView, botAI, botProfile: profile, botAcc: 0,
      recorder: mode.id === "40l" ? new Recorder(player) : null, clock: 0, ghost, ghostView,
      t: 0, started: false, last: performance.now(), endAt: null, outcome: null, online: null, away: null, notice: null,
    });
    if (bot && botView) {
      player.onAttack = (n) => this.sendAttack(playerView, botView!, bot!, n);
      bot.onAttack = (n) => this.sendAttack(botView!, playerView, player, n);
    }
    bot?.on((e) => {
      if (e.type === "topout") this.endSession("win");
    });
  }

  /**
   * Both players are in: the online match starts at once (the server's clock began at `start`, so
   * there is no countdown), with the server's rules and handling. Only the server's `end` decides it.
   */
  private startOnline(client: OnlineClient): void {
    const mode = modeById("vs");
    const player = client.player!;
    const opponent = client.opponent!;
    const playerView = new BoardView(player, { accent: mode.accent, mode: "vs", objectiveLines: 40, label: "YOU" });
    const opponentView = new BoardView(opponent, { accent: mode.accent, mode: "vs", label: "OPPONENT", compact: true });
    this.room = null;
    const s: Session = {
      mode, seed: player.opts.seed, player, playerView, bot: opponent, botView: opponentView, botAI: null, botProfile: null,
      botAcc: 0, recorder: null, clock: 0, ghost: null, ghostView: null, t: 0, started: true, last: performance.now(),
      endAt: null, outcome: null, online: client, away: null, notice: null,
    };
    // garbage flights: our predicted attacks go out (the server sends the real ones); the server's come in
    client.events = {
      attack: (n) => this.flight(playerView, opponentView, n, opponent.opts.garbagespeed),
      garbage: (n) => this.flight(opponentView, playerView, n, player.opts.garbagespeed),
      opponentAway: (ms) => (s.away = ms === null ? null : performance.now() + ms),
      error: (_code, message) => (s.notice = { text: message.toUpperCase(), until: performance.now() + 3000 }),
      end: (result) => {
        // a ranked match changed our TR: the queue screen shows it from `me` next time
        if (result.rating) void fetchMe().then((p) => p && (this.rating = p.rating));
        this.endSession(result.outcome);
      },
    };
    this.mount(s);
  }

  /** Show a session: its boards, music and sounds, on the play screen. */
  private mount(s: Session): void {
    this.session = s;
    this.renderer.accent = s.mode.accent;
    this.renderer.views = s.botView ? [s.playerView, s.botView] : s.ghostView ? [s.playerView, s.ghostView] : [s.playerView];
    this.renderer.flights = [];
    this.renderer.overlay = { countdown: null, countdownT: 0 };
    this.renderer.layoutViews();
    this.applySettings();
    this.syncMusic(true); // crossfade into the mode's song: the countdown is its intro
    this.wireSounds(s.player, true);
    if (s.bot) this.wireSounds(s.bot, false);
    s.player.on((e) => this.onPlayerEvent(e));
    this.setScreen("play");
  }

  private sendAttack(from: BoardView, to: BoardView, target: Game, n: number): void {
    this.flight(from, to, n, target.opts.garbagespeed);
    target.receive(n);
  }

  private flight(from: BoardView, to: BoardView, n: number, frames: number): void {
    this.renderer.flights.push({
      from: this.renderer.boardCentre(from),
      to: this.renderer.meterPoint(to),
      t: 0,
      dur: frames / 60,
      amount: n,
      color: n >= 6 ? "#ff3fa4" : "#ff7a3c",
    });
  }

  /** `loud` is the player's game: every sound, panned by piece column. The bot's is quieter and centred. */
  private wireSounds(game: Game, loud: boolean): void {
    const centre = (type: PieceType, x: number, y: number, r: Rotation) => {
      const cells = game.cellsOf(type, x, y, r);
      return cells.reduce((a, [cx]) => a + cx, 0) / cells.length;
    };
    const col = () => (loud ? centre(game.piece.type, game.piece.x, game.piece.y, game.piece.r) : undefined);
    let last: number | undefined; // column of the last dropped/locked piece, for its clear
    game.on((e) => {
      if (!loud && !["clear", "garbage-tank", "topout"].includes(e.type)) return;
      switch (e.type) {
        case "move": sfx.move(col()); break;
        case "wall": break;
        case "rotate": if (e.spin !== "none") sfx.spin(col()); else sfx.rotate(col()); break;
        case "hold": sfx.hold(col()); break;
        case "harddrop":
          last = loud ? centre(e.piece, e.x, e.y, e.r) : undefined;
          sfx.harddrop(last);
          break;
        case "lock": last = col(); break;
        case "clear":
          sfx.clear(e.info.lines, e.info.spin !== "none", e.info.combo, e.info.btb, last);
          if (e.info.allClear) sfx.allClear();
          if (e.info.btbBroken >= 2) sfx.btbBreak(last);
          if (loud) {
            sfx.duckMusic(e.info.lines >= 4 || e.info.spin !== "none" || e.info.allClear);
            music.combo(e.info.combo - 1); // the on-screen "N COMBO": the first clear of a chain is 0
          }
          break;
        case "garbage-in": sfx.garbageIn(e.amount); break;
        case "garbage-tank": sfx.garbageRise(); break;
        case "attack": sfx.attack(e.amount); break;
        case "levelup": sfx.levelUp(); break;
        case "topout": sfx.topout(); break;
        case "finish": sfx.finish(); break;
      }
    });
  }

  private onPlayerEvent(e: GameEvent): void {
    const s = this.session;
    if (!s) return;
    if (e.type === "topout") {
      if (s.online) return; // input stops; the server's `end` decides the match
      if (s.mode.id === "zen") {
        setTimeout(() => s.player.wipe(), 0);
        return;
      }
      this.endSession(s.mode.id === "vs" ? "lose" : "fail");
    } else if (e.type === "finish") {
      this.endSession("clear");
    }
  }

  private endSession(outcome: Session["outcome"]): void {
    const s = this.session;
    if (!s || s.endAt !== null) return;
    s.outcome = outcome;
    s.endAt = s.t + (outcome === "clear" || outcome === "win" ? 0.9 : 1.3);
    if (s.online) s.playerView.marker = s.botView!.marker = null;
    this.syncMusic(); // back to the menu song for the results
    if (outcome === "win") {
      s.botView!.bigText = { text: "K.O.", t: 0, color: "#ff3f5f" };
      sfx.finish();
    }
  }

  private retry(): void {
    const s = this.session;
    if (!s || s.online) return; // no rematch online
    this.startSession(s.mode.id, s.botProfile);
  }

  private exitToMenu(): void {
    this.session?.online?.leave(); // the opponent wins by forfeit after the server's grace period
    this.session = null;
    this.syncMusic();
    this.renderer.views = [];
    this.renderer.flights = [];
    this.renderer.overlay = { countdown: null, countdownT: 0 };
    this.renderer.accent = "#3f6bff";
    this.showMenu();
  }

  // ------------------------------------------------------------------ input

  private bindFor(code: string): Bind | null {
    for (const [bind, codes] of Object.entries(this.settings.keys) as [Bind, string[]][]) {
      if (codes.includes(code)) return bind;
    }
    return null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.unlockAudio();
    if (this.listening) {
      e.preventDefault();
      this.finishListening(e.code);
      return;
    }
    if (this.screen === "title") {
      // Any key skips to the menu. Leave browser shortcuts (Ctrl+R, F5, ...) alone.
      if (!(e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.code))) e.preventDefault();
      this.showMenu();
      return;
    }
    if (this.screen === "play") {
      const bind = this.bindFor(e.code);
      if (!bind) return;
      e.preventDefault();
      if (e.repeat) return;
      if (bind === "exit") return this.exitToMenu();
      if (bind === "retry") {
        if (this.session && this.session.mode.id !== "vs") this.retry();
        return;
      }
      this.held.add(bind);
      const s = this.session;
      if (s?.started && s.endAt === null) {
        this.advanceTo(performance.now(), true);
        this.input(s, { type: "press", action: bind as Action });
      }
      return;
    }
    if (this.screen === "results") {
      const bind = this.bindFor(e.code);
      // Game keys (e.g. spamming hard drop after a top-out) must never activate a button.
      if (bind || e.code === "Enter" || e.code === "Space") e.preventDefault();
      if (performance.now() < this.resultsShownAt + 600) return;
      if (this.session?.online) {
        // online results have one action, MENU
        if (bind === "exit" || e.code === "Enter") this.exitToMenu();
      } else if (bind === "retry" || e.code === "Enter") {
        e.preventDefault();
        this.retry();
      } else if (bind === "exit") {
        this.exitToMenu();
      }
      return;
    }
    // menu navigation
    if (e.code === "ArrowDown" || e.code === "ArrowUp") {
      e.preventDefault();
      const items = [...this.root.querySelectorAll<HTMLElement>("[data-nav]")];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.code === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
      sfx.menu();
    } else if (e.code === "Escape") {
      if (this.screen === "lobby") {
        sfx.menu();
        this.leaveRoom();
        this.showBots();
      } else if (this.screen === "queue") {
        sfx.menu();
        this.cancelQueue();
        this.showBots();
      } else if (this.screen === "profile") {
        sfx.menu();
        this.showLeaderboard(this.ladder);
      } else if (this.screen === "leaderboard") {
        sfx.menu();
        this.showBots();
      } else if (this.screen !== "menu") {
        sfx.menu();
        this.showMenu();
      }
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const bind = this.bindFor(e.code);
    if (!bind) return;
    this.held.delete(bind);
    const s = this.session;
    if (s?.started && (GAME_ACTIONS as string[]).includes(bind)) {
      this.advanceTo(performance.now(), true);
      this.input(s, { type: "release", action: bind as Action });
    }
  }

  // ------------------------------------------------------------------ screens

  private setScreen(screen: Screen, content?: HTMLElement): void {
    this.screen = screen;
    this.root.replaceChildren();
    this.root.dataset.screen = screen;
    if (content) this.root.append(content);
    const first = this.root.querySelector<HTMLElement>("[data-nav]");
    first?.focus();
  }

  private bar(opts: { accent: string; title: string; tagline: string; glyph: string; meta?: string; onClick: () => void; index: number }): HTMLButtonElement {
    const b = el("button", { class: "bar", "data-nav": "", style: `--accent:${opts.accent};--i:${opts.index}` },
      el("span", { class: "bar-glyph", "aria-hidden": "true" }, opts.glyph),
      el("span", { class: "bar-title" }, opts.title),
      el("span", { class: "bar-tagline" }, opts.tagline),
    );
    if (opts.meta) b.append(el("span", { class: "bar-meta" }, opts.meta));
    b.addEventListener("click", () => {
      this.unlockAudio();
      sfx.confirm();
      opts.onClick();
    });
    b.addEventListener("mouseenter", () => sfx.menu());
    return b;
  }

  /** The menu in the current theme. In Classic the wordmark's Z drops in as it opens, unless `drop` is false (a redraw). */
  private showMenu(drop = true): void {
    const r = this.records;
    const w = Object.values(r.vs).reduce((a, b) => a + b.wins, 0);
    const l = Object.values(r.vs).reduce((a, b) => a + b.losses, 0);
    const sprint = r["40l"] ? `${formatTime(r["40l"].value).main}${formatTime(r["40l"].value).ms}` : null;
    const blitz = r.blitz ? r.blitz.value.toLocaleString("en-US") : null;
    const meta: Partial<Record<ModeId, string>> = {
      "40l": sprint ? `PB ${sprint}` : "NO RECORD",
      blitz: blitz ? `PB ${blitz}` : "NO RECORD",
      vs: w + l ? `${w}W – ${l}L` : "UNRANKED",
      zen: "ENDLESS",
    };
    const bars = MODES.map((m, i) =>
      this.bar({
        accent: m.accent, title: m.title, tagline: m.tagline, glyph: m.glyph, meta: meta[m.id], index: i,
        onClick: () => (m.id === "vs" ? this.showBots() : this.startSession(m.id)),
      }),
    );
    bars.push(this.bar({
      accent: this.poster ? "#0f6b3e" : "#3b3b4a", title: "CONFIG", tagline: "Handling, controls, audio, visuals.", glyph: "⚙", index: MODES.length,
      onClick: () => this.showConfig(),
    }));
    if (!this.poster) {
      const page = el("div", { class: "menu" },
        el("header", { class: "brand" }, classicWordmark(drop && !this.still), el("p", {}, LEDE)),
        el("nav", { class: "bars" }, ...bars),
        this.accountBlock(sprint ?? "—", blitz ?? "—", `${w}W – ${l}L`),
        el("footer", { class: "hint" }, "↑ ↓ to choose · ENTER to play · ESC to go back"),
      );
      return this.setScreen("menu", page);
    }
    const replay = el("button", { class: "wm-replay", type: "button", title: "Replay the title" }, wordmark());
    replay.addEventListener("click", () => this.showTitle());
    const page = this.splitPage(el("header", { class: "brand" }, el("h1", {}, replay)),
      el("p", { class: "lede" }, LEDE),
      el("nav", { class: "bars" }, ...bars),
      el("div", { class: "menu-foot" },
        this.accountBlock(sprint ?? "—", blitz ?? "—", `${w}W – ${l}L`),
        el("footer", { class: "hint" }, el("span", {}, "↑ ↓ to choose · ENTER to play · ESC to go back"), el("span", { class: "origin" }, "built in kenya")),
      ),
    );
    this.setScreen("menu", page);
  }

  /**
   * The title screen, once per page load and again from the menu's wordmark. The letters drop into the
   * red slab as Tetris pieces, then the CHEZA row clears and wipes away to the menu, which is already
   * built underneath. Any key, click or tap skips. With reduced motion it shows the last frame and waits.
   */
  private showTitle(): void {
    this.showMenu();
    const menu = this.root.firstElementChild as HTMLElement;
    menu.inert = true;
    const title = el("section", { class: this.still ? "title still" : "title", "aria-label": "TEZA" },
      el("div", { class: "title-stage" }, wordmark("ghost"), el("h1", {}, wordmark())),
      el("div", { class: "title-row" },
        el("span", { class: "title-cheza", "aria-hidden": "true" }, "CHEZA"),
        el("p", { class: "title-gloss" }, el("span", {}, "Tetris + cheza"), el("span", {}, "Swahili for play")),
      ),
      el("footer", { class: "title-foot" }, el("span", { class: "origin" }, "built in kenya"), el("span", {}, "press any key")),
    );
    title.addEventListener("click", () => this.showMenu());
    title.addEventListener("animationend", (e) => {
      if (e.target === title && this.screen === "title") this.showMenu();
    });
    this.root.append(title);
    this.screen = "title";
    this.root.dataset.screen = "title";
  }

  /** The menu screens' layout: the red slab (wordmark or screen title) beside the main column. */
  private splitPage(slab: HTMLElement, ...main: HTMLElement[]): HTMLElement {
    return el("div", { class: "menu" }, slab, el("div", { class: "menu-main" }, ...main));
  }

  /** The slab for a sub-screen: its title set like the wordmark, with the wordmark small above it. */
  private titleSlab(title: string): HTMLElement {
    return el("header", { class: "brand small" }, wordmark(), el("h1", { style: `--len:${title.length}` }, title));
  }

  /** A sub-screen (VERSUS, ACCOUNT): Poster's title slab beside the column, or Classic's small header above it. */
  private subPage(title: string, lede: string, ...main: HTMLElement[]): HTMLElement {
    if (this.poster) return this.splitPage(this.titleSlab(title), el("p", { class: "lede" }, lede), ...main);
    // a title longer than ACCOUNT (LEADERBOARD) is set smaller so it stays in its column
    const h1 = el("h1", title.length > 8 ? { class: "long" } : {}, el("span", {}, title));
    return el("div", { class: "menu" }, el("header", { class: "brand small" }, h1, el("p", {}, lede)), ...main);
  }

  /** Menu corner: SIGN IN when anonymous; username, profile stats and SIGN OUT when signed in. */
  private accountBlock(sprint: string, blitz: string, vs: string): HTMLElement {
    const block = el("section", { class: "account" });
    if (!this.account) {
      const signInBtn = el("button", { class: "ghost-btn", "data-nav": "" }, "SIGN IN");
      signInBtn.addEventListener("click", () => this.showAccount());
      block.append(el("p", { class: "account-label" }, "PLAYING OFFLINE · RECORDS KEPT ON THIS DEVICE"), signInBtn);
      return block;
    }
    const stat = (label: string, value: string) => el("div", { class: "stat" }, el("span", {}, label), el("strong", {}, value));
    const signOutBtn = el("button", { class: "ghost-btn", "data-nav": "" }, "SIGN OUT");
    const error = el("p", { class: "form-error", role: "alert" });
    signOutBtn.addEventListener("click", async () => {
      signOutBtn.disabled = true;
      signOutBtn.textContent = "SIGNING OUT…";
      error.textContent = "";
      if (!(await finishSession(this.records))) {
        // Still signed in on the server (or its copy of the records is behind): keep everything.
        error.textContent = "Couldn't sign out — check your connection";
        signOutBtn.textContent = "SIGN OUT";
        signOutBtn.disabled = false;
        return;
      }
      // Signed out. A shared device must not hand these records to the next player. After a 401 the
      // session had already ended and this last upload was refused; the server keeps every earlier one.
      this.account = null;
      this.rating = null;
      this.records = { vs: {} };
      saveRecords(this.records);
      if (this.screen === "menu") this.showMenu(false);
    });
    block.append(
      el("p", { class: "account-label" }, "SIGNED IN AS"),
      el("p", { class: "account-name" }, this.account),
      el("div", { class: "stats" }, stat("40L PB", sprint), stat("BLITZ PB", blitz), stat("BOT W–L", vs)),
      signOutBtn,
      error,
    );
    return block;
  }

  private showAccount(): void {
    let kind: "login" | "register" = "login";
    const tab = (label: string) => el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, label);
    const loginTab = tab("SIGN IN");
    const registerTab = tab("REGISTER");
    const username = el("input", { name: "username", autocomplete: "username", maxlength: "16", spellcheck: "false", "data-nav": "" });
    const password = el("input", { name: "password", type: "password", maxlength: "128", "data-nav": "" });
    const error = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "ghost-btn primary", type: "submit", "data-nav": "" });
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, "← BACK");
    const select = (k: typeof kind) => {
      kind = k;
      loginTab.classList.toggle("primary", k === "login");
      registerTab.classList.toggle("primary", k === "register");
      loginTab.setAttribute("aria-pressed", String(k === "login"));
      registerTab.setAttribute("aria-pressed", String(k === "register"));
      submit.textContent = k === "login" ? "LOG IN →" : "CREATE ACCOUNT →";
      password.autocomplete = k === "login" ? "current-password" : "new-password";
      error.textContent = "";
    };
    select("login");
    loginTab.addEventListener("click", () => select("login"));
    registerTab.addEventListener("click", () => select("register"));
    back.addEventListener("click", () => this.showMenu());
    const form = el("form", { class: "account-form", novalidate: "" },
      el("div", { class: "tabs" }, loginTab, registerTab),
      el("label", { class: "field" }, el("span", {}, "USERNAME"), username),
      el("label", { class: "field" }, el("span", {}, "PASSWORD"), password),
      error,
      el("div", { class: "actions" }, submit, back),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const invalid = usernameError(username.value) ?? passwordError(password.value);
      if (invalid) {
        error.textContent = invalid;
        return;
      }
      error.textContent = "";
      submit.disabled = true;
      const result = await signIn(kind, username.value, password.value);
      submit.disabled = false;
      if (this.screen !== "account") return;
      if (typeof result === "string") {
        error.textContent = result;
        return;
      }
      sfx.confirm();
      this.adoptProfile(result);
      this.showMenu();
    });
    const page = this.subPage("ACCOUNT", "Sign in to keep your personal bests and bot record with you. Playing without an account works the same.",
      form,
      el("footer", { class: "hint" }, "ENTER to submit · ESC to go back"),
    );
    this.setScreen("account", page);
  }

  private showBots(): void {
    const r = this.records.vs;
    const bars = BOT_PROFILES.map((p, i) => {
      const rec = r[p.name];
      return this.bar({
        accent: ["#3a7d5c", "#2f6db5", "#a33a8f", "#d23048"][i], title: p.name,
        tagline: `${p.pps.toFixed(1)} pieces per second${p.spins ? " · uses spins" : ""}`,
        glyph: `${p.pps.toFixed(1)}`, meta: rec ? `${rec.wins}W – ${rec.losses}L` : "—", index: i,
        onClick: () => this.startSession("vs", p),
      });
    });
    // online: the same bars, then the answer when there is no game server here
    const unavailable = el("p", { class: "form-error", role: "alert" });
    const online = async (open: () => Promise<boolean>) => {
      unavailable.textContent = "";
      if (!(await open()) && this.screen === "bots") unavailable.textContent = UNAVAILABLE;
    };
    bars.push(
      this.bar({
        accent: "#e0337a", title: "CREATE ROOM", tagline: "Play a friend online: get a code to send them.",
        glyph: "1V1", meta: "ONLINE", index: bars.length, onClick: () => void online(() => this.createRoom()),
      }),
      this.bar({
        accent: "#7a3fe0", title: "JOIN ROOM", tagline: "Enter the 6-letter code a friend sent you.",
        glyph: "CODE", meta: "ONLINE", index: bars.length + 1, onClick: () => void online(() => this.showJoin()),
      }),
      // "RANKED 1V1", not "RANKED": that is a bot's name (its records are kept under it)
      this.bar({
        accent: "#e07a1f", title: "RANKED 1V1", tagline: "Signed in: a player near your TR.",
        glyph: "TR", meta: "ONLINE", index: bars.length + 2, onClick: () => void (async () => {
          unavailable.textContent = "";
          const joined = await this.startQueue();
          if (this.screen !== "bots") return;
          if (joined === "signed-out") unavailable.textContent = SIGN_IN_FOR_RANKED;
          else if (joined === "unavailable") unavailable.textContent = UNAVAILABLE;
        })(),
      }),
      this.bar({
        accent: "#c9a227", title: "LEADERBOARD", tagline: "The top 50 ranked players by TR.",
        glyph: "#1", index: bars.length + 3, onClick: () => this.showLeaderboard(),
      }),
    );
    const page = this.subPage("VERSUS", "Pick an opponent. First to top out loses.",
      el("nav", { class: "bars dense" }, ...bars),
      unavailable,
      el("footer", { class: "hint" }, "ESC to go back"),
    );
    this.setScreen("bots", page);
  }

  // ------------------------------------------------------------------ online rooms

  /**
   * The thin WebSocket adapter for the online client: a same-origin URL (behind the zone's rate
   * limit), never a fixed host.
   */
  private connect(code: string, mode: "create" | "join" | "ranked"): OnlineClient {
    const url = new URL(`/api/match/${code}?mode=${mode}`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    const client = new OnlineClient({
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(1000, "left"),
    }, () => performance.now());
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") client.receive(e.data);
    });
    ws.addEventListener("close", () => client.closed());
    this.room = client;
    return client;
  }

  private leaveRoom(): void {
    this.room?.leave();
    this.room = null;
  }

  /** Stop searching (the server is told), and drop a ranked room's socket that hasn't started. */
  private cancelQueue(): void {
    this.queue?.stop();
    this.queue = null;
    void leaveQueue();
    this.leaveRoom();
  }

  /**
   * RANKED MATCH: enter the queue and show the search. Signed out or without a game server, no page.
   * On a cooldown the queue screen says so instead of searching.
   */
  private async startQueue(): Promise<"waiting" | "signed-out" | "unavailable"> {
    if (this.queue) return "waiting";
    const joined = await joinQueue();
    if (typeof joined === "object") {
      if (this.screen === "bots") this.showQueue(joined);
      return "waiting";
    }
    if (joined !== "waiting") return joined;
    if (this.screen !== "bots") {
      void leaveQueue(); // left the page meanwhile
      return joined;
    }
    this.showQueue();
    return joined;
  }

  /**
   * The search: elapsed time, the TR range the server accepts now, our own TR. Polls the queue every
   * QUEUE_POLL_MS (the poll is the keep-alive); on `matched` opens the ranked socket like a room.
   * With `cooldown` (the server refused the join) it only says when searching is possible again.
   */
  private showQueue(cooldown?: Cooldown): void {
    const shownAt = performance.now();
    const stat = (label: string, value: HTMLElement) => el("div", { class: "stat" }, el("span", {}, label), value);
    const elapsed = el("p", { class: "room-code", role: "timer", "aria-label": "Time searching" }, "0:00");
    const range = el("strong", {}, formatRange(INITIAL_RANGE));
    const tr = el("strong", {}, "…");
    const status = el("p", { class: "note", role: "status" }, "Searching for an opponent… (ESC to cancel)");
    const error = el("p", { class: "form-error", role: "alert" });
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, cooldown ? "← BACK" : "← CANCEL");
    back.addEventListener("click", () => {
      this.cancelQueue();
      this.showBots();
    });
    const page = this.subPage("RANKED", "Matched by TR with another signed-in player. The accepted range widens every 10 seconds.",
      cooldown
        ? el("section", { class: "account-form room queue" },
          el("p", { class: "account-label" }, "NOT SEARCHING"),
          error,
          el("div", { class: "actions" }, back),
        )
        : el("section", { class: "account-form room queue" },
          el("p", { class: "account-label" }, "SEARCHING"),
          elapsed,
          el("div", { class: "stats" }, stat("RANGE", range), stat("YOUR TR", tr)),
          status,
          error,
          el("div", { class: "actions" }, back),
        ),
      el("footer", { class: "hint" }, cooldown ? "ESC to go back" : "ESC to cancel"),
    );
    this.setScreen("queue", page);
    if (cooldown) {
      error.textContent = cooldownText(cooldown);
      return;
    }

    let timer = 0;
    const ticker = window.setInterval(() => {
      const s = Math.floor((performance.now() - shownAt) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
    const handle = {
      stop: () => {
        window.clearInterval(ticker);
        window.clearTimeout(timer);
      },
    };
    this.queue = handle;
    const live = () => this.queue === handle;
    const end = (message: string) => {
      handle.stop();
      this.queue = null;
      status.textContent = "";
      error.textContent = message;
    };
    const showTR = () => (tr.textContent = !this.rating ? "—" : this.rating.tr === null ? "TR HIDDEN" : `TR ${this.rating.tr.toLocaleString("en-US")}`);
    void fetchMe().then((p) => {
      if (p) this.rating = p.rating;
      if (live()) showTR();
    });

    const poll = async () => {
      let state = await queueStatus();
      if (!live()) return;
      if (state !== null && state !== "signed-out" && state.status === "none") {
        // dropped (this tab slept past the keep-alive, say): enter again
        const again = await joinQueue();
        if (!live()) return;
        if (typeof again === "object") return end(cooldownText(again));
        state = again === "signed-out" ? again : again === "waiting" ? { status: "waiting", waited: 0, range: INITIAL_RANGE } : null;
      }
      if (state === "signed-out") return end(`${SIGN_IN_FOR_RANKED}. Your session has ended.`);
      if (state === null) status.textContent = "Can't reach the server. Still trying…";
      else if (state.status === "waiting") {
        range.textContent = formatRange(state.range);
        status.textContent = "Searching for an opponent… (ESC to cancel)";
      } else if (state.status === "matched") {
        if (!ROOM_CODE.test(state.code)) return end("The match server answered strangely. Go back and search again.");
        handle.stop();
        this.queue = null;
        status.textContent = "Opponent found. Starting…";
        const client = this.connect(state.code, "ranked");
        client.events = {
          start: () => this.startOnline(client),
          closed: () => {
            if (this.room !== client) return;
            this.room = null;
            status.textContent = "";
            error.textContent = client.lastError?.code === "no-opponent"
              ? "Your opponent never arrived. Go back and search again."
              : "Couldn't join the ranked match. Go back and search again.";
          },
        };
        return;
      }
      timer = window.setTimeout(() => void poll(), QUEUE_POLL_MS);
    };
    void poll();
  }

  // ------------------------------------------------------------------ leaderboard and profiles

  /**
   * LEADERBOARD: the top players by TR, each row opening their PROFILE. `players` (the list as last
   * fetched) shows at once; without it the list is fetched. Server text only ever goes in as text.
   */
  private showLeaderboard(players: LeaderboardPlayer[] | null = null): void {
    const list = el("ol", { class: "ladder", "aria-label": "Top players by TR" });
    const status = el("p", { class: "note", role: "status" });
    const error = el("p", { class: "form-error", role: "alert" });
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => this.showBots());
    const hint = el("footer", { class: "hint" }, "ESC to go back");
    const page = this.subPage("LEADERBOARD", "Calibrated ranked players by TR. Only rated ranked matches count here.",
      el("section", { class: "account-form room ladder-box" },
        el("p", { class: "account-label" }, "TOP 50"),
        list,
        status,
        error,
        el("div", { class: "actions" }, back),
      ),
      hint,
    );
    const fill = (rows: LeaderboardPlayer[]) => {
      this.ladder = rows;
      hint.textContent = rows.length ? "ENTER for a profile · ESC to go back" : "ESC to go back";
      status.textContent = rows.length ? "" : NO_PLAYERS;
      list.hidden = rows.length === 0;
      list.replaceChildren(...rows.map((p) => {
        const row = el("button", { class: "ladder-row", type: "button", "data-nav": "" },
          el("span", { class: "ladder-rank" }, `#${p.rank}`),
          el("span", { class: "ladder-name" }, p.username),
          el("span", { class: "ladder-tr" }, trText(p.tr)),
          el("span", { class: "ladder-games" }, `${p.games} GAMES`),
        );
        row.addEventListener("click", () => {
          sfx.confirm();
          this.showProfile(p.username);
        });
        row.addEventListener("mouseenter", () => sfx.menu());
        return el("li", {}, row);
      }));
    };
    this.setScreen("leaderboard", page);
    if (players) {
      fill(players);
      list.querySelector<HTMLElement>("[data-nav]")?.focus();
      return;
    }
    list.hidden = true;
    status.textContent = "Loading…";
    void fetchLeaderboard().then((rows) => {
      if (!page.isConnected) return; // left the page meanwhile
      if (!rows) {
        status.textContent = "";
        error.textContent = UNAVAILABLE;
        return;
      }
      const focused = document.activeElement === back;
      fill(rows);
      if (focused) list.querySelector<HTMLElement>("[data-nav]")?.focus();
    });
  }

  /** PROFILE: a player's public ranked numbers. BACK returns to the LEADERBOARD. */
  private showProfile(username: string): void {
    const stat = (label: string, value: HTMLElement) => el("div", { class: "stat" }, el("span", {}, label), value);
    const rank = el("strong", {}, "…");
    const tr = el("strong", {}, "…");
    const games = el("strong", {}, "…");
    const joined = el("strong", {}, "…");
    const name = el("p", { class: "account-name" }, username);
    const status = el("p", { class: "note", role: "status" }, "Loading…");
    const error = el("p", { class: "form-error", role: "alert" });
    // the values carry RANK and TR themselves (RANK #2, TR 12,345), so the labels say what they measure
    const stats = el("div", { class: "stats" }, stat("STANDING", rank), stat("RATING", tr), stat("RANKED GAMES", games), stat("JOINED", joined));
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => this.showLeaderboard(this.ladder));
    const page = this.subPage("PROFILE", "A player's ranked standing. Only rated ranked matches count here.",
      el("section", { class: "account-form room profile" },
        el("p", { class: "account-label" }, "PLAYER"),
        name,
        stats,
        status,
        error,
        el("div", { class: "actions" }, back),
      ),
      el("footer", { class: "hint" }, "ESC to go back"),
    );
    this.setScreen("profile", page);
    void fetchProfile(username).then((p) => {
      if (!page.isConnected) return;
      status.textContent = "";
      if (p === null || p === "not-found") {
        stats.remove();
        error.textContent = p === null ? UNAVAILABLE : NO_SUCH_PLAYER;
        return;
      }
      name.textContent = p.username;
      rank.textContent = p.rank === null ? "UNRANKED" : `RANK #${p.rank}`;
      tr.textContent = trText(p.rating.tr);
      games.textContent = p.rating.games.toLocaleString("en-US");
      joined.textContent = new Date(p.joined).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      if (p.rating.tr === null) status.textContent = "Placed on the leaderboard after calibration: TR shows after enough rated ranked matches.";
    });
  }

  /** The lobby screens (CREATE's code, JOIN's field): one box in the VERSUS layout. */
  private lobbyPage(title: string, lede: string, ...box: HTMLElement[]): void {
    const page = this.subPage(title, lede,
      el("section", { class: "account-form room" }, ...box),
      el("footer", { class: "hint" }, "ESC to cancel"),
    );
    this.setScreen("lobby", page);
  }

  /** CREATE ROOM: a code from the server, then wait on the socket for the opponent. False without a server. */
  private async createRoom(): Promise<boolean> {
    const code = await newRoom();
    if (!code) return false;
    if (this.screen !== "bots") return true; // left the page meanwhile
    const status = el("p", { class: "note", role: "status" }, "Waiting for opponent… (ESC to cancel)");
    const error = el("p", { class: "form-error", role: "alert" });
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => {
      this.leaveRoom();
      this.showBots();
    });
    this.lobbyPage("ONLINE", "Send this code to your opponent. The match starts as soon as they join.",
      el("p", { class: "account-label" }, "ROOM CODE"),
      el("p", { class: "room-code", "aria-label": code.split("").join(" ") }, code),
      status,
      error,
      el("div", { class: "actions" }, back),
    );
    const client = this.connect(code, "create");
    client.events = {
      start: () => this.startOnline(client),
      closed: () => {
        if (this.room !== client) return;
        this.room = null;
        status.textContent = "";
        error.textContent = client.lastError?.code === "no-opponent"
          ? "Nobody joined in time. Go back to open a new room."
          : client.slot === null ? "Couldn't open the room. Go back and try again." : "The connection to the room was lost.";
      },
    };
    return true;
  }

  /** JOIN ROOM: a field for the code. False (and no page) without a server. */
  private async showJoin(): Promise<boolean> {
    if (!(await onlineAvailable())) return false;
    if (this.screen !== "bots") return true;
    const input = el("input", {
      name: "room", maxlength: "6", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
      inputmode: "text", "aria-label": "Room code", "data-nav": "",
    });
    const error = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "ghost-btn primary", type: "submit", "data-nav": "" }, "JOIN →");
    const back = el("button", { class: "ghost-btn", type: "button", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => {
      this.leaveRoom();
      this.showBots();
    });
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    });
    const form = el("form", { novalidate: "" },
      el("label", { class: "field" }, el("span", {}, "ROOM CODE"), input),
      error,
      el("div", { class: "actions" }, submit, back),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.room) return; // already joining
      const code = input.value;
      // the alphabet has no 0, O, 1, I or L, so a code with one can't exist
      if (!ROOM_CODE.test(code)) {
        error.textContent = code.length === 6 ? "No such room" : "Room codes have 6 letters and digits";
        return;
      }
      error.textContent = "";
      submit.disabled = true;
      submit.textContent = "JOINING…";
      const client = this.connect(code, "join");
      client.events = {
        start: () => this.startOnline(client),
        closed: () => {
          if (this.room !== client) return;
          this.room = null;
          submit.disabled = false;
          submit.textContent = "JOIN →";
          // a refused upgrade (404) gives the page no status: no welcome and no error means no room
          const full = ["full", "busy", "resume-timeout", "ended"].includes(client.lastError?.code ?? "");
          error.textContent = full ? "Room is full" : client.slot === null ? "No such room" : "The connection to the room was lost.";
        },
      };
    });
    this.lobbyPage("JOIN", "Type the code your opponent sees on their screen, then press Enter.", form);
    input.focus();
    return true;
  }

  /** CONFIG opens at the top (header in view); a rebind redraws it at the scroll position it had. */
  private showConfig(scrollTop = 0): void {
    const s = this.settings;
    const save = () => {
      saveSettings(s);
      this.applySettings();
      this.syncMusic();
    };
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const out = el("output", {}, fmt(get()));
      const input = el("input", { type: "range", min: `${min}`, max: `${max}`, step: `${step}`, value: `${get()}` });
      input.addEventListener("input", () => {
        set(Number(input.value));
        out.textContent = fmt(get());
        save();
      });
      return el("label", { class: "row" }, el("span", {}, label), input, out);
    };
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const out = el("output", {}, get() ? "ON" : "OFF");
      const input = el("input", { type: "checkbox" });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        out.textContent = get() ? "ON" : "OFF";
        save();
      });
      return el("label", { class: "row" }, el("span", {}, label), input, out);
    };
    const pack = el("select", { name: "soundPack" });
    for (const p of SOUND_PACKS) pack.append(el("option", { value: p.id }, p.name));
    pack.value = s.soundPack;
    const packNote = el("output", {}, packById(s.soundPack).tagline);
    pack.addEventListener("change", () => {
      s.soundPack = pack.value;
      packNote.textContent = packById(s.soundPack).tagline;
      save();
      sfx.confirm(); // preview the new timbre
    });
    const packSelect = el("label", { class: "row" }, el("span", {}, "Sound pack"), pack, packNote);
    const track = el("select", { name: "musicTrack" });
    track.append(el("option", { value: "auto" }, "Auto"));
    for (const song of SONGS) track.append(el("option", { value: song.id }, song.name));
    track.append(el("option", { value: "off" }, "Off"));
    track.value = s.musicTrack;
    const trackLabel = () => {
      if (s.musicTrack === "off") return "No music";
      if (s.musicTrack === "auto") return "Per mode";
      return SONGS.find((x) => x.id === s.musicTrack)?.mood ?? "";
    };
    const trackNote = el("output", {}, trackLabel());
    track.addEventListener("change", () => {
      s.musicTrack = track.value;
      trackNote.textContent = trackLabel();
      save();
    });
    const trackSelect = el("label", { class: "row" }, el("span", {}, "Music track"), track, trackNote);
    const theme = el("select", { name: "theme" });
    for (const t of THEMES) theme.append(el("option", { value: t.id }, t.name));
    theme.value = s.theme;
    theme.addEventListener("change", () => {
      s.theme = theme.value;
      save();
      // redraw in the new theme where it was, the select still focused
      this.showConfig(this.root.querySelector(".config")?.scrollTop ?? 0);
      this.root.querySelector<HTMLElement>('select[name="theme"]')?.focus({ preventScroll: true });
    });
    const style = el("section", { class: "panel" },
      el("h2", {}, "STYLE"),
      el("label", { class: "row" }, el("span", {}, "Interface theme"), theme, el("output", {}, themeById(s.theme).tagline)),
    );
    const f = (v: number) => `${v.toFixed(1)}F · ${Math.round((v * 1000) / 60)}ms`;
    const handling = el("section", { class: "panel" },
      el("h2", {}, "HANDLING"),
      slider("ARR — auto repeat rate", 0, 5, 0.1, () => s.handling.arr, (v) => (s.handling.arr = v), f),
      slider("DAS — delayed auto shift", 1, 20, 0.1, () => s.handling.das, (v) => (s.handling.das = v), f),
      slider("DCD — DAS cut delay", 0, 20, 0.1, () => s.handling.dcd, (v) => (s.handling.dcd = v), f),
      slider("SDF — soft drop factor", 5, 41, 1, () => s.handling.sdf, (v) => (s.handling.sdf = v), (v) => (v >= 41 ? "∞" : `${v}×`)),
      toggle("IRS — initial rotation", () => s.handling.irs, (v) => (s.handling.irs = v)),
      toggle("IHS — initial hold", () => s.handling.ihs, (v) => (s.handling.ihs = v)),
    );
    const visual = el("section", { class: "panel" },
      el("h2", {}, "AUDIO & VISUAL"),
      slider("Sound effects", 0, 1, 0.05, () => s.volume, (v) => (s.volume = v), (v) => `${Math.round(v * 100)}%`),
      slider("Music", 0, 1, 0.05, () => s.musicVolume, (v) => (s.musicVolume = v), (v) => `${Math.round(v * 100)}%`),
      trackSelect,
      packSelect,
      slider("Board bounciness", 0, 2, 0.1, () => s.bounciness, (v) => (s.bounciness = v), (v) => `${Math.round(v * 100)}%`),
      toggle("Reduce motion", () => s.reduceMotion, (v) => (s.reduceMotion = v)),
      slider("Grid", 0, 0.4, 0.01, () => s.gridOpacity, (v) => (s.gridOpacity = v), (v) => `${Math.round(v * 100)}%`),
      slider("Ghost piece", 0, 0.8, 0.01, () => s.shadowOpacity, (v) => (s.shadowOpacity = v), (v) => `${Math.round(v * 100)}%`),
    );
    const keys = el("section", { class: "panel keys" }, el("h2", {}, "CONTROLS"));
    for (const bind of BIND_ORDER) {
      const row = el("div", { class: "row" }, el("span", {}, BIND_LABELS[bind]));
      for (let slot = 0; slot < 2; slot++) {
        const code = s.keys[bind][slot];
        const btn = el("button", { class: "key" }, code ? (this.poster ? keyLabel(code) : keyName(code)) : "—");
        btn.addEventListener("click", () => {
          if (this.listening) this.listening.btn.classList.remove("listening");
          this.listening = { bind, slot, btn };
          btn.textContent = "PRESS A KEY";
          btn.classList.add("listening");
        });
        row.append(btn);
      }
      keys.append(row);
    }
    keys.append(el("p", { class: "note" }, "Click a slot, then press a key. Backspace clears a slot."));
    const reset = el("button", { class: "ghost-btn", "data-nav": "" }, "RESET TO DEFAULTS");
    reset.addEventListener("click", () => {
      this.settings = defaultSettings();
      saveSettings(this.settings);
      this.applySettings();
      this.syncMusic();
      this.showConfig();
    });
    const back = el("button", { class: "ghost-btn", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => this.showMenu());
    const header = this.poster
      ? el("header", { class: "brand small" }, wordmark(), el("h1", {}, "CONFIG"))
      : el("header", { class: "brand small" }, el("h1", {}, el("span", {}, "CONFIG")));
    const page = el("div", { class: "config" },
      header,
      el("div", { class: "panels style" }, style), // its own row, so the three panels below keep their layout
      el("div", { class: "panels" }, handling, visual, keys),
      el("div", { class: "actions" }, back, reset),
    );
    this.setScreen("config", page);
    page.scrollTop = scrollTop; // focusing BACK, the first control, would scroll the header out of view
  }

  private finishListening(code: string): void {
    const l = this.listening!;
    this.listening = null;
    const keys = this.settings.keys;
    if (code !== "Backspace") {
      // a key can only do one thing
      for (const b of Object.keys(keys) as Bind[]) keys[b] = keys[b].filter((c) => c !== code);
      const slots = keys[l.bind];
      slots[l.slot] = code;
      keys[l.bind] = slots.filter(Boolean);
    } else {
      keys[l.bind] = keys[l.bind].filter((_, i) => i !== l.slot);
    }
    saveSettings(this.settings);
    this.showConfig(this.root.querySelector(".config")?.scrollTop ?? 0);
  }

  private showResults(): void {
    const s = this.session!;
    const g = s.player;
    const stat = (label: string, value: string) => el("div", { class: "stat" }, el("span", {}, label), el("strong", {}, value));
    let headline = "";
    let big = "";
    let badge = "";
    const stats: HTMLElement[] = [
      stat("PIECES", `${g.stats.pieces}`),
      stat("PPS", g.pps().toFixed(2)),
      stat("LINES", `${g.stats.lines}`),
      stat("KPP", g.stats.pieces ? (g.stats.inputs / g.stats.pieces).toFixed(2) : "—"),
      stat("FINESSE", `${g.stats.finesse}`),
    ];
    const run = { pps: g.pps(), apm: g.apm(), pieces: g.stats.pieces, date: Date.now() };
    let trLine: HTMLElement | "" = "";
    if (s.online) {
      // the server's word; online results are not records (no bot W-L, nothing sent to the account)
      const result = s.online.result ?? { outcome: "lost", reason: "connection" };
      [headline, big] = OUTCOME_TEXT[result.outcome];
      badge = `ONLINE · ${REASON_TEXT[result.reason] ?? result.reason.toUpperCase()}`;
      stats.splice(4, 1); // no finesse count: the online board runs the server's way
      stats.splice(2, 0, stat("APM", g.apm().toFixed(1)), stat("SENT", `${g.stats.sent}`));
      // ranked: the server's new TR for us, and its change when both TRs were visible
      const rating = result.rating;
      if (rating) {
        const delta = rating.delta === null ? "" : el("span", { class: "delta" }, rating.delta >= 0 ? `+${rating.delta}` : `-${-rating.delta}`);
        trLine = el("p", { class: "badge tr" }, rating.tr === null ? "TR HIDDEN" : `TR ${rating.tr.toLocaleString("en-US")}`, delta);
      }
    } else if (s.mode.id === "40l") {
      if (s.outcome === "clear") {
        const t = formatTime(g.frame);
        headline = "40 LINES CLEARED";
        big = `${t.main}${t.ms}`;
        const pb = this.records["40l"];
        if (!pb || g.frame < pb.value) {
          badge = pb ? `NEW PERSONAL BEST · −${((pb.value - g.frame) / 60).toFixed(3)}s` : "FIRST RECORD";
          this.records["40l"] = { value: g.frame, ...run };
          if (s.recorder) saveGhost(s.recorder.replay());
        } else {
          badge = `PB ${formatTime(pb.value).main}${formatTime(pb.value).ms}`;
        }
      } else {
        headline = "TOPPED OUT";
        big = `${g.stats.lines}/40`;
      }
    } else if (s.mode.id === "blitz") {
      headline = s.outcome === "clear" ? "TIME'S UP" : "TOPPED OUT";
      big = g.stats.score.toLocaleString("en-US");
      stats.push(stat("LEVEL", `${g.stats.level}`));
      const pb = this.records.blitz;
      if (s.outcome === "clear" && (!pb || g.stats.score > pb.value)) {
        badge = pb ? `NEW PERSONAL BEST · +${(g.stats.score - pb.value).toLocaleString("en-US")}` : "FIRST RECORD";
        this.records.blitz = { value: g.stats.score, ...run };
      } else if (pb) badge = `PB ${pb.value.toLocaleString("en-US")}`;
    } else if (s.mode.id === "vs") {
      const won = s.outcome === "win";
      headline = won ? "VICTORY" : "DEFEAT";
      big = won ? "YOU WIN" : "YOU LOSE";
      const name = s.botProfile!.name;
      const rec = (this.records.vs[name] ??= { wins: 0, losses: 0 });
      if (won) rec.wins++;
      else rec.losses++;
      badge = `vs ${name} BOT · ${rec.wins}W – ${rec.losses}L`;
      stats.splice(2, 0, stat("APM", g.apm().toFixed(1)), stat("SENT", `${g.stats.sent}`));
      if (s.bot) stats.push(stat("BOT APM", s.bot.apm().toFixed(1)));
    }
    if (!s.online) {
      saveRecords(this.records);
      if (this.account) void putRecords(this.records);
    }
    const retry = el("button", { class: "ghost-btn primary", "data-nav": "" }, s.mode.id === "vs" ? "REMATCH  ·  R" : "RETRY  ·  R");
    retry.addEventListener("click", () => this.retry());
    const back = el("button", { class: s.online ? "ghost-btn primary" : "ghost-btn", "data-nav": "" }, "MENU  ·  ESC");
    back.addEventListener("click", () => this.exitToMenu());
    const page = el("div", { class: "results", style: `--accent:${s.mode.accent}` },
      el("p", { class: "headline" }, headline),
      el("p", { class: "big" }, big),
      badge ? el("p", { class: "badge" }, badge) : "",
      trLine,
      el("div", { class: "stats" }, ...stats),
      el("div", { class: "actions" }, ...(s.online ? [back] : [retry, back])),
    );
    this.resultsShownAt = performance.now();
    this.setScreen("results", page);
  }
}
