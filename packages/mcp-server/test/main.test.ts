import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

test("standalone server entrypoint reports configuration errors without starting the CLI", async () => {
  const child = spawn(process.execPath, [resolve(import.meta.dir, "../src/main.ts")], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number];
  expect(code).toBe(2);
  expect(stderr).toContain("armada-server:");
  expect(stderr).toContain("Set ARMADA_DATABASE_URL");
});
