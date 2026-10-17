import { afterEach, describe, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings";
import { THEMES, themeById } from "../src/ui/themes";

function storage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("theme registry", () => {
  it("lists Classic then Poster Slab, with unique ids", () => {
    expect(THEMES.map((t) => [t.id, t.name])).toEqual([["classic", "Classic"], ["poster", "Poster Slab"]]);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it("falls back to Classic for an unknown id", () => {
    expect(themeById("poster").name).toBe("Poster Slab");
    expect(themeById("nope").id).toBe("classic");
  });
});

describe("theme setting", () => {
  it("defaults to classic, also for saved settings from before themes", () => {
    expect(defaultSettings().theme).toBe("classic");
    storage();
    expect(loadSettings().theme).toBe("classic");
    storage({ "teza:settings": JSON.stringify({ volume: 0.2 }) });
    expect(loadSettings().theme).toBe("classic");
  });

  it("falls back to classic for an unknown or invalid id", () => {
    for (const theme of ["neon", "", 3, null, { id: "poster" }]) {
      storage({ "teza:settings": JSON.stringify({ theme }) });
      expect(loadSettings().theme).toBe("classic");
    }
  });

  it("round-trips poster", () => {
    const store = storage();
    saveSettings({ ...defaultSettings(), theme: "poster" });
    expect(JSON.parse(store.get("teza:settings")!).theme).toBe("poster");
    expect(loadSettings().theme).toBe("poster");
  });
});

describe("index.html pre-paint script", () => {
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1];

  /** Runs the inline script with `saved` as teza:settings; returns the data-theme and theme-color it set. */
  function boot(getItem: () => string | null) {
    const root = { dataset: {} as Record<string, string> };
    const meta = { content: "" };
    const document = { documentElement: root, querySelector: () => meta };
    new Function("document", "localStorage", source)(document, { getItem });
    return [root.dataset.theme, meta.content];
  }

  it("knows every registry theme and its theme-color", () => {
    for (const t of THEMES) expect(boot(() => JSON.stringify({ theme: t.id }))).toEqual([t.id, t.themeColor]);
  });

  it("falls back to classic and never throws", () => {
    const classic = ["classic", "#08080f"];
    expect(boot(() => null)).toEqual(classic);
    expect(boot(() => "{not json")).toEqual(classic);
    expect(boot(() => JSON.stringify({ theme: "toString" }))).toEqual(classic);
    expect(boot(() => { throw new Error("storage blocked"); })).toEqual(classic);
  });
});
