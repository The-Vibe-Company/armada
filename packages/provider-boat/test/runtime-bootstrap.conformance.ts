import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatRuntimeBootstrapScript } from "../src/runtime-bootstrap.ts";

// This boundary starts the real detached executable, not a mocked spawn receipt.
// No provider/network/model call; the bootstrap's HTTPS peer is a preload fixture.
test.skipIf(process.platform !== "linux")(
  "Boat bootstrap verifies cold/warm bytes and never executes a digest mismatch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-runtime-"));
    try {
      const marker = join(root, "started");
      const uid = process.getuid?.(),
        gid = process.getgid?.();
      if (uid === undefined || gid === undefined) throw Error("Linux identity required");
      const executable = `#!/bin/sh
set -eu
[ "$1" = dialout ]
[ -z "\${ARMADA_GIT_TOKEN+x}" ]
input=$(cat)
case "$input" in
  '{"serverUrl":"https://armada.invalid","enrolmentToken":"armada_enrol_'*'"}') ;;
  *) exit 1 ;;
esac
printf started > '${marker}'
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
      const progress = join(root, "progress");
      await writeFile(progress, "", { mode: 0o600 }); // Root bootstrap appends under umask 077; keep fixture readable by its owner.
      const peer = (artifact: string) =>
        `global.fetch=async(url,options)=>{if(String(url).endsWith('/progress')){require('node:fs').appendFileSync(${JSON.stringify(progress)},JSON.parse(options.body).stage+'\\n');return new Response('{}');}return new Response(${JSON.stringify(artifact)});};`;
      await writeFile(preload, peer(executable));
      const cache = join(root, "cache");
      const script = boatRuntimeBootstrapScript("https://armada.invalid", artifact, cache);
      const run = () =>
        spawnSync(
          "sudo",
          [
            "-n",
            "--preserve-env=NODE_OPTIONS,ARMADA_GIT_TOKEN",
            "unshare",
            "--mount",
            "--propagation",
            "private",
            "bash",
            "-c",
            // The runner has /home/runner, not Boat's /home/user. Supply the
            // guest filesystem privately; never depend on or modify the host home.
            `set -e; mount -t tmpfs tmpfs /home; mkdir /home/user; chown ${uid}:${gid} /home/user; exec bash`,
          ],
          {
            input: script,
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
          },
        );
      const coldStarted = started();
      const cold = run();
      expect([cold.status, cold.stdout, cold.stderr]).toEqual([0, "", ""]);
      await coldStarted;
      expect(await readFile(marker, "utf8")).toBe("started");
      expect((await stat(marker)).uid).toBe(uid);
      expect(await readFile(join(cache, artifact.sha256), "utf8")).toBe(executable);
      await writeFile(preload, "global.fetch=async()=>{throw Error('network forbidden')};");
      await rm(marker);
      const warmStarted = started();
      expect(run().status).toBe(0);
      await warmStarted;
      expect((await readFile(progress, "utf8")).trim().split("\n")).toEqual(["bootstrap_started", "artifact_verified"]);
      const corrupt = "x".repeat(artifact.bytes);
      await writeFile(join(cache, artifact.sha256), corrupt);
      await writeFile(preload, peer("y".repeat(artifact.bytes)));
      const bad = run();
      expect([bad.status, bad.stdout, bad.stderr]).toEqual([1, "", ""]);
      expect(await readFile(join(cache, artifact.sha256), "utf8")).toBe(corrupt);
      expect((await readFile(progress, "utf8")).trim().split("\n").slice(-2)).toEqual([
        "bootstrap_started",
        "bootstrap_failed",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
