import { expect, test } from "bun:test";
import { DEFAULT_DOCKER_DISK_FLOOR_BYTES } from "../../core/src/docker-disk-policy.ts";
import { createDockerDiskSampler, diskFloorBytes, requireDockerDisk } from "../src/disk.ts";

test("disk telemetry measures the selected rootless engine data filesystem rather than the daemon root", async () => {
  const paths: string[] = [];
  const cli = {
    async run(argv: readonly string[]) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          argv[0] === "context" ? "unix:///run/user/1000/docker.sock" : "/home/owner/.local/share/docker",
        ),
      };
    },
  };
  const sample = createDockerDiskSampler(cli, {
    environment: { DOCKER_CONTEXT: "rootless", DOCKER_HOST: "tcp://ignored-remote:2376" },
    filesystem: async (path) => {
      paths.push(path);
      return { bavail: 123n, bsize: 4096n };
    },
  });
  expect(await sample()).toEqual({ freeBytes: 123 * 4096, floorBytes: DEFAULT_DOCKER_DISK_FLOOR_BYTES });
  expect(paths).toEqual(["/home/owner/.local/share/docker"]);
});

test("remote endpoints and unverifiable Docker filesystems report unknown instead of measuring a local lookalike path", async () => {
  for (const endpoint of ["ssh://remote", "tcp://remote:2376", "unix://remote/docker.sock"]) {
    const calls: string[] = [];
    const sample = createDockerDiskSampler(
      {
        run: async () => {
          calls.push("info");
          return { exitCode: 0, stdout: '"/var/lib/docker"' };
        },
      },
      {
        environment: { DOCKER_HOST: endpoint },
        filesystem: async () => {
          calls.push("statfs");
          return { bavail: 1000000000n, bsize: 4096n };
        },
      },
    );
    expect(await sample()).toEqual({ freeBytes: null, floorBytes: DEFAULT_DOCKER_DISK_FLOOR_BYTES });
    expect(calls).toEqual([]);
  }
  const sample = createDockerDiskSampler(
    { run: async () => ({ exitCode: 0, stdout: '"/unreadable/docker"' }) },
    {
      environment: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      filesystem: async () => {
        throw Error("Unavailable");
      },
    },
  );
  expect(await sample()).toEqual({ freeBytes: null, floorBytes: DEFAULT_DOCKER_DISK_FLOOR_BYTES });
});

test("fresh local disk admission enforces the exact configured byte floor and refuses unknown space", async () => {
  expect(diskFloorBytes(undefined)).toBe(10 * 1024 ** 3);
  expect(diskFloorBytes("0")).toBe(0);
  for (const invalid of ["-1", "1.5", "NaN", "9007199254740992"]) expect(() => diskFloorBytes(invalid)).toThrow();
  await requireDockerDisk(async () => ({ freeBytes: 10, floorBytes: 10 }));
  await expect(requireDockerDisk(async () => ({ freeBytes: 9, floorBytes: 10 }))).rejects.toMatchObject({
    code: "disk_full",
  });
  await expect(requireDockerDisk(async () => ({ freeBytes: null, floorBytes: 0 }))).rejects.toMatchObject({
    code: "disk_unavailable",
  });
});
