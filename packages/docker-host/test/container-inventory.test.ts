import { expect, test } from "bun:test";
import { createDockerContainerInventory } from "../src/container-inventory.ts";
import type { State } from "../src/daemon.ts";

const state: State = {
  server: "https://armada.example.test",
  installationId: "11111111-1111-1111-1111-111111111111",
  hostId: "22222222-2222-2222-2222-222222222222",
  hostToken: "host_token",
  receipts: [],
};
const owned = "a".repeat(64);
const foreign = "b".repeat(64);
const untagged = "c".repeat(64);
const sandboxId = "33333333-3333-3333-3333-333333333333";
const generation = "44444444-4444-4444-4444-444444444444";
const created = "2026-11-18T15:01:02.123456789Z";

function inspection(machineId: string, installationId: string, hostId: string, sandbox: string) {
  return [machineId, installationId, hostId, sandbox, generation, created]
    .map((field) => JSON.stringify(field))
    .join("\t");
}

test("lists physical containers for the loaded registration even without local receipts", async () => {
  const inventory = createDockerContainerInventory(
    {
      async run(argv) {
        if (argv[1] === "ls") {
          expect(argv).toContain("--all");
          expect(argv).toContain(`label=dev.armada.machine.installation=${state.installationId}`);
          expect(argv).toContain(`label=dev.armada.machine.host=${state.hostId}`);
          return { exitCode: 0, stdout: [owned, foreign, untagged].join("\n") };
        }
        return {
          exitCode: 0,
          stdout: [
            inspection(owned, state.installationId, state.hostId, sandboxId),
            inspection(foreign, state.installationId, sandboxId, sandboxId),
            inspection(untagged, state.installationId, state.hostId, ""),
          ].join("\n"),
        };
      },
    },
    {
      async load() {
        return state;
      },
    },
  );

  expect(await Array.fromAsync(inventory.listInventory())).toEqual([
    {
      machineId: owned,
      deploymentId: `https://armada.example.test/${state.hostId}/${state.installationId}`,
      sandboxId,
      generation,
      createdAt: new Date("2026-11-18T15:01:02.123Z"),
    },
  ]);
});

test("a container disappearing before inspection makes the inventory incomplete", async () => {
  const inventory = createDockerContainerInventory(
    {
      async run(argv) {
        return { exitCode: 0, stdout: argv[1] === "ls" ? owned : "" };
      },
    },
    {
      async load() {
        return state;
      },
    },
  );
  await expect(Array.fromAsync(inventory.listInventory())).rejects.toThrow("Incomplete Docker container inspection");
});
