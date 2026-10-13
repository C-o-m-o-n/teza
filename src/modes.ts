import { GameOptions } from "./engine/constants";

export type ModeId = "40l" | "blitz" | "zen" | "vs";

export interface Mode {
  id: ModeId;
  title: string;
  tagline: string;
  glyph: string; // oversized decorative label on the menu bar
  accent: string;
  options(seed: number): Partial<GameOptions>;
}

// 40L and Blitz presets are the official `gameModes` table from the client.
export const MODES: Mode[] = [
  {
    id: "40l",
    title: "40 LINES",
    tagline: "Clear 40 lines as fast as you can.",
    glyph: "40L",
    accent: "#3f6bff",
    options: (seed) => ({
      seed, allow180: true, spinbonuses: "all-mini+", g: 0.02, nolockout: true,
      objective: { type: "lines", count: 40 },
    }),
  },
  {
    id: "blitz",
    title: "BLITZ",
    tagline: "Two minutes. Score as much as possible.",
    glyph: "2:00",
    accent: "#ff5a36",
    options: (seed) => ({
      seed, allow180: true, spinbonuses: "all-mini+", nolockout: true,
      objective: { type: "timed", frames: 120 * 60 },
      levels: true, levelspeed: 0.42, levelgbase: 0.65, levelgspeed: 0.007,
    }),
  },
  {
    id: "vs",
    title: "VERSUS",
    tagline: "League rules against a bot. B2B chaining, surge after two minutes.",
    glyph: "VS",
    accent: "#e0337a",
    options: (seed) => ({
      seed, allow180: true, spinbonuses: "all-mini+", hasgarbage: true, b2bchaining: true,
      garbagespeed: 20, garbagecap: 8, messiness_change: 1,
      // League-style surge; exact ranked values are served live by the official server.
      gincrease: 0.0025, gmargin: 7200, garbageincrease: 0.008, garbagemargin: 10800,
    }),
  },
  {
    id: "zen",
    title: "ZEN",
    tagline: "No goal, no top-out. Just stack.",
    glyph: "∞",
    accent: "#22b893",
    options: (seed) => ({ seed, allow180: true, spinbonuses: "all-mini+", g: 0.02 }),
  },
];

export function modeById(id: ModeId): Mode {
  return MODES.find((m) => m.id === id)!;
}
