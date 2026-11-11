import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} drains an admitted HTTP request before exiting successfully`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/shutdown.ts"), signal], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("SIGNAL_DRAIN_VERIFIED");
    } finally {
      child.kill();
    }
  });
}
