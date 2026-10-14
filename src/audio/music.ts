// Generative music: a look-ahead scheduler that plays a song (songs.ts) in stepped gears. Intensity
// picks the gear; each gear has its own tempo and arrangement, and a change lands on the next beat
// with a crash (up) or a falling sweep (down). Switching songs crossfades. Combos add melody.
// The exported functions above the Music class are pure (no Web Audio) so they can be unit-tested.
import { Scale, SoundPack, degreeFreq } from "./packs";
import { Gear, Song } from "./songs";
import { kick, noiseHit, voice } from "./synth";

/** Intensity at which each gear engages. A song with fewer gears stops at its last one. */
export const GEARS: { name: string; at: number }[] = [
  { name: "calm", at: 0 },
  { name: "groove", at: 0.15 },
  { name: "drive", at: 0.4 },
  { name: "danger", at: 0.7 },
];
/** Hysteresis: a gear holds until intensity falls this far below its threshold. */
export const GEAR_DROP = 0.08;

export const BLITZ_BOOST = 1.25; // tempo multiplier reached at Blitz time-up
export const BLITZ_RAMP_FRAMES = 30 * 60; // the boost ramps over the final 30 s
export const COMBO_CAP = 8; // melody length and register stop growing here

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The gear for `intensity`, given the gear playing now (`prev`) and the song's top gear (`max`). */
export function gearFor(intensity: number, prev = 0, max = GEARS.length - 1): number {
  let up = 0;
  let held = 0;
  GEARS.forEach((g, i) => {
    if (intensity >= g.at) up = i;
    if (intensity >= g.at - GEAR_DROP) held = i;
  });
  const gear = up >= prev ? up : Math.min(prev, held);
  return Math.min(gear, max);
}

/** Beats per minute of a song in a gear, times a tempo multiplier (Blitz's final 30 s). */
export function songTempo(song: Song, gear: number, boost = 1): number {
  return song.gears[Math.min(Math.max(0, gear), song.gears.length - 1)].bpm * boost;
}

/** Tempo multiplier for a timed run: 1 until 30 s remain, then a linear ramp to 1.25 at time-up. */
export function blitzBoost(elapsedFrames: number, totalFrames: number): number {
  const remaining = totalFrames - elapsedFrames;
  if (remaining >= BLITZ_RAMP_FRAMES) return 1;
  return 1 + (BLITZ_BOOST - 1) * clamp01(1 - remaining / BLITZ_RAMP_FRAMES);
}

/** What the music reacts to during a session. */
export interface PlayState {
  danger: number; // the renderer's danger, 0..1 (0 until the stack is ~15 rows)
  stackRows: number; // height of the player's stack, 0..20 visible rows
  garbage?: number; // incoming garbage rows not yet risen (Versus)
  combo: number; // on-screen combo ("N COMBO"), 0 when none
  boost: number; // blitzBoost(), 1 outside the final 30 s of Blitz
}

/**
 * Music intensity 0..1 (it picks the gear). The strongest of: danger; the stack height plus incoming
 * garbage at 0.05 per row (groove from 3 rows, drive from 8, danger from 14); a running combo; and
 * Blitz's final 30 s, which starts in drive and reaches danger with 15 s left. Empty and calm is 0.
 */
export function musicIntensity(s: PlayState): number {
  const stack = clamp01((s.stackRows + (s.garbage ?? 0)) / 20);
  const combo = s.combo > 0 ? Math.min(0.5, 0.1 * (s.combo + 1)) : 0;
  const blitz = s.boost > 1 ? 0.4 + 0.6 * clamp01((s.boost - 1) / (BLITZ_BOOST - 1)) : 0;
  return clamp01(Math.max(s.danger, stack, combo, blitz));
}

// Scale-degree offsets of a combo phrase; it starts higher and runs longer as the combo grows.
const PHRASE = [0, 2, 4, 2, 5, 4, 7, 6, 9, 7];

/** Melody note frequencies for a combo count (the "N COMBO" shown on screen). Empty for 0. */
export function comboNotes(combo: number, scale: Scale): number[] {
  if (combo < 1) return [];
  const c = Math.min(combo, COMBO_CAP);
  return PHRASE.slice(0, c + 2).map((d) => degreeFreq(scale, c - 1 + d));
}

// ------------------------------------------------------------------ engine

export interface MusicOutput {
  ctx: BaseAudioContext;
  bus: AudioNode;
  noise: AudioBuffer;
  pack: SoundPack;
  audible: boolean; // false when the music volume is 0: keep time but create no voices
}

const LOOKAHEAD = 0.1; // seconds scheduled ahead of ctx.currentTime
const TICK_MS = 25;

interface Run {
  song: Song;
  ctx: BaseAudioContext;
  fader: GainNode; // the whole song: fades in, and out on a crossfade
  pumped: GainNode; // everything but the drums, ducked by each kick
  drums: GainNode;
  melodyCh: GainNode;
  step: number; // 16th notes since the start
  next: number; // context time of `step`
  bpm: number;
  gear: number; // the gear playing
  target: number; // the gear asked for by update(); applied on the next beat
  boost: number;
  pack: SoundPack; // the pack of the current bar
  melody: number[]; // combo notes still to play, one per 16th
  melodyOn: boolean;
  endAt: number | null; // fading out: keep playing until this context time
}

