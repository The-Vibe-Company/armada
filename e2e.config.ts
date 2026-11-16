import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const app = {
  url: "http://127.0.0.1:3100",
  command: {
    executable: "bun",
    args: ["scripts/dev.ts"],
    startupTimeout: 120_000,
    log: ".e2e/logs/dashboard.log",
  },
};

export default {
  tests: "tests/dashboard/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  trace: "on",
  targets: [
    { name: "desktop", engine: web({ viewport: { width: 1280, height: 800 } }), app },
    { name: "phone", engine: web({ viewport: { width: 375, height: 812 } }), app },
  ],
} satisfies E2EConfig;
