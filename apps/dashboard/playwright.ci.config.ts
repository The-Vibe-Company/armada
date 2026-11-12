import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Measurement lane: one mock/server/browser worker per isolated CI shard.
// These history/focus suites remain runnable in the full local configuration.
export default defineConfig(base, {
  fullyParallel: true,
  workers: 1,
  retries: 0,
  testIgnore: [
    "**/resource-panel-focus.e2e.ts",
    "**/routines-panel.e2e.ts",
    "**/tools-panel.e2e.ts",
    "**/variables-panel.e2e.ts",
  ],
});
