import { Bot, BOT_PROFILES, BotProfile } from "../ai/bot";
import { sfx } from "../audio/sfx";
import { Action, Game, GameEvent } from "../engine/game";
import { MODES, Mode, ModeId, modeById } from "../modes";
import { mergeRecords, passwordError, usernameError } from "../profile";
import { BoardView, formatTime, Renderer } from "../render/renderer";
import { BIND_LABELS, BIND_ORDER, Bind, Records, Settings, defaultSettings, loadRecords, loadSettings, saveRecords, saveSettings } from "../settings";
import { Profile, fetchMe, putRecords, signIn, signOut } from "./account";

type Screen = "menu" | "bots" | "config" | "account" | "play" | "results";

const GAME_ACTIONS: Action[] = ["left", "right", "soft", "hard", "cw", "ccw", "180", "hold"];
const COUNTDOWN = [
  { at: 0, text: "READY" },
  { at: 0.75, text: "SET" },
  { at: 1.5, text: "GO!" },
];
const START_AT = 1.5;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
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
  t: number; // seconds since session start (countdown included)
  started: boolean;
  last: number; // performance.now() of last sim advance
  endAt: number | null; // when to show results
  outcome: "win" | "lose" | "clear" | "fail" | null;
}

export class App {
  private settings: Settings = loadSettings();
  private records: Records = loadRecords();
  private account: string | null = null; // signed-in username
  private renderer: Renderer;
  private root: HTMLElement;
  private screen: Screen = "menu";
  private session: Session | null = null;
  private held = new Set<Bind>();
  private listening: { bind: Bind; slot: number; btn: HTMLButtonElement } | null = null;
  private lastFrame = performance.now();
  private resultsShownAt = 0;

  constructor(canvas: HTMLCanvasElement, root: HTMLElement) {
    this.renderer = new Renderer(canvas);
    this.root = root;
    this.applySettings();
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    window.addEventListener("blur", () => {
      this.held.clear();
      this.session?.player.releaseAll();
    });
    window.addEventListener("pointerdown", () => sfx.unlock(), { once: false });
    this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
    void fetchMe().then((p) => p && this.adoptProfile(p));
  }

  /** Signed in: merge local and server records (better wins), keep the result in both places. */
  private adoptProfile(p: Profile): void {
    this.account = p.username;
    this.records = mergeRecords(this.records, p.records);
    saveRecords(this.records);
    void putRecords(this.records);
    if (this.screen === "menu") this.showMenu();
  }

  private applySettings(): void {
    sfx.volume = this.settings.volume;
    this.renderer.gridOpacity = this.settings.gridOpacity;
    this.renderer.shadowOpacity = this.settings.shadowOpacity;
    for (const v of this.renderer.views) v.bounciness = this.settings.bounciness;
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
    for (const b of this.held) if ((GAME_ACTIONS as string[]).includes(b)) s.player.press(b as Action);
  }

