import { expect, test } from "bun:test";
import { DOCKER_DISK_FLOOR_BYTES, DockerDiskFloorError } from "../../core/src/docker-disk-policy.ts";
import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";
import { dockerHumanSizeBytes, stoppedSandboxBytes, withDiskFloor } from "../src/disk.ts";

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

test("stopped usage counts owned writable layers and each attached volume once, including pre-start containers", async () => {
  const state = { installationId: "installation", hostId: "host" };
  let wrongOwner = false;
  const cli = {
    async run(args: readonly string[]) {
      if (args[1] === "ls") {
        expect(args.filter((arg) => arg.startsWith("status="))).toEqual([
          "status=exited",
          "status=dead",
          "status=created",
        ]);
        expect(args.filter((arg) => arg === "--filter")).toHaveLength(5);
        return { exitCode: 0, stdout: "abcdef123456\nabcdef123457\nabcdef123458" };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const labels = JSON.stringify({
          "dev.armada.machine.installation": wrongOwner ? "other" : state.installationId,
          "dev.armada.machine.host": state.hostId,
        });
        return {
          exitCode: 0,
          stdout: `${labels}\t"exited"\t100\thome,\n${labels}\t"exited"\t100\thome,\n${labels}\t"created"\t100\tcreated-home,\n`,
        };
      }
      if (args[0] === "system" && args[1] === "df") {
        expect(args).toEqual([
          "system",
          "df",
          "--verbose",
          "--format",
          "{{range .Volumes}}{{.Name}}|{{.Size}}{{println}}{{end}}",
        ]);
        return { exitCode: 0, stdout: "unrelated|9GB\ncreated-home|1000B\nhome|1.2GB\n" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  expect(await stoppedSandboxBytes(cli, state)).toBe(1_200_001_300);
  wrongOwner = true;
  expect(await stoppedSandboxBytes(cli, state)).toBeNull();
});

test("docker human sizes match the SI units and rounding in verbose system df output", () => {
  expect(dockerHumanSizeBytes("0B")).toBe(0);
  expect(dockerHumanSizeBytes("999B")).toBe(999);
  expect(dockerHumanSizeBytes("1.234kB")).toBe(1_234);
  expect(dockerHumanSizeBytes("1.2GB")).toBe(1_200_000_000);
  expect(dockerHumanSizeBytes("2.746MB")).toBe(2_746_000);
  expect(dockerHumanSizeBytes("1.5TB")).toBe(1_500_000_000_000);
  for (const invalid of ["", "N/A", "unknown", "1.2 GiB", "1.2gb", "-1GB", "12XB", "1.2EB"])
    expect(dockerHumanSizeBytes(invalid)).toBeNull();
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
  let volumeOutputBytes = 0;
  let volumeCalls = 0;
  const cli = {
    async run(args: readonly string[], _stdin?: string | Uint8Array, options?: { timeoutMs?: number }) {
      if (args[1] === "ls") return { exitCode: 0, stdout: ids.join("\n") };
      if (args[0] === "container" && args[1] === "inspect") {
        expect(options?.timeoutMs).toBe(3000);
        const format = args[args.indexOf("--format") + 1];
        expect(format).toContain("{{json .Config.Labels}}");
        expect(format).not.toContain("{{json .}}");
        const chunk = args.slice(args.indexOf("--format") + 2);
        chunks.push(chunk.length);
        const stdout = chunk.map((id) => `${labels}\t"exited"\t100\tvolume-${id},\n`).join("");
        inspectedBytes += Buffer.byteLength(stdout);
        return { exitCode: 0, stdout };
      }
      if (args[0] === "system" && args[1] === "df") {
        expect(options?.timeoutMs).toBe(5000);
        volumeCalls++;
        const stdout = ids.map((id) => `volume-${id}|1000B\n`).join("");
        volumeOutputBytes = Buffer.byteLength(stdout);
        return { exitCode: 0, stdout };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  expect(await stoppedSandboxBytes(cli, state)).toBe(1_100_000);
  expect(chunks).toEqual(Array(20).fill(50));
  expect(volumeCalls).toBe(1);
  expect(inspectedBytes).toBeLessThan(1024 * 1024);
  expect(volumeOutputBytes).toBeLessThan(1024 * 1024);
});
