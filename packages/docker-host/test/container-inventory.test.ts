import { expect, test } from "bun:test";
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
  return [machineId, installationId, hostId, sandbox, generation, created, "/observed-name"]
    .map((field) => JSON.stringify(field))
    .join("\t");
}

function fixture(run: NonNullable<Parameters<typeof httpApi>[4]>["cli"]["run"]) {
  let capability: number | undefined;
  let now = 0;
  let failures = 0;
  const reports: { url: string; method: string | undefined; authorization: string | null; body: unknown }[] = [];
  const api = httpApi(
    (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/poll")) return Response.json({ job: null, containerInventory: capability });
      reports.push({
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    undefined,
    undefined,
    undefined,
    { cli: { run }, now: () => now, failed: () => failures++ },
  );
  return {
    reports,
    get failures() {
      return failures;
    },
    async poll(version?: number) {
      capability = version;
      await api.poll(state);
      await api.drainInventory?.();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

test("reports a full registration-scoped inventory only when the server advertises support", async () => {
  let scans = 0;
  const host = fixture(async (argv) => {
    if (argv[1] === "ls") {
      scans++;
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
  });

  await host.poll();
  expect(scans).toBe(0);
  await host.poll(1);
  await host.poll(1);
  expect(host.reports).toEqual([
    {
      url: "https://armada.example.test/api/docker-host/container-inventory",
      method: "POST",
      authorization: "Bearer host_token",
      body: {
        installationId: state.installationId,
        containers: [
          {
            machineId: owned,
            deploymentId: `https://armada.example.test/${state.hostId}/${state.installationId}`,
            sandboxId,
            generation,
            createdAt: "2026-11-18T15:01:02.123Z",
            containerName: "observed-name",
          },
        ],
      },
    },
  ]);
  expect(scans).toBe(1);
  expect(host.failures).toBe(0);
});

test("skips an incomplete scan and reports the next complete scan", async () => {
  let complete = false;
  const host = fixture(async (argv) => ({
    exitCode: 0,
    stdout:
      argv[1] === "ls"
        ? [owned, foreign].join("\n")
        : [
            inspection(owned, state.installationId, state.hostId, sandboxId),
            ...(complete ? [inspection(foreign, state.installationId, sandboxId, sandboxId)] : []),
          ].join("\n"),
  }));

  await host.poll(1);
  expect(host.reports).toEqual([]);
  expect(host.failures).toBe(1);

  complete = true;
  host.advance(5 * 60_000);
  await host.poll(1);
  expect(host.reports).toHaveLength(1);
});
