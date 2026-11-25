import { expect, test } from "bun:test";
import { capabilities } from "@armada/core/server";
import { testMachineConformance } from "../../core/test-support/machine-conformance.ts";
import { createBoatMachine, createBoatProvider } from "../src/index.ts";
import { retainedSandbox, sandbox } from "./support.ts";

type Fixture = ReturnType<Parameters<typeof testMachineConformance>[1]["fixture"]>;
type Sandbox = { id: string; state: string; labels: Record<string, string>; createdAt: string };
function fixture(stopOptions: Pick<Parameters<typeof createBoatMachine>[0], "stopBinding" | "onStopped"> = {}) {
  const rows = new Map<string, { account: string; sandbox: Sandbox; workspace: string; bindings: Set<string> }>();
  const replays = new Map<string, string>();
  return {
    adapter({ deploymentId, bindingId }, fault) {
      const fetchBoat = (async (url: string, init?: RequestInit) => {
        const [, id, action] = new URL(url).pathname.slice("/api/v1/".length).split("/");
        const row = rows.get(id ?? "");
        if (init?.method === "GET") {
          const scoped = [...rows.values()].filter(({ account }) => account === bindingId);
          if (!id) return Response.json({ sandboxes: scoped.map(({ sandbox }) => sandbox) });
          if (row?.account === bindingId) return Response.json({ sandbox: row.sandbox });
          return Response.json({ error: "missing" }, { status: 404 });
        }
        if (action === "stop" && row && id) {
          fault?.("archive:before");
          const stop = { id: "stop", status: "completed" };
          row.sandbox = { ...retainedSandbox({ stop }), id, labels: row.sandbox.labels };
          fault?.("archive:after");
          return Response.json({ sandbox: row.sandbox });
        }
        const op = id ? "resume" : "create";
        fault?.(`${op}:before`);
        const replay = bindingId + new Headers(init?.headers).get("Idempotency-Key");
        const machineId = replays.get(replay) ?? `machine-${rows.size + 1}`;
        if (!replays.has(replay)) {
          const { labels } = JSON.parse(String(init?.body));
          const data = { ...sandbox(), id: machineId, state: "running", labels };
          rows.set(machineId, {
            account: bindingId,
            sandbox: data,
            workspace: row?.workspace ?? "",
            bindings: new Set(),
          });
          replays.set(replay, machineId);
        }
        fault?.(`${op}:after`);
        return Response.json({ sandbox: rows.get(machineId)?.sandbox });
      }) as typeof fetch;
      const options = { apiKey: "fixture", deploymentId, fetch: fetchBoat, ...stopOptions };
      return createBoatMachine(
        options,
        createBoatProvider(options),
        async ({ bindingRef }) => ({
          serverUrl: "https://armada.test",
          enrolmentToken: bindingRef,
          cacheDir: "/fixture",
          artifact: { sha256: "", bytes: 1 },
        }),
        async () => {},
        async (_host, request) => {
          fault?.("bootstrap:before");
          rows.get(request.sandboxId)?.bindings.add(request.enrolmentToken);
          fault?.("bootstrap:after");
        },
      );
    },
    liveMachines: () =>
      [...rows.values()]
        .filter(({ sandbox }) => sandbox.state !== "archived")
        .map(({ account, sandbox }) => ({
          machineId: sandbox.id,
          bindingId: account,
          deploymentId: sandbox.labels["armada.deployment_id"]!,
          sandboxId: sandbox.labels.sandbox!,
          generation: Number(sandbox.labels.generation),
          createdAt: new Date(sandbox.createdAt),
        })),
    committedRetention: () => undefined,
    runtimeBindings: ({ machineId }) => Array.from(rows.get(machineId)?.bindings ?? []),
    writeWorkspace({ machineId }, content) {
      const row = rows.get(machineId);
      if (row) row.workspace = content;
    },
    readWorkspace: ({ machineId }) => rows.get(machineId)?.workspace,
  } satisfies Fixture;
}
testMachineConformance("Boat Machine", {
  fixture,
  capabilities: capabilities("boat"),
  inventory: true,
  lostCreateResponseStep: "create:after",
  faultSteps: {
    create: ["create:before", "create:after"],
    bootstrap: ["bootstrap:before", "bootstrap:after"],
    stop: ["archive:before", "archive:after"],
    resume: ["resume:before", "resume:after"],
    delete: ["archive:before", "archive:after"],
  },
});

test("a resumed Boat stop receipts the logical generation and replays without another archive", async () => {
  const target = { sandboxId: "sandbox-a", generation: 3, machineId: "machine-1" };
  const binding = { deploymentId: "deployment-a", bindingId: "account" };
  let archives = 0;
  const exits: (Date | undefined)[] = [];
  const machine = fixture({
    stopBinding: { ...target, launchGeneration: 1 },
    onStopped: (at) => exits.push(at),
  }).adapter(binding, (step) => {
    if (step === "archive:before") archives++;
  });
  const original = await machine.create({
    sandboxId: target.sandboxId,
    generation: 1,
    source: { kind: "snapshot", ref: "golden" },
    size: null,
    computeTtlSeconds: 60,
  });
  expect(original.machineId).toBe(target.machineId);
  await expect(machine.stop({ ...target, generation: 4, retain: true })).rejects.toThrow("incarnation changed");
  const receipt = { sandboxId: target.sandboxId, generation: 3, kind: "disk", ref: target.machineId } as const;
  expect(await machine.stop({ ...target, retain: true })).toEqual(receipt);
  expect(await machine.stop({ ...target, retain: true })).toEqual(receipt);
  expect(archives).toBe(1);
  expect(exits.map((at) => at?.toISOString())).toEqual(["2026-11-09T10:00:00.000Z", "2026-11-09T10:00:00.000Z"]);
});
