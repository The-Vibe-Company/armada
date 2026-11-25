import { expect, test } from "bun:test";
import type { SandboxPatch } from "@armada/core";
import { sandboxOperations } from "@armada/core/contract";
import { createSqlData, type SandboxView, type ServerSandboxStore } from "../src/data.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { settleBoatStop } from "../src/sandbox-lifecycle.ts";
import { readStatus, recordedStatus } from "../src/turns.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const failureDatabase = rowOnlyDatabase();

async function queueExtension(
  db: Awaited<ReturnType<typeof failureDatabase>>["db"],
  sandboxId: string,
  orgId: string,
  generation: number,
) {
  const jobId = await createJobsStore(db, ENCRYPTION_KEY).enqueue(
    "boat_runtime_extend",
    sandboxId,
    generation,
    sandboxId,
    null,
    {
      orgId,
      maxAttempts: 3,
      deadline: new Date("2099-01-01"),
    },
  );
  await db.query("insert into public.boat_runtime_extension_state(sandbox_id,pending_job_id) values($1,$2)", [
    sandboxId,
    jobId,
  ]);
  return jobId;
}

const rejectExtensionDetach =
  "alter table public.boat_runtime_extension_state add constraint reject_detach check (pending_job_id is not null)";
const allowExtensionDetach = "alter table public.boat_runtime_extension_state drop constraint reject_detach";

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
    modalTransport: scenario.provider === "modal" ? "dialout" : undefined,
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
    provider: scenario.provider,
    status: scenario.machine,
    settled: scenario.prompt === "finished",
    prompt: { state: scenario.prompt },
  });
  expect(updates).toEqual([]);
});

test.each(["boat", "modal"] as const)(
  "recordedStatus and readStatus return provider=%s for stopped sandboxes and satisfy sandbox/status output schema",
  async (providerName) => {
    const sandbox = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: providerName,
      golden: "base",
      visibility: "private",
      harness: "codex",
      providerSandboxId: `${providerName}-sbx-1`,
      repositoryDir: null,
      machineSize: null,
      model: null,
      reasoningEffort: null,
      status: "stopped",
      statusReason: null,
      stoppedAt: "2026-01-01T00:00:00.000Z",
      taskPromptId: null,
      conversationIds: [],
    } as unknown as SandboxView;
    const recorded = recordedStatus(sandbox);
    expect(recorded.provider).toBe(providerName);
    expect(
      sandboxOperations.sandboxStatus.output.parse({
        ...recorded,
        timeLeftSeconds: null,
        expiringSoon: false,
      }),
    ).toMatchObject({ id: sandbox.id, provider: providerName, status: "stopped" });

    const provider = {
      id: providerName,
      getPrompt: async () => {
        throw new Error("unexpected");
      },
      events: async () => ({ events: [], hasMore: false }),
    };
    const store = { update: async () => {} } as unknown as ServerSandboxStore;
    const observed = await readStatus(provider, store, sandbox, { now: new Date(2000), stored: true });
    expect(observed.provider).toBe(providerName);
  },
);

test.each([
  { recorded: "ready", observed: "starting", reported: "ready" },
  { recorded: "running", observed: "stopping", reported: "stopping" },
  { recorded: "failed", observed: "running", reported: "failed" },
  { recorded: "stopped", observed: "running", reported: "stopped" },
] as const)("runtime $recorded with provider $observed does not publish a machine change", async (scenario) => {
  const boat = fakeBoat();
  const machine = await boat.provider.fork({ from: "snapshot" });
  const turn = await boat.provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
  boat.sandbox(machine.id).info.state = scenario.observed;
  const sandbox = {
    id: "sandbox",
    provider: "boat",
    boatRuntime: true,
    harness: "codex",
    providerSandboxId: machine.id,
    status: scenario.recorded,
    statusReason: scenario.recorded === "failed" ? "Machine failed." : null,
    lifecycleGeneration: 2,
    stoppedAt: scenario.recorded === "stopped" ? new Date(1000).toISOString() : null,
    taskPromptId: turn.promptId,
    conversationIds: [],
  } as unknown as SandboxView;
  const updates: SandboxPatch[] = [];
  const store = {
    update: async (_id: string, patch: SandboxPatch) => {
      updates.push(patch);
    },
  } as unknown as ServerSandboxStore;

  expect(await readStatus(boat.provider, store, sandbox, { now: new Date(2000) })).toMatchObject({
    status: scenario.reported,
    statusReason: sandbox.statusReason,
    ...(scenario.reported === "stopping" ? { settled: false } : {}),
  });
  expect(updates).toEqual([]);
});

