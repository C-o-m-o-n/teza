// Generative session music: a look-ahead scheduler playing a looping chord progression in the
// sound pack's scale. Layers fade in with the player's danger, tempo follows it, combos add melody.
// The exported functions above the Music class are pure (no Web Audio) so they can be unit-tested.
import { Scale, SoundPack, Timbre, degreeFreq } from "./packs";
import { noiseHit, voice } from "./synth";

export type LayerId = "pad" | "bass" | "arp" | "lead";

/** Danger at which each layer fades in. The pad always plays. */
export const LAYERS: { id: LayerId; at: number }[] = [
  { id: "pad", at: 0 },
  { id: "bass", at: 0.15 }, // bass + kick pulse
  { id: "arp", at: 0.4 }, // arpeggio + hi-hats
  { id: "lead", at: 0.7 }, // tension lead
];

export const BPM_MIN = 100; // at danger 0
export const BPM_MAX = 150; // at danger 1
export const BLITZ_BOOST = 1.25; // tempo multiplier reached at Blitz time-up
export const BLITZ_RAMP_FRAMES = 30 * 60; // the boost ramps over the final 30 s
export const COMBO_CAP = 8; // melody length and register stop growing here

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Beats per minute for a danger value (0..1) and a tempo multiplier. */
export function tempoFor(danger: number, blitzBoost = 1): number {
  return (BPM_MIN + (BPM_MAX - BPM_MIN) * clamp01(danger)) * blitzBoost;
}

/** Target gain (0..1) of each layer at a danger value. */
export function layerLevels(danger: number): Record<LayerId, number> {
  const out = {} as Record<LayerId, number>;
  for (const l of LAYERS) out[l.id] = l.at === 0 || danger >= l.at ? 1 : 0;
  return out;
}

/** Tempo multiplier for a timed run: 1 until 30 s remain, then a linear ramp to 1.25 at time-up. */
export function blitzBoost(elapsedFrames: number, totalFrames: number): number {
  const remaining = totalFrames - elapsedFrames;
  if (remaining >= BLITZ_RAMP_FRAMES) return 1;
  return 1 + (BLITZ_BOOST - 1) * clamp01(1 - remaining / BLITZ_RAMP_FRAMES);
}

/** Hysteresis: a layer that is on stays on until intensity drops this far below its threshold. */
export const LAYER_DROP = 0.05;

/** Layer levels for `intensity`, given the levels already playing (see LAYER_DROP). */
export function nextLayerLevels(intensity: number, prev: Record<LayerId, number>): Record<LayerId, number> {
  const on = layerLevels(intensity);
  const held = layerLevels(intensity + LAYER_DROP);
  const out = {} as Record<LayerId, number>;
  for (const l of LAYERS) out[l.id] = prev[l.id] > 0 ? held[l.id] : on[l.id];
  return out;
}

/** What the music reacts to during a session. */
export interface PlayState {
  danger: number; // the renderer's danger, 0..1 (0 until the stack is ~15 rows)
  stackRows: number; // height of the player's stack, 0..20 visible rows
  combo: number; // on-screen combo ("N COMBO"), 0 when none
  boost: number; // blitzBoost(), 1 outside the final 30 s of Blitz
}

/**
 * Music intensity 0..1 (it drives the layers and tempo). The strongest of: danger; the stack height
 * (bass+kick from ~4 rows, arpeggio+hats from 10); a running combo; and Blitz's final 30 s, which
 * starts at the arpeggio layer and rises to full at time-up. An empty board with no combo is 0.
 */
