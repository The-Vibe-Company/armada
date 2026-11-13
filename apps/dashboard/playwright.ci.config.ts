import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Measurement lane: one mock/server/browser worker per isolated CI shard.
// These history/focus suites remain runnable in the full local configuration.
export default defineConfig(base, {
  fullyParallel: true,
  workers: 1,
  retries: 0,
  // Keep measured flaky/over-budget cases in the full suite without relaxing them.
  grepInvert: [
    /on a phone the list fits the width and the panel is a sheet over it$/,
    /delayed usage refreshes a ready session's card and retries a stale refresh without looping$/,
  ],
  testIgnore: [
    "**/resource-panel-focus.e2e.ts",
    "**/routines-panel.e2e.ts",
    "**/tools-panel.e2e.ts",
    "**/variables-panel.e2e.ts",
  ],
});
