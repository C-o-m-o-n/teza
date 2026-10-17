import { SOUND_PACKS } from "./audio/packs";
import { songById } from "./audio/songs";
import { Action, DEFAULT_HANDLING, Handling } from "./engine/game";
import { Replay, parseReplay } from "./engine/replay";
import { Records } from "./profile";
import { THEMES } from "./ui/themes";

export type { Records, RunRecord } from "./profile";

export type Bind = Action | "retry" | "exit";

export interface Settings {
  handling: Handling;
  keys: Record<Bind, string[]>; // KeyboardEvent.code values
  volume: number; // sound effects
  musicVolume: number;
  musicTrack: string; // "auto" (each mode's song), "off", or a SONGS id played everywhere
  soundPack: string; // a SOUND_PACKS id
  bounciness: number; // board physics strength, 0..2
  gridOpacity: number;
  shadowOpacity: number;
  reduceMotion: boolean; // also on when the OS asks for reduced motion
  theme: string; // a THEMES id (src/ui/themes.ts), the interface look
}

export const BIND_LABELS: Record<Bind, string> = {
  left: "Move left",
  right: "Move right",
  soft: "Soft drop",
  hard: "Hard drop",
  ccw: "Rotate counter-clockwise",
  cw: "Rotate clockwise",
  "180": "Rotate 180°",
  hold: "Hold",
  retry: "Retry",
  exit: "Exit to menu",
};

// Explicit order: object key order would put the numeric-looking "180" first.
export const BIND_ORDER: Bind[] = ["left", "right", "soft", "hard", "ccw", "cw", "180", "hold", "retry", "exit"];

export function defaultSettings(): Settings {
  return {
    handling: { ...DEFAULT_HANDLING },
    keys: {
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
      soft: ["ArrowDown"],
      hard: ["Space"],
      ccw: ["KeyZ", "ControlLeft"],
      cw: ["ArrowUp", "KeyX"],
      "180": ["KeyA"],
      hold: ["KeyC", "ShiftLeft"],
      retry: ["KeyR"],
      exit: ["Escape"],
    },
    volume: 0.6,
    musicVolume: 0.6,
    musicTrack: "auto",
    soundPack: SOUND_PACKS[0].id,
    bounciness: 1,
    gridOpacity: 0.1,
    shadowOpacity: 0.3,
    reduceMotion: false,
    theme: THEMES[0].id,
  };
}

const KEY = "teza:settings";
const PB_KEY = "teza:records";
const GHOST_KEY = "teza:ghost40l"; // the 40 LINES PB run, kept apart from the synced Records

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — settings just won't persist
  }
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  const s = read<Partial<Settings>>(KEY);
  if (!s) return d;
  const merged: Settings = {
    ...d,
    ...s,
    handling: { ...d.handling, ...s.handling },
    keys: { ...d.keys, ...s.keys },
  };
  if (!SOUND_PACKS.some((p) => p.id === merged.soundPack)) merged.soundPack = d.soundPack;
  if (merged.musicTrack !== "auto" && merged.musicTrack !== "off" && !songById(merged.musicTrack)) merged.musicTrack = d.musicTrack;
  if (!THEMES.some((t) => t.id === merged.theme)) merged.theme = d.theme;
  if (typeof merged.musicVolume !== "number" || !(merged.musicVolume >= 0 && merged.musicVolume <= 1)) merged.musicVolume = d.musicVolume;
  return merged;
}

export function saveSettings(s: Settings): void {
  write(KEY, s);
}

export function loadRecords(): Records {
  return { vs: {}, ...(read<Records>(PB_KEY) ?? {}) };
}

export function saveRecords(r: Records): void {
  write(PB_KEY, r);
}

/** The recorded run of the 40 LINES PB, if it is stored and matches `pbFrames`. */
export function loadGhost(pbFrames: number | undefined): Replay | null {
  try {
    return parseReplay(localStorage.getItem(GHOST_KEY), pbFrames);
  } catch {
    return null;
  }
}

export function saveGhost(r: Replay): void {
  write(GHOST_KEY, r);
}
