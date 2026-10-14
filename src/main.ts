import { App } from "./ui/app";

new App(document.getElementById("game") as HTMLCanvasElement, document.getElementById("ui")!);

// Offline support (sw.js). In `npm start` the served sw.js is a no-op worker (build.mjs), so this is harmless in dev.
// A failed registration only means no offline mode; it must never affect the game.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
