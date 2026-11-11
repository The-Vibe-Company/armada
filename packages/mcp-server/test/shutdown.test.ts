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

for (const mode of ["deadline", "failure"]) {
  test(`shutdown ${mode} exits nonzero with a closed reason`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/shutdown.ts"), "SIGTERM", mode], {
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
      expect(code).toBe(1);
      expect(stderr).toBe(
        mode === "deadline"
          ? "armada-server: shutdown deadline exceeded; in-flight work may need reconciliation\n"
          : "armada-server: shutdown failed\n",
      );
      if (mode === "deadline") expect(stdout).toContain("FORCED_STOP_VERIFIED");
    } finally {
      child.kill();
    }
  });
}
