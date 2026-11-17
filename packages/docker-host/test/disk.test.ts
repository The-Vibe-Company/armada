import { expect, test } from "bun:test";
import { DOCKER_DISK_FLOOR_BYTES, DockerDiskFloorError } from "../../core/src/docker-disk-policy.ts";
import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";
import { stoppedSandboxBytes, withDiskFloor } from "../src/disk.ts";

test("fresh disk proof gates allocating work at the floor but never gates cleanup", async () => {
  const effects: string[] = [];
  let samples = 0;
  let free: number | null = DOCKER_DISK_FLOOR_BYTES - 1;
  const executor = withDiskFloor(
    {
      async create() {
        effects.push("create");
      },
      async resume() {
        effects.push("resume");
      },
      async stop() {
        effects.push("stop");
      },
      async delete() {
        effects.push("delete");
      },
      async stopIfExpired() {
        effects.push("expire");
      },
    },
    async () => {
      samples++;
      return free;
    },
  );
  const request = {} as DockerMachineRequest;
  for (const unavailable of [free, null, -1, NaN]) {
    free = unavailable;
    await expect(executor.create(request)).rejects.toBeInstanceOf(DockerDiskFloorError);
    await executor.resume!(request);
  }
  expect(effects).toEqual(["resume", "resume", "resume", "resume"]);
  expect(samples).toBe(4);
  await executor.stop(request);
  await executor.delete(request);
  await executor.stopIfExpired(request);
  free = DOCKER_DISK_FLOOR_BYTES;
  await executor.create(request);
  expect(effects).toEqual(["resume", "resume", "resume", "resume", "stop", "delete", "expire", "create"]);
});

test("stopped usage counts owned writable layers and each attached volume once, or reports unknown", async () => {
  const state = { installationId: "installation", hostId: "host" };
  let wrongOwner = false;
  const cli = {
    async run(args: readonly string[]) {
      if (args[1] === "ls") return { exitCode: 0, stdout: "abcdef123456\nabcdef123457" };
      if (args[1] === "inspect") {
        const labels = JSON.stringify({
          "dev.armada.machine.installation": wrongOwner ? "other" : state.installationId,
          "dev.armada.machine.host": state.hostId,
        });
        return { exitCode: 0, stdout: `${labels}\t"exited"\t100\thome,\n${labels}\t"exited"\t100\thome,\n` };
      }
      return { exitCode: 0, stdout: "unrelated|9GB\nhome|1.2GB\n" };
    },
  };
  expect(await stoppedSandboxBytes(cli, state)).toBe(1_200_000_200);
  wrongOwner = true;
  expect(await stoppedSandboxBytes(cli, state)).toBeNull();
});

test("stopped usage inspects a large inventory in bounded compact chunks", async () => {
  const state = { installationId: "installation", hostId: "host" };
  const ids = Array.from({ length: 1000 }, (_, index) => index.toString(16).padStart(12, "0"));
  const labels = JSON.stringify({
    "dev.armada.machine.installation": state.installationId,
    "dev.armada.machine.host": state.hostId,
  });
  const chunks: number[] = [];
  let inspectedBytes = 0;
  const cli = {
    async run(args: readonly string[]) {
      if (args[1] === "ls") return { exitCode: 0, stdout: ids.join("\n") };
      if (args[1] === "inspect") {
        const format = args[args.indexOf("--format") + 1];
        expect(format).toContain("{{json .Config.Labels}}");
        expect(format).not.toContain("{{json .}}");
        const chunk = args.slice(args.indexOf("--format") + 2);
        chunks.push(chunk.length);
        const stdout = chunk.map(() => `${labels}\t"exited"\t100\thome,\n`).join("");
        inspectedBytes += Buffer.byteLength(stdout);
        return { exitCode: 0, stdout };
      }
      return { exitCode: 0, stdout: "home|1GB\n" };
    },
  };
  expect(await stoppedSandboxBytes(cli, state)).toBe(1_000_100_000);
  expect(chunks).toEqual(Array(20).fill(50));
  expect(inspectedBytes).toBeLessThan(1024 * 1024);
});