/** The pattern character at `pos`, and how many 16ths until the pattern's next onset. */
function hit(pattern: string | undefined, pos: number): { c: string; len: number } | null {
  if (!pattern) return null;
  const n = pattern.length;
  const c = pattern[pos % n];
  if (c === ".") return null;
  let len = 1;
  while (len < n && pattern[(pos + len) % n] === ".") len++;
  return { c, len };
}

export class Music {
  private runs: Run[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private output: () => MusicOutput | null) {}

  /** The run that is playing (not fading out), if any. */
  private get run(): Run | null {
    const r = this.runs[this.runs.length - 1];
    return r && r.endAt === null ? r : null;
  }

  get playing(): boolean {
    return this.run !== null;
  }

  /** Current tempo, or 0 when stopped. */
  get bpm(): number {
    return this.run?.bpm ?? 0;
  }

  /** The gear playing, or -1 when stopped. */
  get gear(): number {
    return this.run?.gear ?? -1;
  }

  get song(): Song | null {
    return this.run?.song ?? null;
  }

  /** The playing song's scale (the SFX follow it so they stay in key). */
  get scale(): Scale | null {
    return this.run?.song.scale ?? null;
  }

  /**
   * Play `song`, crossfading over `fade` seconds from whatever is playing. Does nothing when that
   * song is already playing (unless `restart`), or while audio is still locked.
   * `timer: false` skips the interval so a caller can drive `pump()` itself (offline rendering).
   */
  play(song: Song, opts: { restart?: boolean; fade?: number; timer?: boolean } = {}): void {
    const cur = this.run;
    if (cur && cur.song === song && !opts.restart) return;
    const o = this.output();
    if (!o) return;
    const fade = opts.fade ?? 1.5;
    this.stop(fade);
    const ctx = o.ctx;
    const now = ctx.currentTime;
    const fader = ctx.createGain();
    fader.gain.setValueAtTime(0, now);
    fader.gain.linearRampToValueAtTime(1, now + Math.max(0.05, fade)); // linear in, like the fade out: no hole mid-crossfade
    fader.connect(o.bus);
    const node = (to: AudioNode, level = 1) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(to);
      return g;
    };
    const pumped = node(fader);
    this.runs.push({
      song, ctx, fader, pumped, drums: node(fader, song.drums), melodyCh: node(pumped, 0),
      step: 0, next: now + 0.05, bpm: songTempo(song, 0), gear: 0, target: 0, boost: 1,
      pack: o.pack, melody: [], melodyOn: false, endAt: null,
    });
    if (opts.timer !== false && this.timer === null) this.timer = setInterval(() => this.pump(), TICK_MS);
    this.pump();
  }

  /** Fade out over `fade` seconds. The song keeps playing under the fade, then its scheduler stops. */
  stop(fade = 0.8): void {
    const r = this.run;
    if (!r) return;
    const now = r.ctx.currentTime;
    r.endAt = now + fade;
    const g = r.fader.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
  }

  /** Per-frame input: musicIntensity() (0..1) and the tempo multiplier. */
  update(intensity: number, boost: number): void {
    const r = this.run;
    if (!r) return;
    r.target = gearFor(intensity, r.target, r.song.gears.length - 1);
    r.boost = boost;
  }

  /** A clear with an on-screen combo of `combo`: queue a phrase from the next 16th step. */
  combo(combo: number): void {
    const r = this.run;
    if (!r || combo < 1) return;
    r.melody = comboNotes(combo, r.song.scale);
    const g = r.melodyCh.gain;
    g.cancelScheduledValues(r.ctx.currentTime);
    g.setTargetAtTime(1, r.ctx.currentTime, 0.01);
    r.melodyOn = true;
  }

  /** The combo ended: drop the rest of the phrase and fade the melody. */
  endCombo(): void {
    const r = this.run;
    if (!r || !r.melodyOn) return;
    r.melodyOn = false;
    r.melody = [];
    const g = r.melodyCh.gain;
    g.cancelScheduledValues(r.ctx.currentTime);
    g.setTargetAtTime(0, r.ctx.currentTime, 0.06);
  }

  /** Schedule every 16th step that starts before `until` (default: now + look-ahead), for every run. */
  pump(until?: number): void {
    const o = this.output();
    for (const r of [...this.runs]) {
      if (r.endAt !== null && r.ctx.currentTime >= r.endAt) {
        r.fader.disconnect();
        this.runs.splice(this.runs.indexOf(r), 1);
        continue;
      }
      if (o) this.pumpRun(r, o, until ?? r.ctx.currentTime + LOOKAHEAD);
    }
    if (!this.runs.length && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pumpRun(r: Run, o: MusicOutput, until: number): void {
    const end = r.endAt === null ? until : Math.min(until, r.endAt);
    // Fell behind (e.g. a throttled background tab): skip the missed steps rather than burst them.
    if (r.next < r.ctx.currentTime) r.next = r.ctx.currentTime + 0.01;
    while (r.next < end) {
      const pos = r.step % 16;
      let shift = 0;
      if (pos % 4 === 0) {
        // gears and tempo move on the beat
        if (r.target !== r.gear) {
          shift = r.target > r.gear ? 1 : -1;
          r.gear = r.target;
        }
        r.bpm = songTempo(r.song, r.gear, r.boost);
      }
      if (pos === 0) r.pack = o.pack; // a pack switch lands on the next bar
      const d16 = 60 / r.bpm / 4;
      const t = r.next + (r.step % 2 === 1 ? r.song.swing * d16 : 0);
      const note = r.melody.shift();
      if (o.audible) {
        if (shift) this.gearShift(r, o.noise, t, shift);
        this.playStep(r, o.noise, t, d16);
        if (note) voice(r.ctx, r.melodyCh, r.pack.music.lead, note, t, d16 * 1.8, { gain: 0.12, attack: 0.003 });
      }
      r.step++;
      r.next += d16;
    }
  }

  /** The audible gear step: a crash going up, a falling filtered sweep going down. */
  private gearShift(r: Run, noise: AudioBuffer, t: number, dir: number): void {
    if (dir > 0) {
      noiseHit(r.ctx, r.drums, noise, t, 1.4, { gain: 0.16, filter: 5000, type: "highpass" });
      kick(r.ctx, r.drums, noise, t, { gain: 0.5, from: 200, to: 40, dur: 0.5 });
    } else {
      noiseHit(r.ctx, r.drums, noise, t, 0.6, { gain: 0.14, filter: 4000, type: "bandpass", q: 2, sweep: 0.06 });
    }
  }

  private playStep(r: Run, noise: AudioBuffer, t: number, d16: number): void {
    const { ctx, song } = r;
    const g: Gear = song.gears[r.gear];
    const m = r.pack.music;
    const s = song.scale;
    const pos = r.step % 16;
    const bar = Math.floor(r.step / 16);
    const root = song.progression[bar % song.progression.length];
    const bright = m.brightness * song.tone;
    const deg = (c: string) => root + Number(c);

    const k = hit(g.kick, pos);
    if (k) {
      kick(ctx, r.drums, noise, t, { gain: k.c === "X" ? 0.75 : 0.6, click: 0.12 });
      if (g.pump) {
        // sidechain: everything but the drums dips under the kick and swells back
        r.pumped.gain.setValueAtTime(1 - g.pump, t);
        r.pumped.gain.setTargetAtTime(1, t + 0.02, d16 * 0.7);
      }
    }
    const sn = hit(g.snare, pos);
    if (sn) {
      const acc = sn.c === "X" ? 1.3 : 1;
      noiseHit(ctx, r.drums, noise, t, 0.17, { gain: 0.32 * acc, filter: 1800, type: "bandpass", q: 0.7 });
      voice(ctx, r.drums, { type: "triangle", detune: 0, fm: 0 }, 190, t, 0.09, { gain: 0.18 * acc, attack: 0.001, slide: 0.6 });
    }
    const h = hit(g.hat, pos);
    if (h) noiseHit(ctx, r.drums, noise, t, h.c === "X" ? 0.08 : 0.035, { gain: h.c === "X" ? 0.13 : 0.07, filter: 7500, type: "highpass" });

    const p = hit(g.pad, pos);
    if (p) {
      for (const c of song.chord) {
        voice(ctx, r.pumped, m.pad, degreeFreq(s, root + c, -1), t, d16 * (p.len + 1), {
          gain: 0.075, attack: Math.min(m.padAttack, d16 * p.len * 0.3), release: d16 * Math.min(4, p.len * 0.5), filter: bright,
        });
      }
    }
    const b = hit(g.bass, pos);
    if (b) {
      const f = degreeFreq(s, deg(b.c), -2);
      const dur = d16 * b.len * 0.9;
      voice(ctx, r.pumped, m.bass, f, t, dur, { gain: m.bassGain * 1.6, attack: 0.002, filter: bright * 0.8, pluck: 4, q: 2 });
      voice(ctx, r.pumped, { type: "sine", detune: 0, fm: 0 }, f, t, dur, { gain: 0.16, attack: 0.003 }); // sub
    }
    const a = hit(g.arp, pos);
    if (a) voice(ctx, r.pumped, m.arp, degreeFreq(s, deg(a.c)), t, d16 * Math.min(a.len, 2) * 0.8, { gain: 0.05, attack: 0.002, filter: bright * 2, pluck: 3 });
    const l = hit(g.lead, pos);
    if (l) voice(ctx, r.pumped, m.lead, degreeFreq(s, deg(l.c), 1), t, d16 * l.len * 0.95, { gain: 0.06, attack: 0.02, release: d16 * 2 });
  }
}
