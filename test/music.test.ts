import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLITZ_BOOST, COMBO_CAP, GEARS, GEAR_DROP, blitzBoost, comboNotes, gearFor, musicIntensity, songTempo,
} from "../src/audio/music";
import { SOUND_PACKS, degreeFreq, packById } from "../src/audio/packs";
import { panForColumn } from "../src/audio/sfx";
import { SONGS, songById, songFor } from "../src/audio/songs";
import { MODES } from "../src/modes";
import { defaultSettings, loadSettings } from "../src/settings";

const scale = SOUND_PACKS[0].scale;
const song = (id: string) => songById(id)!;

describe("gearFor", () => {
  it("steps up through calm, groove, drive and danger at the GEARS thresholds", () => {
    expect(GEARS.map((g) => g.at)).toEqual([0, 0.15, 0.4, 0.7]);
    expect(GEARS.map((g) => g.name)).toEqual(["calm", "groove", "drive", "danger"]);
    for (let i = 1; i < GEARS.length; i++) {
      expect(gearFor(GEARS[i].at - 0.01)).toBe(i - 1);
      expect(gearFor(GEARS[i].at)).toBe(i);
    }
  });

  it("holds a gear until intensity falls GEAR_DROP below it, then drops back", () => {
    expect(gearFor(0.7 - GEAR_DROP / 2, 3)).toBe(3);
    expect(gearFor(0.7 - GEAR_DROP * 1.5, 3)).toBe(2);
    expect(gearFor(0.7 - GEAR_DROP / 2, 2)).toBe(2); // not yet up
    expect(gearFor(0, 3)).toBe(0); // a big clear-down falls straight through
  });

  it("never passes the song's top gear", () => {
    expect(gearFor(1, 0, 2)).toBe(2);
    expect(gearFor(1, 0, 0)).toBe(0);
  });
});

describe("songTempo", () => {
  it("is the gear's BPM, rising with each gear, with a big step into danger", () => {
    for (const s of SONGS) {
      for (let g = 1; g < s.gears.length; g++) expect(songTempo(s, g)).toBeGreaterThan(songTempo(s, g - 1));
    }
    for (const id of ["gridline", "afterburn", "undertow"]) {
      const s = song(id);
      expect(songTempo(s, 3) - songTempo(s, 2)).toBeGreaterThanOrEqual(15);
    }
  });

  it("clamps the gear to the song and scales with the boost", () => {
    const zen = song("tidepool");
    expect(songTempo(zen, 3)).toBe(songTempo(zen, 2));
    expect(songTempo(song("afterburn"), 3, BLITZ_BOOST)).toBeCloseTo(162 * 1.25);
  });
});

