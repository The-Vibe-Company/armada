import { expect, test } from "bun:test";
import type { SandboxPatch } from "@armada/core";
import { createSqlData, type SandboxView, type ServerSandboxStore } from "../src/data.ts";
import { readStatus } from "../src/turns.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { fakeBoat } from "./support.ts";

const failureDatabase = rowOnlyDatabase();

test.each([
  { usable: true, runtime: false },
  { usable: false, runtime: false },
  { usable: true, runtime: true },
])(
  "live status preserves the finish reason and gates a Boat stop on retention ($usable, runtime=$runtime)",
  async ({ usable, runtime }) => {
    const boat = fakeBoat();
    const provider = boat.providerFor("placeholder");
    const native = await provider.fork({ from: "snapshot" });
    await provider.stop({ sandboxId: native.id });
    if (!usable) boat.sandbox(native.id).info.retainedSnapshot = "pending";
    const sandbox = {
      id: "sandbox",
      provider: "boat",
      boatRuntime: runtime,
      harness: "codex",
      providerSandboxId: native.id,
      status: "ready",
      statusReason: "agent_finished",
      stoppedAt: null,
      taskPromptId: null,
      conversationIds: [],
    } as unknown as SandboxView;
    const patches: SandboxPatch[] = [];
    const store = {
      update: async (_id: string, patch: SandboxPatch) => {
        patches.push(patch);
      },
    } as unknown as ServerSandboxStore;
    expect(await readStatus(provider, store, sandbox, { now: new Date(2000) })).toMatchObject({
      status: usable ? "stopped" : "stopping",
      settled: usable,
      statusReason: "agent_finished",
    });
    expect(patches).toEqual(
      usable ? [expect.objectContaining({ status: "stopped", statusReason: "agent_finished" })] : [],
    );
  },
);

test.each([
  { provider: "boat", machine: "running", prompt: "finished" },
  { provider: "modal", machine: "ready", prompt: "running" },
] as const)("live $provider runtime status reports $prompt without changing the machine", async (scenario) => {
  const boat = fakeBoat();
  const provider = { ...boat.provider, id: scenario.provider };
  const machine = await provider.fork({ from: "snapshot" });
  const turn = await provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
  if (scenario.prompt === "finished") boat.finish(machine.id, turn.promptId, "finished");

  const sandbox = {
    id: "sandbox",
    provider: scenario.provider,
    boatRuntime: scenario.provider === "boat",
    runtimeTransport: scenario.provider === "modal" ? "dialout" : undefined,
    harness: "codex",
    providerSandboxId: machine.id,
    status: scenario.machine,
    statusReason: null,
    lifecycleGeneration: 2,
    stoppedAt: null,
    taskPromptId: turn.promptId,
    conversationIds: [],
  } as unknown as SandboxView;
  const updates: SandboxPatch[] = [];
  const store = {
    update: async (_id: string, patch: SandboxPatch) => {
      updates.push(patch);
    },
  } as unknown as ServerSandboxStore;

  expect(await readStatus(provider, store, sandbox, { now: new Date(2000) })).toMatchObject({
    status: scenario.machine,
    settled: scenario.prompt === "finished",
    prompt: { state: scenario.prompt },
  });
  expect(updates).toEqual([]);
});

test.each([
  { outcome: "applied", confirmed: true },
  { outcome: "applied", confirmed: false },
  { outcome: "stale", confirmed: true },
  { outcome: "rollback", confirmed: true },
] as const)("runtime physical failure ($outcome, exit confirmed=$confirmed)", async ({ outcome, confirmed }) => {
  const { db, people, sharedGoldenId } = await failureDatabase();
  const boat = fakeBoat();
  const machine = await boat.provider.fork({ from: "snapshot" });
  const id = crypto.randomUUID();
  const now = new Date("2026-01-01T00:00:00Z");
  await db.query(
    `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime)
     values ($1,'boat',$2,$3,$4,$5,'codex','ready',true)`,
    [id, machine.id, sharedGoldenId, people.org, people.owner],
  );
  const store = createSqlData(db)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const sandbox = (await store.get(id))!;
  const diagnostic = "Provider reported a runtime failure.";
  Object.assign(boat.sandbox(machine.id).info, {
    state: "failed",
    providerState: "failed",
    error: diagnostic,
    physicalExitConfirmed: confirmed,
  });
  if (outcome === "stale")
    await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
  if (outcome === "rollback")
    await db.exec("alter table sandboxes add constraint reject_observed_exit check (stopped_at is null)");
  try {
    const read = readStatus(boat.provider, store, sandbox, { now });
    if (outcome === "rollback") await expect(read).rejects.toThrow("reject_observed_exit");
    else expect(await read).toMatchObject({ status: outcome === "applied" ? "failed" : "ready" });

    const journal = await db.query(
      "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
      [id],
    );
    const row = await store.get(id);
    if (outcome === "applied") {
      expect(journal.rows).toEqual([
        {
          from_status: "ready",
          to_status: "failed",
          actor: "lifecycle_runner",
          code: "runtime_provider_failure",
          generation: sandbox.lifecycleGeneration,
        },
      ]);
      expect(row).toMatchObject({
        status: "failed",
        statusReason: diagnostic,
        stoppedAt: confirmed ? now.toISOString() : null,
      });
    } else {
      expect(journal.rows).toEqual([]);
      expect(row).toMatchObject({ status: "ready", stoppedAt: null });
    }
  } finally {
    if (outcome === "rollback") await db.exec("alter table sandboxes drop constraint reject_observed_exit");
  }
});
