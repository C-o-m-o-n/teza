// Songs: plain data for the generative music. A song sets the key, chord loop, groove and tempo;
// the sound pack sets the instruments' timbre. Add a song by appending to SONGS. Give it a `mode`
// to make it that mode's Auto track; every song is also offered as a fixed track in CONFIG.
//
// Patterns are one bar of 16th notes (any length works; it loops). For drums, "x" is a hit, "X" an
// accented hit and "." a rest. For pitched parts each digit is a scale degree above the bar's chord
// root (0 = root, 2 = third, 4 = fifth, 7 = octave). A note lasts until the next one in its pattern.
// For the pad, "x" plays the song's chord.
import { Scale } from "./packs";

export interface Gear {
  bpm: number;
  kick?: string;
  snare?: string;
  hat?: string;
  bass?: string;
  pad?: string;
  arp?: string;
  lead?: string;
  pump?: number; // sidechain: how far the kick ducks the other parts, 0..1
}

export interface Song {
  id: string;
  name: string;
  mood: string;
  mode?: string; // a ModeId or "menu": the song Auto picks there
  scale: Scale;
  progression: number[]; // chord roots as scale degrees, one chord per bar
  chord: number[]; // the pad's chord tones as degrees above the root
  swing: number; // 0..0.5 of a 16th that the off-beat 16ths are pushed late
  tone: number; // multiplier on the pack's filter brightness
  drums: number; // drum-kit level
  gears: Gear[]; // index = gear (calm, groove, drive, danger); fewer gears = a song that never climbs that high
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

const BAR = "x...............";
const FOUR = "x...x...x...x...";
const BACKBEAT = "....x.......x...";

export const SONGS: Song[] = [
  {
    id: "lantern",
    name: "Lantern",
    mood: "Relaxed, warm",
    mode: "menu",
    scale: { root: 65, steps: MAJOR }, // F major
    progression: [0, 5, 1, 4],
    chord: [0, 2, 4, 6],
    swing: 0.14,
    tone: 0.8,
    drums: 0.55,
    gears: [
      {
        bpm: 92, pump: 0.15, pad: BAR,
        kick: "x.......x..x....", snare: BACKBEAT, hat: "..x...x...x...xx",
        bass: "0.....4...0...4.", arp: "0..4..2...7..4..",
      },
    ],
  },
  {
    id: "gridline",
    name: "Gridline",
    mood: "Driving, focused",
    mode: "40l",
    scale: { root: 64, steps: DORIAN }, // E dorian
    progression: [0, 3, 0, 6],
    chord: [0, 2, 4],
    swing: 0,
    tone: 1,
    drums: 1,
    gears: [
      { bpm: 118, pump: 0.3, pad: BAR, kick: FOUR, hat: "..x...x...x...x.", bass: "..0...0...0...0.", arp: "0...4...2...4..." },
      { bpm: 126, pump: 0.4, pad: BAR, kick: FOUR, snare: BACKBEAT, hat: "..x...x...x...xx", bass: "..0.0.0...0.0.04", arp: "0.4.2.4.0.4.2.4." },
      { bpm: 134, pump: 0.45, pad: BAR, kick: FOUR, snare: BACKBEAT, hat: "xxXxxxXxxxXxxxXx", bass: "0.07.0.70.07.0.7", arp: "0247424702474247" },
      {
        bpm: 152, pump: 0.55, pad: "x.......x.......", kick: "x...x...x...x.x.", snare: "....X.......X.xx", hat: "XxxxXxxxXxxxXxxx",
        bass: "0707070707070707", arp: "0247024702470247", lead: "6.......4...6...",
      },
    ],
  },
  {
    id: "afterburn",
    name: "Afterburn",
    mood: "Frantic synthwave",
    mode: "blitz",
    scale: { root: 69, steps: MINOR }, // A minor
    progression: [0, 5, 2, 6],
    chord: [0, 2, 4],
    swing: 0,
    tone: 1.2,
    drums: 1,
    gears: [
      { bpm: 130, pump: 0.35, pad: BAR, kick: "x.......x.......", snare: BACKBEAT, hat: "..x...x...x...x.", bass: "0.7.0.7.0.7.0.7." },
      { bpm: 138, pump: 0.45, pad: BAR, kick: FOUR, snare: BACKBEAT, hat: "..x...x...x...x.", bass: "0707070707070707", arp: "0...2...4...2..." },
      {
        bpm: 146, pump: 0.5, pad: BAR, kick: FOUR, snare: BACKBEAT, hat: "xxXxxxXxxxXxxxXx",
        bass: "0707070707070707", arp: "0247024702470247", lead: "4.......2...0...",
      },
      {
        bpm: 162, pump: 0.6, pad: "x.......x.......", kick: FOUR, snare: "....X.......X.xx", hat: "XxxxXxxxXxxxXxxx",
        bass: "0707070707070707", arp: "7424742474247424", lead: "7.6.4.2.7.6.4.6.",
      },
    ],
  },
  {
    id: "undertow",
    name: "Undertow",
    mood: "Dark, aggressive",
    mode: "vs",
    scale: { root: 61, steps: PHRYGIAN }, // C# phrygian
    progression: [0, 1, 0, 5],
    chord: [0, 2, 4],
    swing: 0,
    tone: 0.75,
    drums: 1.1,
    gears: [
      { bpm: 108, pump: 0.3, pad: BAR, kick: "x.....x...x.....", hat: "....x.......x...", bass: "0.....0...0..1.." },
      { bpm: 116, pump: 0.45, pad: BAR, kick: "x..x..x...x..x..", snare: BACKBEAT, hat: "..x...x...x...x.", bass: "0..0..0...0..0.1" },
      {
        bpm: 124, pump: 0.5, pad: BAR, kick: "x..x..x...x..x..", snare: BACKBEAT, hat: "xxXxxxXxxxXxxxXx",
        bass: "0.00.00.0.00.0.1", arp: "0.2.4.0.1.0.4.2.",
      },
      {
        bpm: 142, pump: 0.6, pad: "x.......x.......", kick: "x.xx..x.x.xx..x.", snare: "....X.......X.xx", hat: "XxxxXxxxXxxxXxxx",
        bass: "0000000000001010", arp: "0214021402140214", lead: "1.......0.......",
      },
    ],
  },
  {
    id: "tidepool",
    name: "Tidepool",
    mood: "Ambient lo-fi",
    mode: "zen",
    scale: { root: 62, steps: MAJOR }, // D major
    progression: [0, 3, 5, 4],
    chord: [0, 2, 4, 6],
    swing: 0.28,
    tone: 0.55,
    drums: 0.5,
    // no danger gear: Zen never climbs past "drive"
    gears: [
      { bpm: 72, pump: 0, pad: BAR, arp: "0.....4.....2..." },
      { bpm: 76, pump: 0.15, pad: BAR, kick: "x.........x.....", snare: BACKBEAT, hat: "..x...x...x...x.", bass: "0.........4.....", arp: "0.....4.....2..." },
      {
        bpm: 80, pump: 0.2, pad: BAR, kick: "x.........x..x..", snare: BACKBEAT, hat: "x.x.x.x.x.x.x.xx",
        bass: "0.........4...2.", arp: "0.4.2.6.4.2.0...",
      },
    ],
  },
];

export function songById(id: string): Song | undefined {
  return SONGS.find((s) => s.id === id);
}

/**
 * The song for a place in the app (a ModeId, or "menu") under the Music track setting:
 * "auto" picks the song made for that place, "off" is silence, a song id plays that song everywhere.
 */
export function songFor(track: string, where: string): Song | null {
  if (track === "off") return null;
  return songById(track) ?? SONGS.find((s) => s.mode === where) ?? SONGS[0];
}