test.each([
  { runtime: true, outcome: "applied", confirmed: true },
  { runtime: true, outcome: "applied", confirmed: false },
  { runtime: true, outcome: "stale", confirmed: true },
  { runtime: true, outcome: "rollback", confirmed: true },
  { runtime: true, outcome: "release_failed", confirmed: true },
  { runtime: true, outcome: "cleanup_failed", confirmed: true },
] as const)(
  "observed provider failure (runtime=$runtime, $outcome, exit confirmed=$confirmed)",
  async ({ runtime, outcome, confirmed }) => {
    const { db, people, sharedGoldenId, openaiCredentialId } = await failureDatabase();
    const boat = fakeBoat();
    const machine = await boat.provider.fork({ from: "snapshot" });
    const id = crypto.randomUUID();
    const now = new Date("2026-01-01T00:00:00Z");
    const applied = outcome === "applied";
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime,stopped_at)
     values ($1,'boat',$2,$3,$4,$5,'codex','ready',$6,null)`,
      [id, machine.id, sharedGoldenId, people.org, people.owner, runtime],
    );
    const store = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const sandbox = (await store.get(id))!;
    if (sandbox.lifecycleGeneration === undefined) throw new Error("Missing sandbox generation.");
    const pendingJobId = runtime ? await queueExtension(db, id, people.org, sandbox.lifecycleGeneration) : null;
    const diagnostic = confirmed ? "Provider reported a runtime failure. ".repeat(100) : "";
    await db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,
      input_hash,input_enc,conversation_id,state,dispatch_generation)
     values ($1,$2,$3,$4,$5,1,1,'hash','data','conversation','dispatching',$6)`,
      [id, crypto.randomUUID(), openaiCredentialId, people.owner, people.org, sandbox.lifecycleGeneration],
    );
    await db.query("insert into account_agent_reservations(sandbox_id,account_id) values ($1,$2)", [
      id,
      openaiCredentialId,
    ]);
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
    if (outcome === "release_failed")
      await db.exec(`create function reject_reservation_release() returns trigger language plpgsql as $$
      begin raise exception 'Reservation release failed'; end $$;
      create trigger reject_reservation_release before delete on account_agent_reservations
      for each row execute function reject_reservation_release();`);
    if (outcome === "cleanup_failed") await db.exec(rejectExtensionDetach);
    try {
      const read = readStatus(boat.provider, store, sandbox, { now });
      if (outcome === "rollback") await expect(read).rejects.toThrow("reject_observed_exit");
      else if (outcome === "release_failed") await expect(read).rejects.toThrow("Reservation release failed");
      else if (outcome === "cleanup_failed") await expect(read).rejects.toThrow("reject_detach");
      else expect(await read).toMatchObject({ status: applied ? "failed" : "ready" });

      const journal = await db.query(
        "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
        [id],
      );
      const row = await store.get(id);
      if (pendingJobId)
        expect(
          (await db.query("select pending_job_id from public.boat_runtime_extension_state where sandbox_id=$1", [id]))
            .rows,
        ).toEqual([{ pending_job_id: applied && confirmed ? null : pendingJobId }]);
      const reservation = await db.query("select sandbox_id from account_agent_reservations where sandbox_id=$1", [id]);
      expect(reservation.rows).toEqual(applied && confirmed ? [] : [{ sandbox_id: id }]);
      if (applied) {
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
          statusReason: diagnostic ? diagnostic.slice(0, 2000) : null,
          stoppedAt: confirmed ? now.toISOString() : null,
        });
      } else {
        expect(journal.rows).toEqual([]);
        expect(row).toMatchObject({
          status: "ready",
          statusReason: null,
          stoppedAt: null,
        });
      }
    } finally {
      if (outcome === "cleanup_failed") await db.exec(allowExtensionDetach);
      if (outcome === "rollback") await db.exec("alter table sandboxes drop constraint reject_observed_exit");
      if (outcome === "release_failed")
        await db.exec(
          "drop trigger reject_reservation_release on account_agent_reservations; drop function reject_reservation_release()",
        );
    }
  },
);

