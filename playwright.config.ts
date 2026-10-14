import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `npm run e2e`: builds dist/, then runs e2e/*.e2e.ts in headless Chromium (see README "End-to-end runs").
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  outputDir: join(tmpdir(), "teza-e2e-results"),
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  use: { browserName: "chromium", serviceWorkers: "block" },
});
