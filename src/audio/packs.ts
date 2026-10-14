// Sound packs: plain data choosing the timbre and key of both the SFX and the music.

export interface Scale {
  root: number; // MIDI note of the tonic, in the octave the SFX chords use
  steps: number[]; // 7 semitone offsets from the tonic
}

export interface Timbre {
  type: OscillatorType;
  detune: number; // cents; > 0 adds a detuned pair around the main voice
  fm: number; // FM bell modulation index; 0 = none
}

export interface SoundPack {
  id: string;
  name: string;
  tagline: string;
  scale: Scale;
  progression: number[]; // chord roots as scale degrees, one chord per bar
  sfx: {
    bright: Timbre; // moves, UI blips, countdown
    soft: Timbre; // rotate, hold, lock, clear chords
    edge: Timbre; // spins, quads, attacks
    brightness: number; // lowpass cutoff in Hz (>= 18000 means unfiltered)
    attack: number; // seconds
    decay: number; // multiplier on note lengths
  };
  music: {
    pad: Timbre;
    bass: Timbre;
    arp: Timbre;
    lead: Timbre;
    brightness: number; // lowpass cutoff in Hz for pad and bass
    padAttack: number; // seconds
    bassGain: number;
  };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const t = (type: OscillatorType, detune = 0, fm = 0): Timbre => ({ type, detune, fm });

export const SOUND_PACKS: SoundPack[] = [
  {
    id: "arcade",
    name: "Arcade",
    tagline: "Square chip",
    scale: { root: 67, steps: MAJOR }, // G major
    progression: [0, 5, 3, 4], // I vi IV V
    sfx: {
      bright: t("square"), soft: t("triangle"), edge: t("sawtooth"),
      brightness: 20000, attack: 0.004, decay: 1,
    },
    music: {
      pad: t("triangle"), bass: t("square"), arp: t("square"), lead: t("triangle"),
      brightness: 2400, padAttack: 0.3, bassGain: 0.09,
    },
  },
  {
    id: "glass",
    name: "Glass",
    tagline: "Soft bells",
    scale: { root: 64, steps: LYDIAN }, // E lydian
    progression: [0, 1, 5, 4],
    sfx: {
      bright: t("sine", 0, 1.2), soft: t("sine", 0, 2), edge: t("triangle", 0, 1.5),
      brightness: 6000, attack: 0.008, decay: 1.6,
    },
    music: {
      pad: t("sine", 6), bass: t("sine"), arp: t("sine", 0, 2.5), lead: t("sine", 0, 1.2),
      brightness: 1800, padAttack: 0.8, bassGain: 0.14,
    },
  },
  {
    id: "neon",
    name: "Neon",
    tagline: "Detuned saw",
    scale: { root: 62, steps: MINOR }, // D minor
    progression: [0, 5, 2, 6], // i VI III VII
    sfx: {
      bright: t("sawtooth", 9), soft: t("sawtooth", 12), edge: t("sawtooth", 18),
      brightness: 3200, attack: 0.006, decay: 1.2,
    },
    music: {
      pad: t("sawtooth", 14), bass: t("sawtooth", 7), arp: t("sawtooth", 8), lead: t("sawtooth", 10),
      brightness: 1300, padAttack: 0.5, bassGain: 0.13,
    },
  },
];

export function packById(id: string): SoundPack {
  return SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0];
}

export function midiFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Frequency of a scale degree (0 = tonic; 7 = tonic an octave up; negative goes down). */
export function degreeFreq(scale: Scale, degree: number, octave = 0): number {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n);
  const step = scale.steps[degree - oct * n];
  return midiFreq(scale.root + 12 * (oct + octave) + step);
}
