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
  { runtime: false, outcome: "applied", confirmed: true },
  { runtime: false, outcome: "applied", confirmed: false },
  { runtime: false, outcome: "stale", confirmed: true },
  { runtime: false, outcome: "changed_state", confirmed: true },
  { runtime: false, outcome: "stopped_source", confirmed: true },
  { runtime: false, outcome: "stopped_source", confirmed: false },
  { runtime: false, outcome: "stopped_source_conflict", confirmed: false },
  { runtime: false, outcome: "stopped_source_rollback", confirmed: false },
] as const)(
  "observed provider failure (runtime=$runtime, $outcome, exit confirmed=$confirmed)",
  async ({ runtime, outcome, confirmed }) => {
    const { db, people, sharedGoldenId, openaiCredentialId } = await failureDatabase();
    const boat = fakeBoat();
    const machine = await boat.provider.fork({ from: "snapshot" });
    const id = crypto.randomUUID();
    const now = new Date("2026-01-01T00:00:00Z");
    const from = outcome.startsWith("stopped_source") ? "stopped" : "ready";
    const previousStop = from === "stopped" ? "2025-12-31T00:00:00.000Z" : null;
    const applied = outcome === "applied" || outcome === "stopped_source";
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime,stopped_at)
     values ($1,'boat',$2,$3,$4,$5,'codex',$7,$6,$8)`,
      [id, machine.id, sharedGoldenId, people.org, people.owner, runtime, from, previousStop],
    );
    const store = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const sandbox = (await store.get(id))!;
    const diagnostic = confirmed || from === "stopped" ? "Provider reported a runtime failure. ".repeat(100) : "";
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
    if (outcome === "changed_state") await db.query("update sandboxes set status='running' where id=$1", [id]);
    if (outcome === "stopped_source_conflict")
      await db.query("update sandboxes set status='ready',stopped_at=null where id=$1", [id]);
    const existingStatus =
      outcome === "changed_state" ? "running" : outcome === "stopped_source_rollback" ? "stopped" : "ready";
    if (outcome === "stopped_source_rollback")
      await db.exec(`create function reject_failure_journal() returns trigger language plpgsql as $$
      begin raise exception 'Failure journal rejected'; end $$;
      create trigger reject_failure_journal before insert on sandbox_transitions
      for each row execute function reject_failure_journal();`);
    if (outcome === "rollback")
      await db.exec("alter table sandboxes add constraint reject_observed_exit check (stopped_at is null)");
    if (outcome === "release_failed")
      await db.exec(`create function reject_reservation_release() returns trigger language plpgsql as $$
      begin raise exception 'Reservation release failed'; end $$;
      create trigger reject_reservation_release before delete on account_agent_reservations
      for each row execute function reject_reservation_release();`);
    try {
      const read = readStatus(boat.provider, store, sandbox, { now });
      if (outcome === "rollback") await expect(read).rejects.toThrow("reject_observed_exit");
      else if (outcome === "stopped_source_rollback") await expect(read).rejects.toThrow("Failure journal rejected");
      else if (outcome === "release_failed") await expect(read).rejects.toThrow("Reservation release failed");
      else expect(await read).toMatchObject({ status: applied ? "failed" : existingStatus });

      const journal = await db.query(
        "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
        [id],
      );
      const row = await store.get(id);
      const reservation = await db.query("select sandbox_id from account_agent_reservations where sandbox_id=$1", [id]);
      expect(reservation.rows).toEqual(applied && confirmed ? [] : [{ sandbox_id: id }]);
      if (from === "stopped" && !confirmed) {
        const { rows } = await db.query("select dispatch_generation::int from account_turn_queue where sandbox_id=$1", [
          id,
        ]);
        expect(rows).toEqual([{ dispatch_generation: sandbox.lifecycleGeneration }]);
      }
      if (applied) {
        expect(journal.rows).toEqual([
          {
            from_status: from,
            to_status: "failed",
            actor: from === "stopped" && confirmed ? "runtime_observation" : "lifecycle_runner",
            code: runtime ? "runtime_provider_failure" : "native_provider_failure",
            generation: sandbox.lifecycleGeneration,
          },
        ]);
        expect(row).toMatchObject({
          status: "failed",
          statusReason: diagnostic ? diagnostic.slice(0, 2000) : null,
          stoppedAt: confirmed ? now.toISOString() : previousStop,
        });
      } else {
        expect(journal.rows).toEqual([]);
        expect(row).toMatchObject({
          status: existingStatus,
          statusReason: null,
          stoppedAt: existingStatus === "stopped" ? previousStop : null,
        });
      }
    } finally {
      if (outcome === "rollback") await db.exec("alter table sandboxes drop constraint reject_observed_exit");
      if (outcome === "stopped_source_rollback")
        await db.exec(
          "drop trigger reject_failure_journal on sandbox_transitions; drop function reject_failure_journal()",
        );
      if (outcome === "release_failed")
        await db.exec(
          "drop trigger reject_reservation_release on account_agent_reservations; drop function reject_reservation_release()",
        );
    }
  },
);

test.each([
  { runtime: true, scenario: "ready" },
  { runtime: true, scenario: "running" },
  { runtime: true, scenario: "stale" },
  { runtime: true, scenario: "release_failed" },
  { runtime: false, scenario: "ready" },
  { runtime: false, scenario: "failed" },
  { runtime: false, scenario: "stale" },
  { runtime: false, scenario: "changed_state" },
  { runtime: false, scenario: "release_failed" },
] as const)(
  "a confirmed stop journals only a current observation (runtime=$runtime, $scenario)",
  async ({ runtime, scenario }) => {
    const { db, people, sharedGoldenId, openaiCredentialId } = await failureDatabase();
    const boat = fakeBoat();
    const machine = await boat.provider.fork({ from: "snapshot" });
    if (scenario === "failed") await boat.provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
    await boat.provider.stop({ sandboxId: machine.id });
    const stoppedAt = new Date("2026-01-01T00:00:00Z");
    boat.sandbox(machine.id).info.stoppedAt = stoppedAt;
    const id = crypto.randomUUID();
    const from = scenario === "running" || scenario === "failed" ? scenario : "ready";
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
    if (scenario === "changed_state") await db.query("update sandboxes set status='running' where id=$1", [id]);
    if (scenario === "release_failed" && !runtime)
      await db.query(
        `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,
          input_hash,input_enc,conversation_id,state,dispatch_generation)
         values ($1,$2,$3,$4,$5,1,1,'hash','data','conversation','dispatching',$6)`,
        [id, crypto.randomUUID(), openaiCredentialId, people.owner, people.org, sandbox.lifecycleGeneration],
      );
    if (scenario === "release_failed")
      await db.exec(`create function reject_stop_release() returns trigger language plpgsql as $$
        begin raise exception 'Stop reservation release failed'; end $$;
        create trigger reject_stop_release before delete on account_agent_reservations
        for each row execute function reject_stop_release();`);
    const applied = scenario === "ready" || scenario === "running" || scenario === "failed";
    const expectedStatus = applied ? "stopped" : scenario === "changed_state" ? "running" : from;
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

test.each([
  { from: "stopped", to: "ready", outcome: "applied" },
  { from: "stopped", to: "running", outcome: "applied" },
  { from: "stopped", to: "running", outcome: "stale source" },
  { from: "stopped", to: "ready", outcome: "journal failure" },
  { from: "failed", to: "ready", outcome: "applied" },
  { from: "failed", to: "running", outcome: "applied" },
  { from: "failed", to: "running", outcome: "stale source" },
  { from: "failed", to: "ready", outcome: "confirmed exit" },
  { from: "stopped", to: "starting", outcome: "applied" },
  { from: "running", to: "stopping", outcome: "applied" },
  { from: "ready", to: "starting", outcome: "stale source" },
  { from: "failed", to: "stopping", outcome: "confirmed exit" },
  { from: "ready", to: "stopping", outcome: "journal failure" },
  { from: "stopped", to: "starting", outcome: "commit failure" },
] as const)("native provider observation $from -> $to ($outcome)", async ({ from, to, outcome }) => {
  const { db, people, sharedGoldenId } = await failureDatabase();
  const boat = fakeBoat();
  const machine = await boat.provider.fork({ from: "snapshot" });
  const turn = await boat.provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
  const phase = to === "starting" || to === "stopping";
  if (phase) boat.sandbox(machine.id).info.state = to;
  if (to === "ready") boat.finish(machine.id, turn.promptId, "finished");
  const stoppedAt = "2026-01-01T00:00:00.000Z";
  const statusReason = from === "failed" ? "Previous provider failure" : null;
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,task_prompt_id,stopped_at,status_reason)
     values ($1,'boat',$2,$3,$4,$5,'codex',$6,$7,$8,$9)`,
    [
      id,
      machine.id,
      sharedGoldenId,
      people.org,
      people.owner,
      from,
      turn.promptId,
      from === "stopped" ? stoppedAt : null,
      statusReason,
    ],
  );
  const store = createSqlData(db)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const sandbox = (await store.get(id))!;
  const staleState = from === "failed" ? "ready" : "failed";
  if (outcome === "stale source")
    await db.query("update sandboxes set status=$2,stopped_at=null,status_reason=null where id=$1", [id, staleState]);
  if (outcome === "confirmed exit") await db.query("update sandboxes set stopped_at=$2 where id=$1", [id, stoppedAt]);
  const commitFails = outcome === "commit failure";
  const rollback = commitFails || outcome === "journal failure";
  const rejected = commitFails ? "Observation commit rejected" : "Observation journal rejected";
  if (rollback)
    await db.exec(`create function reject_availability_journal() returns trigger language plpgsql as $$
      begin raise exception '${rejected}'; end $$;
      ${
        commitFails
          ? "create constraint trigger reject_availability_journal after insert on sandbox_transitions deferrable initially deferred"
          : "create trigger reject_availability_journal before insert on sandbox_transitions"
      }
      for each row execute function reject_availability_journal();`);

  const applied = outcome === "applied";
  const status = applied ? to : outcome === "stale source" ? staleState : from;
  try {
    const observation = readStatus(boat.provider, store, sandbox, { now: new Date("2026-01-01") });
    if (rollback) await expect(observation).rejects.toThrow(rejected);
    else expect(await observation).toMatchObject({ status });
    expect(await store.get(id)).toMatchObject({
      status,
      stoppedAt: status === "stopped" || outcome === "confirmed exit" ? stoppedAt : null,
      statusReason: applied || outcome === "stale source" ? null : statusReason,
      lifecycleGeneration: sandbox.lifecycleGeneration,
      stopRequestedAt: null,
    });
    const { rows } = await db.query(
      "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
      [id],
    );
    expect(rows).toEqual(
      applied
        ? [
            {
              from_status: from,
              to_status: to,
              actor: phase ? "lifecycle_runner" : "native_turn",
              code: phase ? "native_provider_phase" : "native_provider_available",
              generation: sandbox.lifecycleGeneration,
            },
          ]
        : [],
    );
  } finally {
    if (rollback)
      await db.exec(
        "drop trigger reject_availability_journal on sandbox_transitions; drop function reject_availability_journal()",
      );
  }
});

