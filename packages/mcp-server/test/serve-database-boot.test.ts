import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Isolate Bun.SQL/clock mocks while exercising actual startServer composition and HTTP readiness.
test("startServer retries real Supavisor admission errors before serving and closes both pools on exhaustion", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/serve-database-boot.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`Startup boundary failed:\n${err}\n${out}`);
  expect(out).toContain("BOOT_RETRY_SERVE_AND_EXHAUSTION_VERIFIED");
}, 30_000);
