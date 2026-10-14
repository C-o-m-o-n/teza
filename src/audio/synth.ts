// One-shot Web Audio voices shared by the SFX and the music: oscillators, FM bells and filtered noise.
import { Timbre } from "./packs";

export interface VoiceOpts {
  gain: number;
  attack?: number;
  slide?: number; // frequency multiplier reached at the end of the note
  release?: number; // hold the peak, then fade over this many seconds at the end (pads); unset = decay throughout
  filter?: number; // lowpass cutoff in Hz; >= 18000 or unset means unfiltered
  q?: number;
  pluck?: number; // the filter opens this many times wider at the onset and closes over ~0.15 s
}

/** A single enveloped note of `timbre` starting at `t0`, routed into `dest`. */
export function voice(ctx: BaseAudioContext, dest: AudioNode, timbre: Timbre, freq: number, t0: number, dur: number, o: VoiceOpts): void {
  const g = ctx.createGain();
  const attack = Math.min(o.attack ?? 0.004, dur * 0.5);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + attack);
  if (o.release !== undefined) g.gain.setValueAtTime(Math.max(0.0002, o.gain), t0 + Math.max(attack, dur - o.release));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  if (o.filter !== undefined && o.filter < 18000) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    if (o.pluck) {
      f.frequency.setValueAtTime(Math.min(18000, o.filter * o.pluck), t0);
      f.frequency.exponentialRampToValueAtTime(o.filter, t0 + Math.min(dur, 0.15));
    } else {
      f.frequency.value = o.filter;
    }
    f.Q.value = o.q ?? 0.7;
    g.connect(f).connect(dest);
  } else {
    g.connect(dest);
  }
  const detunes = timbre.detune > 0 ? [0, -timbre.detune, timbre.detune] : [0];
  const end = t0 + dur + 0.02;
  for (const cents of detunes) {
    const osc = ctx.createOscillator();
    osc.type = timbre.type;
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * o.slide), t0 + dur);
    osc.detune.value = cents;
    if (detunes.length > 1) {
      // keep the stack at roughly the loudness of one voice
      const share = ctx.createGain();
      share.gain.value = cents === 0 ? 0.5 : 0.3;
      osc.connect(share).connect(g);
    } else {
      osc.connect(g);
    }
    if (timbre.fm > 0 && cents === 0) {
      // bell: a non-integer modulator whose depth decays faster than the note
      const mod = ctx.createOscillator();
      const depth = ctx.createGain();
      mod.frequency.value = freq * 3.5;
      depth.gain.setValueAtTime(freq * timbre.fm, t0);
      depth.gain.exponentialRampToValueAtTime(Math.max(1, freq * timbre.fm * 0.05), t0 + dur);
      mod.connect(depth).connect(osc.frequency);
      mod.start(t0);
      mod.stop(end);
    }
    osc.start(t0);
    osc.stop(end);
  }
}

/** Filtered white noise from a shared buffer, with a short decay. */
export function noiseHit(ctx: BaseAudioContext, dest: AudioNode, buffer: AudioBuffer, t0: number, dur: number, o: { gain: number; filter: number; type?: BiquadFilterType; q?: number; sweep?: number }): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? "lowpass";
  f.frequency.setValueAtTime(o.filter, t0);
  if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.filter * o.sweep, t0 + dur);
  f.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(o.gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t0, Math.random() * Math.max(0, buffer.duration - dur - 0.05));
  src.stop(t0 + dur + 0.02);
}

/** A drum thump: a sine whose pitch falls fast from `from` to `to` Hz, plus a short noise click. */
export function kick(ctx: BaseAudioContext, dest: AudioNode, buffer: AudioBuffer, t0: number, o: { gain: number; from?: number; to?: number; dur?: number; click?: number }): void {
  const dur = o.dur ?? 0.32;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(o.from ?? 160, t0);
  osc.frequency.exponentialRampToValueAtTime(o.to ?? 46, t0 + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.003);
  g.gain.setValueAtTime(o.gain, t0 + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  if (o.click) noiseHit(ctx, dest, buffer, t0, 0.012, { gain: o.click, filter: 2500, type: "highpass" });
}

/** A soft-clipping curve for a WaveShaperNode: tanh with `drive`, normalised so ±1 stays ±1. */
export function saturationCurve(drive: number, n = 1024): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}

/** Two seconds of white noise, made once per context. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.ceil(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
