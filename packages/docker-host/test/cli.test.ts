import { expect, test } from "bun:test";

// The real CLI boundary must answer help before opening private state or reading stdin.
test("Docker host help succeeds without registration, state or Docker access", () => {
  for (const args of [[], ["--help"], ["-h"], ["register", "--help"], ["run", "-h"]]) {
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
