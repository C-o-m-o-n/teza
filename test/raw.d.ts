// Vite's `?raw` imports (used to load sw.js as text in tests).
declare module "*?raw" {
  const text: string;
  export default text;
}
