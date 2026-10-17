import { context } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";

// `node build.mjs`          → one production build into dist/
// `node build.mjs --serve`  → rebuild on every change and serve dist/ on http://localhost:3000
const serve = process.argv.includes("--serve");
const port = Number(process.env.PORT) || 3000;

const files = ["index.html", "style.css", "manifest.webmanifest"];
const dirs = ["fonts", "icons", "og"];

// The service worker's cache name carries a hash of everything it precaches, so each new build
// gets a fresh cache. In --serve mode dist/sw.js is a no-op worker instead (no fetch handler, and it
// clears any caches a production build left on this origin), so live rebuilds are never served stale.
const NOOP_SW = `// Dev (--serve) build: no-op service worker. See build.mjs.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
`;

function writeServiceWorker() {
  if (serve) return writeFileSync("dist/sw.js", NOOP_SW);
  const hash = createHash("sha256");
  const inputs = ["dist/game.js", "sw.js", ...files, ...dirs.flatMap((d) => readdirSync(d).sort().map((f) => `${d}/${f}`))];
  for (const file of inputs) hash.update(file).update(readFileSync(file));
  const id = hash.digest("hex").slice(0, 12);
  writeFileSync("dist/sw.js", readFileSync("sw.js", "utf8").replaceAll("__BUILD_ID__", id));
}

const copyStatic = {
  name: "copy-static",
  setup(b) {
    b.onEnd(() => {
      for (const file of files) cpSync(file, `dist/${file}`);
      for (const dir of dirs) cpSync(dir, `dist/${dir}`, { recursive: true });
      writeServiceWorker();
    });
  },
};

mkdirSync("dist", { recursive: true });
const ctx = await context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/game.js",
  minify: !serve,
  sourcemap: true,
  plugins: [copyStatic],
});

if (serve) {
  await ctx.watch();
  // The static files aren't imported by the bundle, so esbuild doesn't see them change
  for (const file of files) watch(file, () => cpSync(file, `dist/${file}`));
  for (const dir of dirs) watch(dir, () => cpSync(dir, `dist/${dir}`, { recursive: true }));
  watch("sw.js", writeServiceWorker);
  await ctx.serve({ servedir: "dist", port });
  console.log(`TEZA running at http://localhost:${port}  (rebuilds on save, Ctrl+C to stop)`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("built dist/");
}