export function musicIntensity(s: PlayState): number {
  const stack = clamp01(s.stackRows / 20) * 0.8;
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

type Channel = LayerId | "melody";

const MIX: Record<Channel, number> = { pad: 0.55, bass: 0.8, arp: 0.6, lead: 0.5, melody: 0.7 };
const LOOKAHEAD = 0.1; // seconds scheduled ahead of ctx.currentTime
const TICK_MS = 25;
const TEMPO_TAU = 1.5; // seconds for the tempo to close ~63% of the gap to its target
const LAYER_TAU = 0.5;
const BASS_STEPS = [0, 3, 6, 8, 11, 14];
const ARP = [0, 2, 4, 7, 4, 2, 4, 9];
const PULSE = [0, 4, 2, 4]; // quiet quarter-note chord tones under the pad, one per beat
const TENSION = [6, 8, 4, 6]; // 7th, 9th, 5th, 7th above the chord root
const SINE: Timbre = { type: "sine", detune: 0, fm: 0 };

interface Run {
  ctx: BaseAudioContext;
  fader: GainNode;
  ch: Record<Channel, GainNode>;
  levels: Record<LayerId, number>;
  timer: ReturnType<typeof setInterval> | null;
  step: number; // 16th notes since the start
  next: number; // context time of `step`
  bpm: number;
  target: number;
  pack: SoundPack; // the pack of the current bar
  melody: number[]; // combo notes still to play, one per 16th
  melodyOn: boolean;
}

export class Music {
  private run: Run | null = null;

  constructor(private output: () => MusicOutput | null) {}

  get playing(): boolean {
    return this.run !== null;
  }

  /** Current (smoothed) tempo, or 0 when stopped. */
  get bpm(): number {
    return this.run?.bpm ?? 0;
  }

  /**
   * Start a fresh run, replacing any current one. Does nothing until audio is unlocked.
   * `timer: false` skips the interval so a caller can drive `pump()` itself (offline rendering).
   */
  start(timer = true): void {
    this.stop(0.05);
    const o = this.output();
    if (!o) return;
    const ctx = o.ctx;
    const now = ctx.currentTime;
    const fader = ctx.createGain();
    fader.gain.setValueAtTime(0.0001, now);
    fader.gain.exponentialRampToValueAtTime(1, now + 1.2);
    fader.connect(o.bus);
    const levels = layerLevels(0);
    const channel = (level: number) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(fader);
      return g;
    };
    const run: Run = {
      ctx, fader, levels, timer: null, step: 0, next: now + 0.05,
      ch: {
        pad: channel(levels.pad * MIX.pad), bass: channel(levels.bass * MIX.bass), arp: channel(levels.arp * MIX.arp),
        lead: channel(levels.lead * MIX.lead), melody: channel(0),
      },
      bpm: tempoFor(0), target: tempoFor(0), pack: o.pack, melody: [], melodyOn: false,
    };
    this.run = run;
    if (timer) run.timer = setInterval(() => this.pump(), TICK_MS);
    this.pump();
  }

  /** Fade out over `fade` seconds and stop scheduling. Notes already scheduled die out under the fade. */
  stop(fade = 0.8): void {
    const r = this.run;
    if (!r) return;
    this.run = null;
    if (r.timer !== null) clearInterval(r.timer);
    const now = r.ctx.currentTime;
    const g = r.fader.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
  }

  /** Per-frame input: musicIntensity() (0..1) and the tempo multiplier. */
  update(intensity: number, boost: number): void {
    const r = this.run;
    if (!r) return;
    r.target = tempoFor(intensity, boost);
    const levels = nextLayerLevels(intensity, r.levels);
    for (const { id } of LAYERS) {
      if (levels[id] === r.levels[id]) continue;
      r.levels[id] = levels[id];
      r.ch[id].gain.setTargetAtTime(levels[id] * MIX[id], r.ctx.currentTime, LAYER_TAU);
    }
  }

  /** A clear with an on-screen combo of `combo`: queue a phrase from the next 16th step. */
  combo(combo: number): void {
    const r = this.run;
    if (!r || combo < 1) return;
    r.melody = comboNotes(combo, r.pack.scale);
    const g = r.ch.melody.gain;
    g.cancelScheduledValues(r.ctx.currentTime);
    g.setTargetAtTime(MIX.melody, r.ctx.currentTime, 0.01);
    r.melodyOn = true;
  }

  /** The combo ended: drop the rest of the phrase and fade the melody layer. */
  endCombo(): void {
    const r = this.run;
    if (!r || !r.melodyOn) return;
    r.melodyOn = false;
    r.melody = [];
    const g = r.ch.melody.gain;
    g.cancelScheduledValues(r.ctx.currentTime);
    g.setTargetAtTime(0, r.ctx.currentTime, 0.06);
  }

  /** Schedule every 16th step that starts before `until` (default: now + look-ahead). */
  pump(until?: number): void {
    const r = this.run;
    const o = this.output();
    if (!r || !o) return;
    const end = until ?? r.ctx.currentTime + LOOKAHEAD;
    // Fell behind (e.g. a throttled background tab): skip the missed steps rather than burst them.
    if (r.next < r.ctx.currentTime) r.next = r.ctx.currentTime + 0.01;
    while (r.next < end) {
      const d16 = 60 / r.bpm / 4;
      if (r.step % 16 === 0) r.pack = o.pack; // a pack switch lands on the next bar
      const note = r.melody.shift();
      if (o.audible) {
        this.playStep(r, o.noise, r.step, r.next, d16);
        if (note) voice(r.ctx, r.ch.melody, r.pack.music.lead, note, r.next, d16 * 1.8, { gain: 0.09, attack: 0.005 });
      }
      r.step++;
      r.next += d16;
      r.bpm += (r.target - r.bpm) * (1 - Math.exp(-d16 / TEMPO_TAU));
    }
  }

  private playStep(r: Run, noise: AudioBuffer, step: number, t: number, d16: number): void {
    const { ctx, ch } = r;
    const m = r.pack.music;
    const s = r.pack.scale;
    const pos = step % 16;
    const bar = Math.floor(step / 16);
    const chord = r.pack.progression[bar % r.pack.progression.length];

    // pad: the bar's triad, an octave down, held across the bar
    if (pos === 0) {
      for (const k of [0, 2, 4]) {
        voice(ctx, ch.pad, m.pad, degreeFreq(s, chord + k, -1), t, d16 * 17, { gain: 0.07, attack: m.padAttack, release: d16 * 4, filter: m.brightness });
      }
    }
    // a soft pulse on every beat, so even the pad-only state moves
    if (pos % 4 === 0) {
      voice(ctx, ch.pad, m.lead, degreeFreq(s, chord + PULSE[pos / 4]), t, d16 * 3, { gain: 0.025, attack: 0.01, filter: m.brightness });
    }
    // the remaining layers are silent below their threshold: skip creating their voices
    if (r.levels.bass > 0) {
      if (pos % 4 === 0) voice(ctx, ch.bass, SINE, 140, t, 0.2, { gain: 0.4, attack: 0.002, slide: 0.3 });
      if (BASS_STEPS.includes(pos)) {
        voice(ctx, ch.bass, m.bass, degreeFreq(s, chord, -2), t, d16 * 1.8, { gain: m.bassGain, attack: 0.005, filter: m.brightness * 0.6 });
      }
    }
    if (r.levels.arp > 0) {
      voice(ctx, ch.arp, m.arp, degreeFreq(s, chord + ARP[pos % ARP.length]), t, d16 * 0.9, { gain: 0.035, attack: 0.003, filter: m.brightness * 2 });
      noiseHit(ctx, ch.arp, noise, t, pos % 4 === 2 ? 0.06 : 0.03, { gain: pos % 4 === 2 ? 0.09 : 0.04, filter: 7000, type: "highpass" });
    }
    if (r.levels.lead > 0 && pos % 8 === 0) {
      const k = TENSION[(bar * 2 + pos / 8) % TENSION.length];
      voice(ctx, ch.lead, m.lead, degreeFreq(s, chord + k), t, d16 * 7.5, { gain: 0.05, attack: 0.04, release: d16 * 2 });
    }
  }
}
