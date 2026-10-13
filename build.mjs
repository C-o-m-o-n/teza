import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/game.js",
  minify: true,
  sourcemap: true,
});
cpSync("index.html", "dist/index.html");
cpSync("style.css", "dist/style.css");
console.log("built dist/");
