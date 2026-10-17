// Interface themes (README "Brand"). A theme is an entry here plus its rules in style.css, scoped under
// html[data-theme="<id>"]; Classic is the style whenever the attribute is absent or unknown. App sets the
// attribute from the saved setting, and index.html's pre-paint script does so before the first paint
// (its id -> theme-color map must list every entry; test/themes.test.ts checks it).

export interface Theme {
  id: string;
  name: string; // shown in CONFIG > STYLE
  tagline: string;
  themeColor: string; // <meta name="theme-color">
}

/** In CONFIG order. The first is the default. */
export const THEMES: Theme[] = [
  { id: "classic", name: "Classic", tagline: "Stepped bars", themeColor: "#08080f" },
  { id: "poster", name: "Poster Slab", tagline: "Red slab", themeColor: "#0b0b0c" },
];

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
