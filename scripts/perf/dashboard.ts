/** See apps/dashboard/performance.ts; inputs are environment variables, never token argv. */
import { join } from "node:path";

const env: Record<string, string> = {};
for (const key of [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DASHBOARD_STORAGE_STATE",
  "DASHBOARD_PERF_URL",
  "DASHBOARD_PERF_PATH",
  "DASHBOARD_PERF_SAMPLES",
  "DASHBOARD_PERF_MOCK",
  "DASHBOARD_PERF_MOCK_URL",
  "DASHBOARD_PERF_BUNDLE_ONLY",
  "DASHBOARD_PERF_SCREENSHOT",
]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}
const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../apps/dashboard/performance.ts")], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
  env,
});
process.exitCode = await child.exited;
