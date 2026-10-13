// Every sound is synthesized with WebAudio — no samples from the original game.

type Wave = OscillatorType;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  volume = 0.6;

  /** Must be called from a user gesture (keydown/click) to unlock audio. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private get ready(): boolean {
    return !!this.ctx && !!this.master && this.volume > 0;
  }

  private tone(freq: number, dur: number, opts: { wave?: Wave; gain?: number; delay?: number; slide?: number; attack?: number } = {}): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.wave ?? "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t0 + dur);
    const peak = (opts.gain ?? 0.2) * this.volume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, opts: { gain?: number; filter?: number; delay?: number; q?: number; type?: BiquadFilterType } = {}): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? "lowpass";
    f.frequency.value = opts.filter ?? 1200;
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.value = (opts.gain ?? 0.3) * this.volume;
    src.connect(f).connect(g).connect(this.master!);
    src.start(t0);
  }

  move(): void { this.tone(1320, 0.03, { wave: "square", gain: 0.035 }); }
  wall(): void { this.tone(220, 0.04, { wave: "square", gain: 0.03 }); }
  rotate(): void { this.tone(880, 0.05, { wave: "triangle", gain: 0.08, slide: 1.3 }); }
  hold(): void { this.tone(500, 0.08, { wave: "triangle", gain: 0.08, slide: 1.8 }); }

  harddrop(): void {
    this.noise(0.09, { gain: 0.35, filter: 900 });
    this.tone(110, 0.12, { wave: "sine", gain: 0.3, slide: 0.5 });
  }

  lock(): void { this.tone(260, 0.05, { wave: "triangle", gain: 0.06 }); }

  spin(): void {
    this.noise(0.25, { gain: 0.18, filter: 3000, type: "bandpass", q: 4 });
    this.tone(400, 0.22, { wave: "sawtooth", gain: 0.05, slide: 2.5 });
  }

  clear(lines: number, spin: boolean, combo: number, btb: number): void {
    const base = 392 * Math.pow(2, Math.min(combo, 12) / 12);
    const steps = spin ? [0, 4, 7, 12, 16] : [0, 4, 7, 12].slice(0, Math.max(2, lines));
    steps.forEach((s, i) =>
      this.tone(base * Math.pow(2, s / 12), 0.25, { wave: lines >= 4 || spin ? "sawtooth" : "triangle", gain: 0.07, delay: i * 0.035 }),
    );
    this.noise(0.18, { gain: 0.12, filter: 4000, type: "highpass" });
    if (btb > 1) this.tone(base * 4, 0.4, { wave: "sine", gain: 0.06, delay: 0.1, slide: 1.02 });
    if (lines >= 4) this.tone(98, 0.35, { wave: "sine", gain: 0.25, slide: 0.6 });
  }

  allClear(): void {
    [0, 4, 7, 11, 14, 19, 24].forEach((s, i) =>
      this.tone(523 * Math.pow(2, s / 12), 0.5, { wave: "triangle", gain: 0.08, delay: i * 0.06 }),
    );
  }

  btbBreak(): void { this.tone(300, 0.4, { wave: "sawtooth", gain: 0.07, slide: 0.4 }); }

  garbageIn(amount: number): void {
    this.tone(160, 0.15 + amount * 0.02, { wave: "square", gain: 0.06, slide: 0.7 });
  }

  garbageRise(): void {
    this.noise(0.3, { gain: 0.3, filter: 300 });
    this.tone(70, 0.3, { wave: "sine", gain: 0.25, slide: 0.8 });
  }

  attack(amount: number): void {
    this.tone(700, 0.18, { wave: "sawtooth", gain: 0.04 + Math.min(amount, 10) * 0.006, slide: 2.2 });
  }

  countdown(go: boolean): void {
    this.tone(go ? 1046 : 523, go ? 0.35 : 0.15, { wave: "square", gain: 0.07 });
  }

  levelUp(): void {
    [0, 7, 12].forEach((s, i) => this.tone(660 * Math.pow(2, s / 12), 0.15, { wave: "square", gain: 0.05, delay: i * 0.05 }));
  }

  topout(): void {
    this.noise(0.8, { gain: 0.4, filter: 600 });
    [0, -3, -7, -12].forEach((s, i) => this.tone(330 * Math.pow(2, s / 12), 0.3, { wave: "sawtooth", gain: 0.06, delay: i * 0.12 }));
  }

  finish(): void {
    [0, 4, 7, 12, 16].forEach((s, i) => this.tone(523 * Math.pow(2, s / 12), 0.4, { wave: "triangle", gain: 0.09, delay: i * 0.08 }));
  }

  menu(): void { this.tone(1400, 0.035, { wave: "triangle", gain: 0.04 }); }
  confirm(): void { this.tone(880, 0.12, { wave: "triangle", gain: 0.07, slide: 1.5 }); }
}

export const sfx = new Sfx();
