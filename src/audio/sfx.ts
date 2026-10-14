// Every sound is synthesized with WebAudio — no samples from the original game.
// Mixer: AudioContext -> musicBus / sfxBus -> master -> destination.
import { Music, MusicOutput } from "./music";
import { SOUND_PACKS, SoundPack, Timbre, degreeFreq } from "./packs";
import { makeNoise, noiseHit, voice } from "./synth";

const SINE: Timbre = { type: "sine", detune: 0, fm: 0 };
const SAW: Timbre = { type: "sawtooth", detune: 0, fm: 0 };
const BELL: Timbre = { type: "sine", detune: 0, fm: 2.5 };

/** Stereo position (-0.7..0.7) for a board column, 0..9 left to right. */
export function panForColumn(x: number): number {
  return Math.min(1, Math.max(-1, (x - 4.5) / 4.5)) * 0.7;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private sfxVolume = 0.6;
  private musicLevel = 0.4;
  pack: SoundPack = SOUND_PACKS[0];

  /** SFX volume, 0..1 (scales sfxBus). */
  get volume(): number {
    return this.sfxVolume;
  }
  set volume(v: number) {
    this.sfxVolume = v;
    if (this.ctx && this.sfxBus) this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Music volume, 0..1 (scales musicBus). */
  get musicVolume(): number {
    return this.musicLevel;
  }
  set musicVolume(v: number) {
    this.musicLevel = v;
    if (!this.ctx || !this.musicBus) return;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Must be called from a user gesture (keydown/click) to unlock audio. */
  unlock(): void {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume;
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicLevel;
      this.musicBus.connect(this.master);
      this.noiseBuf = makeNoise(ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Where the music engine plays, or null while audio is still locked. */
  musicOutput(): MusicOutput | null {
    if (!this.ctx || !this.musicBus || !this.noiseBuf) return null;
    return { ctx: this.ctx, bus: this.musicBus, noise: this.noiseBuf, pack: this.pack, audible: this.musicLevel > 0 };
  }

  /** Dip the music to ~40% (25% when `strong`) within ~30 ms, then recover over ~350 ms. */
  duckMusic(strong = false): void {
    if (!this.ctx || !this.musicBus) return;
    const g = this.musicBus.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(this.musicLevel * (strong ? 0.25 : 0.4), now, 0.01);
    g.setTargetAtTime(this.musicLevel, now + (strong ? 0.06 : 0.035), strong ? 0.17 : 0.11);
  }

  /** Destination for one sound: the SFX bus, through a stereo panner when `x` (a column) is off-centre. */
  private out(x?: number): AudioNode | null {
    if (!this.ctx || !this.sfxBus || this.sfxVolume <= 0) return null;
    const pan = x === undefined ? 0 : panForColumn(x);
    if (pan === 0 || typeof this.ctx.createStereoPanner !== "function") return this.sfxBus;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.sfxBus);
    return p;
  }

  private tone(dest: AudioNode, freq: number, dur: number, opts: { timbre?: Timbre; gain?: number; delay?: number; slide?: number; attack?: number; filter?: number; q?: number } = {}): void {
    const ctx = this.ctx!;
    const sfx = this.pack.sfx;
    voice(ctx, dest, opts.timbre ?? SINE, freq, ctx.currentTime + (opts.delay ?? 0), dur * sfx.decay, {
      gain: opts.gain ?? 0.2,
      attack: opts.attack ?? sfx.attack,
      slide: opts.slide,
      filter: opts.filter ?? sfx.brightness,
      q: opts.q,
    });
  }

  private noise(dest: AudioNode, dur: number, opts: { gain?: number; filter?: number; delay?: number; q?: number; type?: BiquadFilterType; sweep?: number } = {}): void {
    const ctx = this.ctx!;
    noiseHit(ctx, dest, this.noiseBuf!, ctx.currentTime + (opts.delay ?? 0), dur, {
      gain: opts.gain ?? 0.3, filter: opts.filter ?? 1200, type: opts.type, q: opts.q, sweep: opts.sweep,
    });
  }

  /** A scale degree of the current pack (0 = its tonic in the SFX octave). */
  private note(degree: number, octave = 0): number {
    return degreeFreq(this.pack.scale, degree, octave);
  }

  /** Bell over a soft saw an octave down, slow decay, with three fading repeats: the back-to-back colour. */
  private b2bPatch(d: AudioNode, freq: number, delay: number): void {
    this.tone(d, freq, 0.9, { timbre: BELL, gain: 0.05, delay, attack: 0.005 });
    this.tone(d, freq * 2, 0.6, { timbre: SINE, gain: 0.02, delay });
    this.tone(d, freq / 2, 0.7, { timbre: { ...SAW, detune: 7 }, gain: 0.035, delay, filter: 2200 });
    for (let i = 1; i <= 3; i++) {
      this.tone(d, freq, 0.5, { timbre: BELL, gain: 0.05 * Math.pow(0.45, i), delay: delay + i * 0.14 });
    }
  }

  move(x?: number): void {
    const d = this.out(x);
    if (d) this.tone(d, 1320, 0.03, { timbre: this.pack.sfx.bright, gain: 0.035 });
  }

  wall(): void {
    const d = this.out();
    if (d) this.tone(d, 220, 0.04, { timbre: this.pack.sfx.bright, gain: 0.03 });
  }

  rotate(x?: number): void {
    const d = this.out(x);
    if (d) this.tone(d, 880, 0.05, { timbre: this.pack.sfx.soft, gain: 0.08, slide: 1.3 });
  }

  hold(x?: number): void {
    const d = this.out(x);
    if (d) this.tone(d, 500, 0.08, { timbre: this.pack.sfx.soft, gain: 0.08, slide: 1.8 });
  }

  harddrop(x?: number): void {
    const d = this.out(x);
    if (!d) return;
    this.noise(d, 0.09, { gain: 0.35, filter: 900 });
    this.tone(d, 110, 0.12, { gain: 0.3, slide: 0.5 });
  }

  lock(x?: number): void {
    const d = this.out(x);
    if (d) this.tone(d, 260, 0.05, { timbre: this.pack.sfx.soft, gain: 0.06 });
  }

  /** Layered: rising filtered saw sweep, a detuned shimmer pair, and a noise whoosh. */
  spin(x?: number): void {
    const d = this.out(x);
    if (!d) return;
    this.tone(d, this.note(0, -1), 0.28, { timbre: SAW, gain: 0.06, slide: 4, filter: Math.min(2500, this.pack.sfx.brightness), q: 6 });
    const shimmer = this.note(4, 1);
    for (const cents of [-9, 9]) {
      this.tone(d, shimmer * Math.pow(2, cents / 1200), 0.35, { timbre: this.pack.sfx.soft, gain: 0.03, delay: 0.06, attack: 0.03 });
    }
    this.noise(d, 0.3, { gain: 0.16, filter: 600, sweep: 8, type: "bandpass", q: 3 });
  }

  clear(lines: number, spin: boolean, combo: number, btb: number, x?: number): void {
    const d = this.out(x);
    if (!d) return;
    const base = Math.min(combo, 7);
    const degrees = spin ? [0, 2, 4, 7, 9] : [0, 2, 4, 7].slice(0, Math.max(2, lines));
    const timbre = lines >= 4 || spin ? this.pack.sfx.edge : this.pack.sfx.soft;
    degrees.forEach((k, i) => this.tone(d, this.note(base + k), 0.25, { timbre, gain: 0.07, delay: i * 0.035 }));
    this.noise(d, 0.18, { gain: 0.12, filter: 4000, type: "highpass" });
    if (btb > 1) this.b2bPatch(d, this.note(base, 1), 0.1);
    if (lines >= 4) this.tone(d, 98, 0.35, { gain: 0.25, slide: 0.6 });
  }

  allClear(): void {
    const d = this.out();
    if (!d) return;
    [0, 2, 4, 6, 8, 11, 14].forEach((k, i) => this.tone(d, this.note(k), 0.5, { timbre: this.pack.sfx.soft, gain: 0.08, delay: i * 0.06 }));
  }

  btbBreak(x?: number): void {
    const d = this.out(x);
    if (!d) return;
    this.tone(d, 300, 0.4, { timbre: SAW, gain: 0.07, slide: 0.4, filter: 2500 });
    this.b2bPatch(d, this.note(-3), 0.05);
  }

  garbageIn(amount: number): void {
    const d = this.out();
    if (d) this.tone(d, 160, 0.15 + amount * 0.02, { timbre: this.pack.sfx.bright, gain: 0.06, slide: 0.7 });
  }

  garbageRise(): void {
    const d = this.out();
    if (!d) return;
    this.noise(d, 0.3, { gain: 0.3, filter: 300 });
    this.tone(d, 70, 0.3, { gain: 0.25, slide: 0.8 });
  }

  attack(amount: number): void {
    const d = this.out();
    if (d) this.tone(d, 700, 0.18, { timbre: this.pack.sfx.edge, gain: 0.04 + Math.min(amount, 10) * 0.006, slide: 2.2 });
  }

  countdown(go: boolean): void {
    const d = this.out();
    if (d) this.tone(d, go ? 1046 : 523, go ? 0.35 : 0.15, { timbre: this.pack.sfx.bright, gain: 0.07 });
  }

  levelUp(): void {
    const d = this.out();
    if (!d) return;
    [0, 4, 7].forEach((k, i) => this.tone(d, this.note(k, 1), 0.15, { timbre: this.pack.sfx.bright, gain: 0.05, delay: i * 0.05 }));
  }

  topout(): void {
    const d = this.out();
    if (!d) return;
    this.noise(d, 0.8, { gain: 0.4, filter: 600 });
    [0, -2, -4, -7].forEach((k, i) => this.tone(d, this.note(k), 0.3, { timbre: this.pack.sfx.edge, gain: 0.06, delay: i * 0.12 }));
  }

  finish(): void {
    const d = this.out();
    if (!d) return;
    [0, 2, 4, 7, 9].forEach((k, i) => this.tone(d, this.note(k), 0.4, { timbre: this.pack.sfx.soft, gain: 0.09, delay: i * 0.08 }));
  }

  menu(): void {
    const d = this.out();
    if (d) this.tone(d, 1400, 0.035, { timbre: this.pack.sfx.soft, gain: 0.04 });
  }

  confirm(): void {
    const d = this.out();
    if (d) this.tone(d, 880, 0.12, { timbre: this.pack.sfx.soft, gain: 0.07, slide: 1.5 });
  }
}

export const sfx = new Sfx();
export const music = new Music(() => sfx.musicOutput());
