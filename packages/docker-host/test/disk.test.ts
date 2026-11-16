import { expect, test } from "bun:test";
import { DOCKER_DISK_FLOOR_BYTES, DockerDiskFloorError } from "../../core/src/docker-disk-policy.ts";
import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";
import { withDiskFloor } from "../src/disk.ts";

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
