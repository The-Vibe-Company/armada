import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Measurement lane: one mock/server/browser worker per isolated CI shard.
// These history/focus suites remain runnable in the full local configuration.
export default defineConfig(base, {
  fullyParallel: true,
  workers: 1,
  retries: 0,
  // CI run 43305820133: transient fractional sheet width (390.000015 vs 390).
  // Preserve the exact assertion in the full suite; exclude only this one test.
  grepInvert: /on a phone the list fits the width and the panel is a sheet over it$/,
  testIgnore: [
    "**/resource-panel-focus.e2e.ts",
    "**/routines-panel.e2e.ts",
    "**/tools-panel.e2e.ts",
    "**/variables-panel.e2e.ts",
  ],
});
