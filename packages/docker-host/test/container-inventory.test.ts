import { expect, test } from "bun:test";
import { createDockerContainerInventory } from "../src/container-inventory.ts";
import type { State } from "../src/daemon.ts";
import { httpApi } from "../src/native.ts";

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
  return [machineId, installationId, hostId, sandbox, generation, created, "/observed-container"]
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
    state,
  );

  expect(await Array.fromAsync(inventory.listInventory())).toEqual([
    {
      machineId: owned,
      deploymentId: `https://armada.example.test/${state.hostId}/${state.installationId}`,
      sandboxId,
      generation,
      createdAt: new Date("2026-11-18T15:01:02.123Z"),
      containerName: "observed-container",
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
    state,
  );
  await expect(Array.fromAsync(inventory.listInventory())).rejects.toThrow("Incomplete Docker container inspection");
});

test("posts a complete authenticated inventory only after the server advertises version one", async () => {
  let capability: number | undefined;
  let scans = 0;
  const reports: unknown[] = [];
  const listing = Promise.withResolvers<void>();
  const api = httpApi(
    (async (url, init) => {
      if (String(url).endsWith("/poll")) return Response.json({ job: null, containerInventory: capability });
      expect(url).toBe(`${state.server}/api/docker-host/container-inventory`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${state.hostToken}`);
      expect(init?.redirect).toBe("error");
      reports.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    undefined,
    undefined,
    undefined,
    {
      cli: {
        async run(argv) {
          if (argv[1] === "ls") {
            scans++;
            await listing.promise;
            return { exitCode: 0, stdout: owned };
          }
          return { exitCode: 0, stdout: inspection(owned, state.installationId, state.hostId, sandboxId) };
        },
      },
      failed: () => reports.push("report failed"),
    },
  );

  await api.poll(state);
  capability = 2;
  await api.poll(state);
  expect(scans).toBe(0);

  capability = 1;
  expect(await api.poll(state, { waitSeconds: 20 })).toMatchObject({ job: null });
  await api.poll(state);
  expect(scans).toBe(1);
  expect(reports).toEqual([]);

  listing.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await api.poll(state);
  expect(scans).toBe(1);
  expect(reports).toEqual([
    {
      installationId: state.installationId,
      containers: [
        {
          machineId: owned,
          sandboxId,
          generation,
          deploymentId: `${state.server}/${state.hostId}/${state.installationId}`,
          containerName: "observed-container",
          createdAt: "2026-11-18T15:01:02.123Z",
        },
      ],
    },
  ]);
});

test("stopping inventory drains the current Docker call and prevents publishing or starting another scan", async () => {
  let scans = 0;
  let reports = 0;
  const listing = Promise.withResolvers<void>();
  const api = httpApi(
    (async (url) => {
      if (String(url).endsWith("/poll")) return Response.json({ job: null, containerInventory: 1 });
      reports++;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    undefined,
    undefined,
    undefined,
    {
      cli: {
        async run() {
          scans++;
          await listing.promise;
          return { exitCode: 0, stdout: "" };
        },
      },
      failed: () => {
        throw new Error("Stopping inventory should not report an error");
      },
    },
  );

  await api.poll(state);
  let drained = false;
  const stopping = api.stopInventory().then(() => {
    drained = true;
  });
  await api.poll(state);
  expect(drained).toBe(false);
  listing.resolve();
  await stopping;
  await api.poll(state);
  expect(scans).toBe(1);
  expect(reports).toBe(0);
});
