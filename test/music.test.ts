import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLITZ_BOOST, COMBO_CAP, LAYERS, LAYER_DROP, blitzBoost, comboNotes, layerLevels, musicIntensity, nextLayerLevels, tempoFor,
} from "../src/audio/music";
import { SOUND_PACKS, degreeFreq, packById } from "../src/audio/packs";
import { panForColumn } from "../src/audio/sfx";
import { defaultSettings, loadSettings } from "../src/settings";

const scale = SOUND_PACKS[0].scale;

describe("tempoFor", () => {
  it("runs 100 BPM at danger 0 to 150 BPM at danger 1", () => {
    expect(tempoFor(0, 1)).toBe(100);
    expect(tempoFor(1, 1)).toBe(150);
  });

  it("rises monotonically with danger and scales with the boost", () => {
    let prev = tempoFor(0, 1);
    for (let d = 0.05; d <= 1.0001; d += 0.05) {
      const t = tempoFor(d, 1);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    expect(tempoFor(0.5, 1.25)).toBeCloseTo(125 * 1.25);
    expect(tempoFor(2, 1)).toBe(150);
  });
});

describe("layerLevels", () => {
  it("plays only the pad at danger 0 and every layer at danger 1", () => {
    const low = layerLevels(0);
    expect(low.pad).toBeGreaterThan(0);
    expect([low.bass, low.arp, low.lead]).toEqual([0, 0, 0]);
    const high = layerLevels(1);
    for (const l of LAYERS) expect(high[l.id]).toBeGreaterThan(0);
  });

  it("brings each layer in at its threshold", () => {
    for (const l of LAYERS.filter((l) => l.at > 0)) {
      expect(layerLevels(l.at - 0.01)[l.id]).toBe(0);
      expect(layerLevels(l.at)[l.id]).toBeGreaterThan(0);
    }
    expect(LAYERS.map((l) => l.at)).toEqual([0, 0.15, 0.4, 0.7]);
  });
});

describe("musicIntensity", () => {
  const calm = { danger: 0, stackRows: 0, combo: 0, boost: 1 };
  const layersAt = (over: Partial<typeof calm>) => layerLevels(musicIntensity({ ...calm, ...over }));

  it("is 0 on an empty board with no combo, so only the pad plays", () => {
    expect(musicIntensity(calm)).toBe(0);
  });

  it("brings in bass+kick in a normal mid-game stack and arpeggio+hats from 10 rows", () => {
    expect(layersAt({ stackRows: 3 }).bass).toBe(0);
    expect(layersAt({ stackRows: 4 }).bass).toBe(1);
    expect(layersAt({ stackRows: 8 }).arp).toBe(0);
    expect(layersAt({ stackRows: 10 }).arp).toBe(1);
    expect(layersAt({ stackRows: 12 }).lead).toBe(0);
    let prev = 0;
    for (let rows = 0; rows <= 20; rows++) {
      const i = musicIntensity({ ...calm, stackRows: rows });
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
  });

  it("rises with a running combo", () => {
    expect(layersAt({ combo: 1 }).bass).toBe(1);
    expect(layersAt({ combo: 3 }).arp).toBe(1);
    expect(musicIntensity({ ...calm, combo: 20 })).toBeLessThan(0.7);
  });

  it("follows danger when it is the strongest signal", () => {
    expect(musicIntensity({ ...calm, stackRows: 18, danger: 0.9 })).toBe(0.9);
  });

  it("brings the arpeggio in for Blitz's final 30 s and reaches full intensity at time-up", () => {
    expect(musicIntensity({ ...calm, boost: blitzBoost(5400, 7200) })).toBe(0);
    expect(layersAt({ boost: blitzBoost(5401, 7200) }).arp).toBe(1);
    expect(musicIntensity({ ...calm, boost: blitzBoost(7200, 7200) })).toBe(1);
    // tempo through Blitz's final 30 s on an empty board: 100 BPM -> 187.5 BPM
    expect(tempoFor(musicIntensity({ ...calm, boost: blitzBoost(6300, 7200) }), blitzBoost(6300, 7200))).toBeGreaterThan(150);
    expect(tempoFor(1, BLITZ_BOOST)).toBe(187.5);
  });
});

describe("nextLayerLevels", () => {
  it("keeps a playing layer on until intensity drops LAYER_DROP below its threshold", () => {
    const off = layerLevels(0);
    const on = nextLayerLevels(0.4, off);
    expect(on.arp).toBe(1);
    expect(nextLayerLevels(0.4 - LAYER_DROP / 2, on).arp).toBe(1);
    expect(nextLayerLevels(0.4 - LAYER_DROP * 1.5, on).arp).toBe(0);
    expect(nextLayerLevels(0.4 - LAYER_DROP / 2, off).arp).toBe(0);
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
    expect(tempoFor(0.3, blitzBoost(95 * 60, 7200))).toBeGreaterThan(tempoFor(0.3, 1));
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
      expect(p.progression.length).toBeGreaterThan(0);
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

  it("defaults to Arcade, music 40% and SFX 60%", () => {
    const d = defaultSettings();
    expect(d.soundPack).toBe("arcade");
    expect(d.musicVolume).toBe(0.4);
    expect(d.volume).toBe(0.6);
  });

  it("fills in a missing musicVolume and soundPack from older saves", () => {
    stub({ volume: 0.3 });
    const s = loadSettings();
    expect(s.volume).toBe(0.3);
    expect(s.musicVolume).toBe(0.4);
    expect(s.soundPack).toBe("arcade");
  });

  it("falls back to the default for an invalid soundPack or musicVolume", () => {
    stub({ soundPack: "dubstep", musicVolume: "loud" });
    expect(loadSettings().soundPack).toBe("arcade");
    expect(loadSettings().musicVolume).toBe(0.4);
    stub({ soundPack: 3, musicVolume: 7 });
    expect(loadSettings().soundPack).toBe("arcade");
    expect(loadSettings().musicVolume).toBe(0.4);
  });

  it("keeps a valid saved pack and volume", () => {
    stub({ soundPack: "glass", musicVolume: 0 });
    expect(loadSettings().soundPack).toBe("glass");
    expect(loadSettings().musicVolume).toBe(0);
  });
});
