import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Owns production composition, not just the adapter: SDK HTTP + SSH are the only fake I/O.
test("real serve Boat parents dispatch turns, expose events, archive, reactivate and retire", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/serve-boat-orchestrators.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  timer.unref();
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw Error(`Boat serve regression failed:\n${err}\n${out}`);
    const receipt = JSON.parse(
      out
        .split("\n")
        .find((line) => line.startsWith("SERVE_BOAT_RECEIPT "))!
        .slice("SERVE_BOAT_RECEIPT ".length),
    );
    expect(receipt.prompts).toBe(7);
    expect(receipt.stops).toBe(6);
    expect(receipt.sandboxSkills).toBe(true);
    expect(receipt.sshCalls).toBeGreaterThan(0);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 60000);
