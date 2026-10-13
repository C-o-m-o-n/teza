import { context } from "esbuild";
import { cpSync, mkdirSync, watch } from "node:fs";

// `node build.mjs`          → one production build into dist/
// `node build.mjs --serve`  → rebuild on every change and serve dist/ on http://localhost:3000
const serve = process.argv.includes("--serve");
const port = Number(process.env.PORT) || 3000;

const copyStatic = {
  name: "copy-static",
  setup(b) {
    b.onEnd(() => {
      cpSync("index.html", "dist/index.html");
      cpSync("style.css", "dist/style.css");
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
  // index.html and style.css aren't imported by the bundle, so esbuild doesn't see them change
  for (const file of ["index.html", "style.css"]) watch(file, () => cpSync(file, `dist/${file}`));
  await ctx.serve({ servedir: "dist", port });
  console.log(`TEZA running at http://localhost:${port}  (rebuilds on save, Ctrl+C to stop)`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("built dist/");
}
