import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatRuntimeBootstrapScript } from "../src/runtime-bootstrap.ts";

// This boundary starts the real detached executable, not a mocked spawn receipt.
// No provider/network/model call; the bootstrap's HTTPS peer is a preload fixture.
test("Boat bootstrap verifies cold/warm bytes and never executes a digest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "boat-runtime-"));
  try {
    const marker = join(root, "started");
    const executable = `#!/usr/bin/node
const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(process.argv[2]!=='dialout'||input.serverUrl!=='https://armada.invalid'||!/^armada_enrol_[a-f0-9]{64}$/.test(input.enrolmentToken)||process.env.ARMADA_GIT_TOKEN)process.exit(1);
fs.writeFileSync(${JSON.stringify(marker)},'started');
`;
    function started() {
      return new Promise<void>((resolve, reject) => {
        const watcher = watch(root, { signal: AbortSignal.timeout(5000) }, (_event, name) => {
          if (name === "started") {
            watcher.close();
            resolve();
          }
        });
        watcher.once("error", reject);
        watcher.once("close", () => reject(Error("runtime did not start")));
      });
    }
    const artifact = {
      sha256: createHash("sha256").update(executable).digest("hex"),
      bytes: Buffer.byteLength(executable),
    };
    const preload = join(root, "peer.cjs");
    await writeFile(preload, `global.fetch=async()=>new Response(${JSON.stringify(executable)});`);
    const cache = join(root, "cache");
    const script = boatRuntimeBootstrapScript("https://armada.invalid", artifact, cache);
    const run = () =>
      spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          NODE_OPTIONS: `--require=${preload}`,
          ARMADA_GIT_TOKEN: JSON.stringify({
            serverUrl: "https://armada.invalid",
            enrolmentToken: `armada_enrol_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`,
          }),
        },
      });
    const coldStarted = started();
    const cold = run();
    expect([cold.status, cold.stdout, cold.stderr]).toEqual([0, "", ""]);
    await coldStarted;
    expect(await readFile(marker, "utf8")).toBe("started");
    expect(await readFile(join(cache, artifact.sha256), "utf8")).toBe(executable);
    await writeFile(preload, "global.fetch=async()=>{throw Error('network forbidden')};");
    await rm(marker);
    const warmStarted = started();
    expect(run().status).toBe(0);
    await warmStarted;
    const corrupt = "x".repeat(artifact.bytes);
    await writeFile(join(cache, artifact.sha256), corrupt);
    await writeFile(preload, `global.fetch=async()=>new Response(${JSON.stringify("y".repeat(artifact.bytes))});`);
    const bad = run();
    expect([bad.status, bad.stdout, bad.stderr]).toEqual([1, "", ""]);
    expect(await readFile(join(cache, artifact.sha256), "utf8")).toBe(corrupt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