test.each([false, true])(
  "owner stop settles an already failed Boat activation and its extension together (reject detach=%s)",
  async (rejectDetach) => {
    const { db, people, sharedGoldenId } = await failureDatabase();
    const id = crypto.randomUUID();
    const activityToken = crypto.randomUUID();
    await db.query(
      `insert into public.sandboxes
     (id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime,
      activity_lease_id,activity_until,lifecycle_generation,stop_requested_at)
     values ($1,'boat','bx_23456789',$2,$3,$4,'codex','failed',true,$5,'infinity',2,now())`,
      [id, sharedGoldenId, people.org, people.owner, activityToken],
    );
    const jobId = await queueExtension(db, id, people.org, 1);
    const store = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const stoppedAt = "2026-01-01T00:00:00.000Z";
    if (rejectDetach) await db.exec(rejectExtensionDetach);
    try {
      const stop = db.transaction!((tx) => settleBoatStop(tx, id, 2, null, new Date(stoppedAt)));
      if (rejectDetach) await expect(stop).rejects.toThrow("reject_detach");
      else await stop;
      expect(await store.get(id)).toMatchObject({ status: "failed", stoppedAt: rejectDetach ? null : stoppedAt });
      expect(
        (await db.query("select pending_job_id from public.boat_runtime_extension_state where sandbox_id=$1", [id]))
          .rows,
      ).toEqual([{ pending_job_id: rejectDetach ? jobId : null }]);
      expect((await db.query("select id from public.sandbox_transitions where sandbox_id=$1", [id])).rows).toEqual([]);
    } finally {
      if (rejectDetach) await db.exec(allowExtensionDetach);
    }
  },
);

test.each([
  { runtime: true, scenario: "ready" },
  { runtime: true, scenario: "running" },
  { runtime: true, scenario: "stale" },
  { runtime: true, scenario: "release_failed" },
] as const)(
  "a confirmed stop journals only a current observation (runtime=$runtime, $scenario)",
  async ({ runtime, scenario }) => {
    const { db, people, sharedGoldenId, openaiCredentialId } = await failureDatabase();
    const boat = fakeBoat();
    const machine = await boat.provider.fork({ from: "snapshot" });
    await boat.provider.stop({ sandboxId: machine.id });
    const stoppedAt = new Date("2026-01-01T00:00:00Z");
    boat.sandbox(machine.id).info.stoppedAt = stoppedAt;
    const id = crypto.randomUUID();
    const from = scenario === "running" ? scenario : "ready";
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime)
       values ($1,'boat',$2,$3,$4,$5,'codex',$6,$7)`,
      [id, machine.id, sharedGoldenId, people.org, people.owner, from, runtime],
    );
    await db.query("insert into account_agent_reservations(sandbox_id,account_id) values ($1,$2)", [
      id,
      openaiCredentialId,
    ]);
    const store = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const sandbox = (await store.get(id))!;
    const renewedExpiry = "2026-01-03T00:00:00.000Z";
    if (scenario === "stale")
      await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1,expires_at=$2 where id=$1", [
        id,
        renewedExpiry,
      ]);
    if (scenario === "release_failed")
      await db.exec(`create function reject_stop_release() returns trigger language plpgsql as $$
        begin raise exception 'Stop reservation release failed'; end $$;
        create trigger reject_stop_release before delete on account_agent_reservations
        for each row execute function reject_stop_release();`);
    const applied = scenario === "ready" || scenario === "running";
    const expectedStatus = applied ? "stopped" : from;
    try {
      const observation = readStatus(boat.provider, store, sandbox, { now: new Date("2026-01-02T00:00:00Z") });
      if (scenario === "release_failed") await expect(observation).rejects.toThrow("Stop reservation release failed");
      else
        expect(await observation).toMatchObject({
          status: expectedStatus,
          statusReason: null,
          ...(scenario === "stale" ? { expiresAt: renewedExpiry } : {}),
        });
      expect(await store.get(id)).toMatchObject({
        status: expectedStatus,
        statusReason: null,
        stoppedAt: applied ? stoppedAt.toISOString() : null,
      });
      const { rows: journal } = await db.query(
        "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
        [id],
      );
      expect(journal).toEqual(
        applied
          ? [
              {
                from_status: from,
                to_status: "stopped",
                actor: "runtime_observation",
                code: runtime ? "runtime_provider_stopped" : "native_provider_stopped",
                generation: sandbox.lifecycleGeneration,
              },
            ]
          : [],
      );
      const { rows: reservations } = await db.query(
        "select sandbox_id from account_agent_reservations where sandbox_id=$1",
        [id],
      );
      expect(reservations).toEqual(applied ? [] : [{ sandbox_id: id }]);
    } finally {
      if (scenario === "release_failed")
        await db.exec(
          "drop trigger reject_stop_release on account_agent_reservations; drop function reject_stop_release()",
        );
    }
  },
);
