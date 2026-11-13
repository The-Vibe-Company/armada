import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real CLI boundary must answer help before opening private state or reading stdin.
test("Docker host help succeeds without registration, state or Docker access", () => {
  for (const args of [
    [],
    ["--help"],
    ["-h"],
    ["register", "--help"],
    ["run", "-h"],
    ["install", "--help"],
    ["status", "--help"],
    ["uninstall", "--help"],
  ]) {
    const child = Bun.spawnSync([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/nonexistent", HOME: "/nonexistent" },
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString()).toContain("Usage:");
    expect(child.stdout.toString()).toContain("Registration reads a one-use token from stdin");
    expect(child.stdout.toString()).not.toContain("failed");
  }
});

// Status must work before registration and never attempts a network/Docker call.
test("Docker host status identifies an unregistered installation without Docker access", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-host-status-"));
  try {
    const child = Bun.spawnSync([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "status"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/nonexistent", HOME: home },
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    const status = JSON.parse(child.stdout.toString());
    expect(status.registered).toBe(false);
    expect(status.connected).toBe(false);
    expect(typeof status.version).toBe("string");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