  /** Bring the simulation up to `now` so an input lands at the right sub-frame. */
  private advanceTo(now: number): void {
    const s = this.session;
    if (!s || !s.started) return;
    const dt = Math.min(0.25, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    if (s.endAt !== null) return;
    const frames = dt * 60;
    s.player.advance(frames);
    if (s.bot && s.botAI && s.botProfile) {
      s.bot.advance(frames);
      s.botAcc += dt;
      const interval = 1 / s.botProfile.pps;
      while (s.botAcc >= interval && !s.bot.over) {
        s.botAcc -= interval;
        s.botAI.playPiece();
      }
    }
  }

  // ------------------------------------------------------------------ sessions

  private startSession(modeId: ModeId, profile: BotProfile | null = null): void {
    const mode = modeById(modeId);
    const seed = Math.floor(Math.random() * 2147483646) + 1;
    const player = new Game(mode.options(seed), this.settings.handling);
    const playerView = new BoardView(player, {
      accent: mode.accent, mode: mode.id, objectiveLines: 40, label: mode.id === "vs" ? "YOU" : undefined,
    });
    let bot: Game | null = null;
    let botView: BoardView | null = null;
    let botAI: Bot | null = null;
    if (mode.id === "vs" && profile) {
      bot = new Game(mode.options(seed));
      botView = new BoardView(bot, { accent: mode.accent, mode: "vs", label: `${profile.name} BOT`, compact: true });
      botAI = new Bot(bot, profile);
    }
    this.session = {
      mode, seed, player, playerView, bot, botView, botAI, botProfile: profile, botAcc: 0,
      t: 0, started: false, last: performance.now(), endAt: null, outcome: null,
    };
    this.renderer.accent = mode.accent;
    this.renderer.views = botView ? [playerView, botView] : [playerView];
    this.renderer.flights = [];
    this.renderer.overlay = { countdown: null, countdownT: 0 };
    this.renderer.layoutViews();
    this.applySettings();
    this.wireSounds(player, true);
    if (bot) this.wireSounds(bot, false);
    if (bot && botView) {
      player.onAttack = (n) => this.sendAttack(playerView, botView!, bot!, n);
      bot.onAttack = (n) => this.sendAttack(botView!, playerView, player, n);
    }
    player.on((e) => this.onPlayerEvent(e));
    bot?.on((e) => {
      if (e.type === "topout") this.endSession("win");
    });
    this.setScreen("play");
  }

  private sendAttack(from: BoardView, to: BoardView, target: Game, n: number): void {
    this.renderer.flights.push({
      from: this.renderer.boardCentre(from),
      to: this.renderer.meterPoint(to),
      t: 0,
      dur: target.opts.garbagespeed / 60,
      amount: n,
      color: n >= 6 ? "#ff3fa4" : "#ff7a3c",
    });
    target.receive(n);
  }

  private wireSounds(game: Game, loud: boolean): void {
    game.on((e) => {
      if (!loud && !["clear", "garbage-tank", "topout"].includes(e.type)) return;
      switch (e.type) {
        case "move": sfx.move(); break;
        case "wall": break;
        case "rotate": if (e.spin !== "none") sfx.spin(); else sfx.rotate(); break;
        case "hold": sfx.hold(); break;
        case "harddrop": sfx.harddrop(); break;
        case "clear":
          sfx.clear(e.info.lines, e.info.spin !== "none", e.info.combo, e.info.btb);
          if (e.info.allClear) sfx.allClear();
          if (e.info.btbBroken >= 2) sfx.btbBreak();
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
    if (outcome === "win") {
      s.botView!.bigText = { text: "K.O.", t: 0, color: "#ff3f5f" };
      sfx.finish();
    }
  }

  private retry(): void {
    const s = this.session;
    if (!s) return;
    this.startSession(s.mode.id, s.botProfile);
  }

  private exitToMenu(): void {
    this.session = null;
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
    sfx.unlock();
    if (this.listening) {
      e.preventDefault();
      this.finishListening(e.code);
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
        this.advanceTo(performance.now());
        s.player.press(bind as Action);
      }
      return;
    }
    if (this.screen === "results") {
      const bind = this.bindFor(e.code);
      // Game keys (e.g. spamming hard drop after a top-out) must never activate a button.
      if (bind || e.code === "Enter" || e.code === "Space") e.preventDefault();
      if (performance.now() < this.resultsShownAt + 600) return;
      if (bind === "retry" || e.code === "Enter") {
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
      if (this.screen !== "menu") {
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
      this.advanceTo(performance.now());
      s.player.release(bind as Action);
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
      sfx.unlock();
      sfx.confirm();
      opts.onClick();
    });
    b.addEventListener("mouseenter", () => sfx.menu());
    return b;
  }

  private showMenu(): void {
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
      accent: "#3b3b4a", title: "CONFIG", tagline: "Handling, controls, audio, visuals.", glyph: "⚙", index: MODES.length,
      onClick: () => this.showConfig(),
    }));
    const page = el("div", { class: "menu" },
      el("header", { class: "brand" },
        el("h1", {}, el("span", {}, "TE"), el("span", { class: "slash" }, "ZA")),
        el("p", {}, "Tetris + cheza — Swahili for play. SRS+, 180 kicks, 7-bag, B2B chaining, with mechanics matched to the modern online stacker."),
      ),
      el("nav", { class: "bars" }, ...bars),
      this.accountBlock(sprint ?? "—", blitz ?? "—", `${w}W – ${l}L`),
      el("footer", { class: "hint" }, "↑ ↓ to choose · ENTER to play · ESC to go back"),
    );
    this.setScreen("menu", page);
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
    signOutBtn.addEventListener("click", async () => {
      signOutBtn.disabled = true;
      await signOut();
      this.account = null;
      if (this.screen === "menu") this.showMenu();
    });
    block.append(
      el("p", { class: "account-label" }, "SIGNED IN AS"),
      el("p", { class: "account-name" }, this.account),
      el("div", { class: "stats" }, stat("40L PB", sprint), stat("BLITZ PB", blitz), stat("BOT W–L", vs)),
      signOutBtn,
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
      submit.textContent = k === "login" ? "SIGN IN" : "CREATE ACCOUNT";
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
    const page = el("div", { class: "menu" },
      el("header", { class: "brand small" },
        el("h1", {}, el("span", {}, "ACCOUNT")),
        el("p", {}, "Sign in to keep your personal bests and bot record with you. Playing without an account works the same."),
      ),
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
    const page = el("div", { class: "menu" },
      el("header", { class: "brand small" }, el("h1", {}, el("span", {}, "VERSUS")), el("p", {}, "Pick an opponent. First to top out loses.")),
      el("nav", { class: "bars" }, ...bars),
      el("footer", { class: "hint" }, "ESC to go back"),
    );
    this.setScreen("bots", page);
  }

  private showConfig(): void {
    const s = this.settings;
    const save = () => {
      saveSettings(s);
      this.applySettings();
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
    const f = (v: number) => `${v.toFixed(1)}F · ${Math.round((v * 1000) / 60)}ms`;
    const handling = el("section", { class: "panel" },
      el("h2", {}, "HANDLING"),
      slider("ARR — auto repeat rate", 0, 5, 0.1, () => s.handling.arr, (v) => (s.handling.arr = v), f),
      slider("DAS — delayed auto shift", 1, 20, 0.1, () => s.handling.das, (v) => (s.handling.das = v), f),
      slider("DCD — DAS cut delay", 0, 20, 0.1, () => s.handling.dcd, (v) => (s.handling.dcd = v), f),
      slider("SDF — soft drop factor", 5, 41, 1, () => s.handling.sdf, (v) => (s.handling.sdf = v), (v) => (v >= 41 ? "∞" : `${v}×`)),
    );
    const visual = el("section", { class: "panel" },
      el("h2", {}, "AUDIO & VISUAL"),
      slider("Sound effects", 0, 1, 0.05, () => s.volume, (v) => (s.volume = v), (v) => `${Math.round(v * 100)}%`),
      slider("Board bounciness", 0, 2, 0.1, () => s.bounciness, (v) => (s.bounciness = v), (v) => `${Math.round(v * 100)}%`),
      slider("Grid", 0, 0.4, 0.01, () => s.gridOpacity, (v) => (s.gridOpacity = v), (v) => `${Math.round(v * 100)}%`),
      slider("Ghost piece", 0, 0.8, 0.01, () => s.shadowOpacity, (v) => (s.shadowOpacity = v), (v) => `${Math.round(v * 100)}%`),
    );
    const keys = el("section", { class: "panel keys" }, el("h2", {}, "CONTROLS"));
    for (const bind of BIND_ORDER) {
      const row = el("div", { class: "row" }, el("span", {}, BIND_LABELS[bind]));
      for (let slot = 0; slot < 2; slot++) {
        const code = s.keys[bind][slot];
        const btn = el("button", { class: "key" }, code ? keyName(code) : "—");
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
      this.showConfig();
    });
    const back = el("button", { class: "ghost-btn", "data-nav": "" }, "← BACK");
    back.addEventListener("click", () => this.showMenu());
    const page = el("div", { class: "config" },
      el("header", { class: "brand small" }, el("h1", {}, el("span", {}, "CONFIG"))),
      el("div", { class: "panels" }, handling, visual, keys),
      el("div", { class: "actions" }, back, reset),
    );
    this.setScreen("config", page);
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
    this.showConfig();
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
    ];
    const run = { pps: g.pps(), apm: g.apm(), pieces: g.stats.pieces, date: Date.now() };
    if (s.mode.id === "40l") {
      if (s.outcome === "clear") {
        const t = formatTime(g.frame);
        headline = "40 LINES CLEARED";
        big = `${t.main}${t.ms}`;
        const pb = this.records["40l"];
        if (!pb || g.frame < pb.value) {
          badge = pb ? `NEW PERSONAL BEST · −${((pb.value - g.frame) / 60).toFixed(3)}s` : "FIRST RECORD";
          this.records["40l"] = { value: g.frame, ...run };
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
    saveRecords(this.records);
    if (this.account) void putRecords(this.records);
    const retry = el("button", { class: "ghost-btn primary", "data-nav": "" }, s.mode.id === "vs" ? "REMATCH  ·  R" : "RETRY  ·  R");
    retry.addEventListener("click", () => this.retry());
    const back = el("button", { class: "ghost-btn", "data-nav": "" }, "MENU  ·  ESC");
    back.addEventListener("click", () => this.exitToMenu());
    const page = el("div", { class: "results", style: `--accent:${s.mode.accent}` },
      el("p", { class: "headline" }, headline),
      el("p", { class: "big" }, big),
      badge ? el("p", { class: "badge" }, badge) : "",
      el("div", { class: "stats" }, ...stats),
      el("div", { class: "actions" }, retry, back),
    );
    this.resultsShownAt = performance.now();
    this.setScreen("results", page);
  }
}
