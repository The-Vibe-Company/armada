import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";
import { e2eFixture, fixtureOrigin } from "./scripts/fixture-ports.ts";

const app = {
  url: fixtureOrigin(e2eFixture.dashboardPort),
  command: {
    executable: "bun",
    reuseExisting: false,
    args: ["scripts/dev.ts", "--e2e"],
    startupTimeout: 120_000,
    log: ".e2e/logs/dashboard.log",
  },
};

export default {
  tests: "test/dashboard/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  trace: "on",
  targets: [
    { name: "desktop", engine: web({ viewport: { width: 1280, height: 800 } }), app },
    { name: "phone", engine: web({ viewport: { width: 375, height: 812 } }), app },
  ],
} satisfies E2EConfig;