test.each([
  { from: "ready", to: "running", stale: false },
  { from: "running", to: "ready", stale: false },
  { from: "ready", to: "running", stale: true },
] as const)("native turn observation $from -> $to (stale=$stale)", async ({ from, to, stale }) => {
  const { db, people, sharedGoldenId } = await failureDatabase();
  const boat = fakeBoat();
  const machine = await boat.provider.fork({ from: "snapshot" });
  const turn = await boat.provider.prompt({ sandboxId: machine.id, harness: "codex", text: "work" });
  if (to === "ready") boat.finish(machine.id, turn.promptId, "finished");
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,task_prompt_id)
     values ($1,'boat',$2,$3,$4,$5,'codex',$6,$7)`,
    [id, machine.id, sharedGoldenId, people.org, people.owner, from, turn.promptId],
  );
  const store = createSqlData(db)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const sandbox = (await store.get(id))!;
  if (stale)
    await db.query("update sandboxes set status='failed', status_reason='Concurrent failure' where id=$1", [id]);

  const status = stale ? "failed" : to;
  const statusReason = stale ? "Concurrent failure" : null;
  expect(await readStatus(boat.provider, store, sandbox, { now: new Date("2026-01-01") })).toMatchObject({
    status,
    statusReason,
  });
  expect(await store.get(id)).toMatchObject({ status, statusReason, lifecycleGeneration: sandbox.lifecycleGeneration });
  const { rows } = await db.query(
    "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
    [id],
  );
  expect(rows).toEqual(
    stale
      ? []
      : [
          {
            from_status: from,
            to_status: to,
            actor: "native_turn",
            code: to === "running" ? "native_turn_running" : "native_turn_settled",
            generation: sandbox.lifecycleGeneration,
          },
        ],
  );
});

test.each(["accepted", "already running", "stale state", "expired lease"] as const)(
  "native steer publication preserves the activity fence (%s)",
  async (scenario) => {
    const { db, people, sharedGoldenId } = await failureDatabase();
    const id = crypto.randomUUID();
    const activityToken = crypto.randomUUID();
    const generation = 1;
    const deadline = scenario === "expired lease" ? "-infinity" : "infinity";
    const running = scenario === "already running" || scenario === "expired lease";
    const status = running ? "running" : scenario === "stale state" ? "failed" : "ready";
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,
        activity_lease_id,activity_until,lifecycle_generation)
       values ($1,'boat','placement',$2,$3,$4,'codex',$5,$6,$7,$8)`,
      [id, sharedGoldenId, people.org, people.owner, status, activityToken, deadline, generation],
    );
    const store = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const completed = scenario === "accepted" || scenario === "already running";
    const publication = store.update(id, {
      nativeSteerReceipt: { fromState: status === "running" ? "running" : "ready", placement: "placement" },
      taskPromptId: "accepted",
      conversationIds: ["conversation"],
      finishActivity: true,
      expectedGeneration: generation,
      activityToken,
    });
    if (completed) await publication;
    else await expect(publication).rejects.toThrow();
    expect(await store.get(id)).toMatchObject({
      status: completed ? "running" : status,
      lifecycleGeneration: generation + Number(completed),
      taskPromptId: completed ? "accepted" : null,
      conversationIds: completed ? ["conversation"] : [],
    });
    expect((await db.query("select activity_lease_id from sandboxes where id=$1", [id])).rows).toEqual([
      { activity_lease_id: completed ? null : activityToken },
    ]);
    const { rows } = await db.query(
      "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1",
      [id],
    );
    expect(rows).toHaveLength(scenario === "accepted" ? 1 : 0);
    if (scenario === "accepted")
      expect(rows[0]).toEqual({
        from_status: "ready",
        to_status: "running",
        actor: "native_turn",
        code: "native_steer_accepted",
        generation,
      });
  },
);