describe("musicIntensity", () => {
  const calm = { danger: 0, stackRows: 0, combo: 0, boost: 1 };
  const gearAt = (over: Partial<typeof calm & { garbage: number }>) => gearFor(musicIntensity({ ...calm, ...over }));

  it("is 0 on an empty board with no combo: the calm gear", () => {
    expect(musicIntensity(calm)).toBe(0);
    expect(gearAt({})).toBe(0);
  });

  it("climbs a gear at 3, 8 and 14 rows of stack", () => {
    expect(gearAt({ stackRows: 2 })).toBe(0);
    expect(gearAt({ stackRows: 3 })).toBe(1);
    expect(gearAt({ stackRows: 7 })).toBe(1);
    expect(gearAt({ stackRows: 8 })).toBe(2);
    expect(gearAt({ stackRows: 13 })).toBe(2);
    expect(gearAt({ stackRows: 14 })).toBe(3);
    let prev = 0;
    for (let rows = 0; rows <= 20; rows++) {
      const i = musicIntensity({ ...calm, stackRows: rows });
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
  });

  it("counts incoming garbage on top of the stack (Versus)", () => {
    expect(gearAt({ stackRows: 6, garbage: 0 })).toBe(1);
    expect(gearAt({ stackRows: 6, garbage: 8 })).toBe(3);
  });

  it("rises with a running combo, but a combo alone never reaches danger", () => {
    expect(gearAt({ combo: 1 })).toBe(1);
    expect(gearAt({ combo: 3 })).toBe(2);
    expect(gearAt({ combo: 20 })).toBe(2);
  });

  it("follows danger when it is the strongest signal", () => {
    expect(musicIntensity({ ...calm, stackRows: 12, danger: 0.9 })).toBe(0.9);
  });

  it("drives Blitz's final 30 s: drive at 30 s left, danger by 15 s left, full at time-up", () => {
    expect(musicIntensity({ ...calm, boost: blitzBoost(5400, 7200) })).toBe(0);
    expect(gearAt({ boost: blitzBoost(5401, 7200) })).toBe(2);
    expect(gearAt({ boost: blitzBoost(6300, 7200) })).toBe(3);
    expect(musicIntensity({ ...calm, boost: blitzBoost(7200, 7200) })).toBe(1);
  });
});

describe("blitzBoost", () => {
  it("is 1 until 30 s remain, then ramps to 1.25 at time-up", () => {
    expect(blitzBoost(0, 7200)).toBe(1);
    expect(blitzBoost(5400, 7200)).toBe(1);
    expect(blitzBoost(7200, 7200)).toBe(BLITZ_BOOST);
    expect(BLITZ_BOOST).toBe(1.25);
  });

  it("increases strictly between 5400 and 7200 frames", () => {
    let prev = blitzBoost(5400, 7200);
    for (let f = 5430; f <= 7200; f += 30) {
      const b = blitzBoost(f, 7200);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
  });

  it("makes the music faster than the base tempo after 90 s of Blitz", () => {
    const blitz = song("afterburn");
    expect(songTempo(blitz, 1, blitzBoost(95 * 60, 7200))).toBeGreaterThan(songTempo(blitz, 1));
  });
});

describe("comboNotes", () => {
  it("adds nothing at combo 0", () => {
    expect(comboNotes(0, scale)).toEqual([]);
  });

  it("grows in length and register up to the combo-8 cap", () => {
    for (let c = 2; c <= COMBO_CAP; c++) {
      expect(comboNotes(c, scale).length).toBeGreaterThan(comboNotes(c - 1, scale).length);
      expect(comboNotes(c, scale)[0]).toBeGreaterThan(comboNotes(c - 1, scale)[0]);
    }
    expect(COMBO_CAP).toBe(8);
    expect(comboNotes(12, scale)).toEqual(comboNotes(COMBO_CAP, scale));
  });

  it("stays in the scale", () => {
    const inScale = new Set(Array.from({ length: 50 }, (_, d) => degreeFreq(scale, d - 14).toFixed(3)));
    for (const f of comboNotes(COMBO_CAP, scale)) expect(inScale.has(f.toFixed(3))).toBe(true);
  });
});

describe("panForColumn", () => {
  it("pans left to right across the board within ±0.7", () => {
    expect(panForColumn(0)).toBeLessThan(0);
    expect(panForColumn(9)).toBeGreaterThan(0);
    expect(panForColumn(4.5)).toBe(0);
    for (let x = -3; x <= 12; x += 0.5) expect(Math.abs(panForColumn(x))).toBeLessThanOrEqual(0.7);
    for (let x = 1; x <= 9; x++) expect(panForColumn(x)).toBeGreaterThan(panForColumn(x - 1));
  });
});

describe("sound packs", () => {
  it("has exactly 3 packs with unique ids and every field", () => {
    expect(SOUND_PACKS.map((p) => p.name)).toEqual(["Arcade", "Glass", "Neon"]);
    expect(new Set(SOUND_PACKS.map((p) => p.id)).size).toBe(3);
    for (const p of SOUND_PACKS) {
      expect(p.scale.steps).toHaveLength(7);
      for (const t of [p.sfx.bright, p.sfx.soft, p.sfx.edge, p.music.pad, p.music.bass, p.music.arp, p.music.lead]) {
        expect(["sine", "square", "sawtooth", "triangle"]).toContain(t.type);
        expect(t.detune).toBeGreaterThanOrEqual(0);
        expect(t.fm).toBeGreaterThanOrEqual(0);
      }
      for (const n of [p.sfx.brightness, p.sfx.attack, p.sfx.decay, p.music.brightness, p.music.padAttack, p.music.bassGain]) {
        expect(n).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to the first pack for an unknown id", () => {
    expect(packById("nope")).toBe(SOUND_PACKS[0]);
    expect(packById("neon").name).toBe("Neon");
  });
});

describe("songs", () => {
  it("has one Auto song per mode and for the menu, with unique ids", () => {
    expect(new Set(SONGS.map((s) => s.id)).size).toBe(SONGS.length);
    for (const where of ["menu", ...MODES.map((m) => m.id)]) {
      expect(SONGS.filter((s) => s.mode === where)).toHaveLength(1);
    }
  });

  it("gives each song its own key, chord loop and base tempo", () => {
    const keys = SONGS.map((s) => `${s.scale.root}:${s.scale.steps.join()}`);
    expect(new Set(keys).size).toBe(SONGS.length);
    expect(new Set(SONGS.map((s) => s.progression.join())).size).toBe(SONGS.length);
    expect(new Set(SONGS.map((s) => s.gears[0].bpm)).size).toBe(SONGS.length);
  });

  it("is well-formed data", () => {
    for (const s of SONGS) {
      expect(s.scale.steps).toHaveLength(7);
      expect(s.progression.length).toBeGreaterThan(0);
      expect(s.gears.length).toBeGreaterThanOrEqual(1);
      expect(s.gears.length).toBeLessThanOrEqual(GEARS.length);
      for (const g of s.gears) {
        for (const p of [g.kick, g.snare, g.hat, g.pad]) if (p) expect(p).toMatch(/^[.xX]+$/);
        for (const p of [g.bass, g.arp, g.lead]) if (p) expect(p).toMatch(/^[.0-9]+$/);
      }
    }
  });

  it("matches each mode's feel: 40 LINES four-on-the-floor, Zen with no danger gear, Versus in a minor mode", () => {
    for (const g of song("gridline").gears) for (const beat of [0, 4, 8, 12]) expect(g.kick![beat]).toMatch(/[xX]/);
    expect(song("tidepool").gears).toHaveLength(3);
    expect(song("undertow").scale.steps[2]).toBe(3); // minor third
    expect(song("lantern").gears[0].bpm).toBeLessThan(song("gridline").gears[0].bpm);
  });

  it("picks the song for the mode on Auto, one song everywhere when fixed, none when off", () => {
    expect(songFor("auto", "menu")!.id).toBe("lantern");
    expect(songFor("auto", "40l")!.id).toBe("gridline");
    expect(songFor("auto", "blitz")!.id).toBe("afterburn");
    expect(songFor("auto", "vs")!.id).toBe("undertow");
    expect(songFor("auto", "zen")!.id).toBe("tidepool");
    expect(songFor("afterburn", "zen")!.id).toBe("afterburn");
    expect(songFor("afterburn", "menu")!.id).toBe("afterburn");
    expect(songFor("off", "40l")).toBeNull();
  });
});

describe("loadSettings audio fields", () => {
  const store = new Map<string, string>();
  const stub = (saved: unknown) => {
    store.set("teza:settings", JSON.stringify(saved));
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    store.clear();
  });

  it("defaults to Arcade, Auto music at 60% and SFX 60%", () => {
    const d = defaultSettings();
    expect(d.soundPack).toBe("arcade");
    expect(d.musicTrack).toBe("auto");
    expect(d.musicVolume).toBe(0.6);
    expect(d.volume).toBe(0.6);
  });

  it("fills in a missing musicVolume and soundPack from older saves", () => {
    stub({ volume: 0.3 });
    const s = loadSettings();
    expect(s.volume).toBe(0.3);
    expect(s.musicVolume).toBe(0.6);
    expect(s.soundPack).toBe("arcade");
    expect(s.musicTrack).toBe("auto");
  });

  it("loads a save from before music tracks existed unchanged, on Auto", () => {
    stub({ volume: 0.5, musicVolume: 0.4, soundPack: "neon" });
    const s = loadSettings();
    expect([s.volume, s.musicVolume, s.soundPack, s.musicTrack]).toEqual([0.5, 0.4, "neon", "auto"]);
  });

  it("keeps a valid musicTrack and falls back to Auto for an unknown one", () => {
    for (const t of ["off", "auto", "tidepool"]) {
      stub({ musicTrack: t });
      expect(loadSettings().musicTrack).toBe(t);
    }
    stub({ musicTrack: "chiptune-remix" });
    expect(loadSettings().musicTrack).toBe("auto");
    stub({ musicTrack: 4 });
    expect(loadSettings().musicTrack).toBe("auto");
  });

  it("falls back to the default for an invalid soundPack or musicVolume", () => {
    stub({ soundPack: "dubstep", musicVolume: "loud" });
    expect(loadSettings().soundPack).toBe("arcade");
    expect(loadSettings().musicVolume).toBe(0.6);
    stub({ soundPack: 3, musicVolume: 7 });
    expect(loadSettings().soundPack).toBe("arcade");
    expect(loadSettings().musicVolume).toBe(0.6);
  });

  it("keeps a valid saved pack and volume", () => {
    stub({ soundPack: "glass", musicVolume: 0 });
    expect(loadSettings().soundPack).toBe("glass");
    expect(loadSettings().musicVolume).toBe(0);
  });
});
