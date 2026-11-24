import { expect, test } from "bun:test";
import {
  type ApplicationVaultActor,
  createRoutineService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  promptOutcome,
  type Routine,
  type RoutineLaunchAdmission,
  type Sql,
  createRoutineScheduler as scheduler,
  type TemplateRuntime,
  VaultError,
} from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { enrolledLaunchPolicy } from "./launch-runtime.fixture.ts";
import { modalAdmissionFixture } from "./modal-admission.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Existing terminal-state cases explicitly drain; tick itself only admits work.
function createRoutineScheduler(...args: Parameters<typeof scheduler>) {
  const instance = scheduler(...args);
  return {
    async tick() {
      await instance.tick();
      await instance.drain();
    },
  };
}

const sharedDatabase = rowOnlyDatabase();

// Owns durable scheduler behavior through real SQL + template admission; only physical provider is fake.
async function fixture() {
  const { db, people } = await sharedDatabase();
  const sql: Sql = { query: (s, p) => db.query(s, p), transaction: (work) => db.transaction((tx) => work(tx)) };
  const actor = { userId: people.owner, orgs: [{ orgId: people.org }] };
  const service = createRoutineService(sql),
    templates = createTemplateService(sql),
    boat = fakeBoat();
  const goldenId = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!.id;
  const template = await templates.command(actor, "create", {
    org: people.org,
    scope: "personal",
    name: "Inspect",
    definition: {
      goldenId,
      provider: "boat",
      harness: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      variables: [],
      connections: [],
    },
  });
  const templateId = (template.item as { id: string }).id;
  const data = createSqlData(sql)({ ...actor, orgs: [{ orgId: people.org, role: "member" }], via: "supabase" });
  const credential = (await db.query<{ id: string }>("select id from credentials where kind='openai'")).rows[0]!.id;
  const admit = await modalAdmissionFixture(sql, ENCRYPTION_KEY, createSqlVaultStore(sql), undefined, {
    ...boat.provider,
    managementIdentity: async () => ({ scope: "org", ownerId: people.org }),
  });
  const runtime: TemplateRuntime = {
    stores: {
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      connections: createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, ENCRYPTION_KEY)),
      credentials: {
        resolve: async () => ({
          binding: { credentialId: credential, credentialVersion: 1 },
          env: { OPENAI_API_KEY: "fake" },
          secrets: ["fake"],
          codexAuthJson: false,
        }),
      },
    },
    admitModal: (actor, golden, request, pin) => admit(actor, golden, data, request, { pin }),
    options: { runtime: enrolledLaunchPolicy(sql) },
  };
  const launches: Record<string, unknown>[] = [];
  const launch = async (
    owner: ApplicationVaultActor,
    input: Record<string, unknown>,
    admission: RoutineLaunchAdmission,
  ) => {
    launches.push(input);
    expect(owner.userId).toBe(people.owner);
    return templates.command(owner, "launch", input, {
      ...runtime,
      scheduled: true,
      fenceAdmission: (tx) => admission.beforeFork(tx),
    });
  };
  const observe = async (
    owner: ApplicationVaultActor,
    prompt: { sandboxId: string; promptId: string; conversationId?: string },
  ) => {
    const sandbox = (
      await db.query<{ provider_sandbox_id: string }>(
        "select provider_sandbox_id from sandboxes where id=$1 and owner_id=$2",
        [prompt.sandboxId, owner.userId],
      )
    ).rows[0];
    if (!sandbox) return "unknown" as const;
    return (await promptOutcome(boat.provider, { ...prompt, sandboxId: sandbox.provider_sandbox_id })).state;
  };
  const routine = (
    await service.command(actor, "create", {
      org: people.org,
      scope: "personal",
      name: "Daily",
      templateId,
      templateRevision: 1,
      prompt: "Inspect\nexact bytes",
      intervalHours: 1,
      maxRunsPerDay: 24,
      ttlSeconds: 600,
    })
  ).item as Routine;
  // These cases exercise elapsed intervals; calendar conversion can otherwise add a slot across a minute boundary.
  const due = async (hours = 0) =>
    db.query(
      "update routines set status='enabled',cron=null,next_due_at=now()-($2*interval '1 hour')-interval '1 second' where id=$1",
      [routine.id, hours],
    );
  const runs = async () =>
    (
      await db.query<{
        id: string;
        state: string;
        reason: string | null;
        sandbox_id: string | null;
        request_key: string;
        missed_intervals: number;
      }>("select * from routine_runs where routine_id=$1 order by created_at,id", [routine.id])
    ).rows;
  return {
    db,
    people,
    sql,
    actor,
    service,
    templates,
    boat,
    runtime,
    launch,
    observe,
    launches,
    routine,
    due,
    runs,
    close: async () => {
      await db.exec("reset role; reset all; set search_path=public");
    },
  };
}

test("restart after template success but lost history publication reconciles the durable key without another fork", async () => {
  const f = await fixture();
  try {
    await f.due();
    let fail = true;
    const crashing: Sql = {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!((tx) =>
          work({
            query: (s, p) => {
              if (fail && s.includes("update public.routine_runs set state=")) {
                fail = false;
                throw Error("lost database connection");
              }
              return tx.query(s, p);
            },
          }),
        ),
    };
    await createRoutineScheduler(crashing, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "admitted" });
    const key = (await f.runs())[0]!.request_key;
    expect((await f.db.query("select id from template_launch_requests where client_key=$1", [key])).rows).toHaveLength(
      1,
    );
    await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where routine_id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "reconciling", request_key: key });
    await f.db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id)
       select s.id,j.id,s.credential_id,s.owner_id,s.org_id,1,1,'fixture','fixture','first-conversation'
       from jobs j join sandboxes s on s.id=j.sandbox_id where j.kind='launch_initial_turn'`,
    );
    await f.db.query("update routine_runs set lease_until='-infinity' where routine_id=$1", [f.routine.id]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    const turn = (await f.db.query<{ id: string }>("select id from jobs where kind='launch_initial_turn'")).rows[0]!;
    expect((await f.runs())[0]).toMatchObject({ state: "succeeded", prompt_id: turn.id });
    expect(f.launches).toHaveLength(1);
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("daily cap includes failures, skipped ticks do not reset failures, and three refused launches pause safely", async () => {
  const f = await fixture();
  try {
    f.runtime.admitModal = async () => {
      throw new VaultError("conflict", "Routine admission refused.");
    };
    const launch = f.launch;
    await f.db.query("update routines set max_runs_per_day=1 where id=$1", [f.routine.id]);
    await f.due();
    await createRoutineScheduler(f.sql, { launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "failed", reason: "launch_failed" });
    await f.due();
    await createRoutineScheduler(f.sql, { launch, observe: f.observe }).tick();
    expect((await f.runs()).at(-1)).toMatchObject({ state: "skipped", reason: "daily_limit_reached" });
    expect(
      (
        await f.db.query<{ consecutive_failures: number }>("select consecutive_failures from routines where id=$1", [
          f.routine.id,
        ])
      ).rows[0]!.consecutive_failures,
    ).toBe(1);
    await f.db.query("update routines set max_runs_per_day=24 where id=$1", [f.routine.id]);
    for (let i = 0; i < 2; i++) {
      await f.due();
      await createRoutineScheduler(f.sql, { launch, observe: f.observe }).tick();
    }
    expect(
      (
        await f.db.query("select status,consecutive_failures,pause_reason,next_due_at from routines where id=$1", [
          f.routine.id,
        ])
      ).rows[0],
    ).toEqual({
      status: "paused",
      consecutive_failures: 3,
      pause_reason: "repeated_launch_failures",
      next_due_at: null,
    });
    expect((await f.db.query("select state from template_launch_requests")).rows).toEqual([
      { state: "failed" },
      { state: "failed" },
      { state: "failed" },
    ]);
    expect(f.boat.forks).toHaveLength(0);
    expect(JSON.stringify(await f.runs())).not.toContain("secret raw");
  } finally {
    await f.close();
  }
});

test("removed owners cannot execute newly due occurrences", async () => {
  const f = await fixture();
  try {
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "failed", reason: "owner_authorization_changed" });
    expect(f.launches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

// Pre-template-claim crashes differ from lost post-allocation publication: recover the frozen input.
test("restart after occurrence admission launches the frozen snapshot with the original key", async () => {
  const f = await fixture();
  try {
    await f.due();
    let fail = true;
    const crashing: Sql = {
      ...f.sql,
      transaction: async (work) => {
        const result = await f.sql.transaction!(work);
        if (fail && result && typeof result === "object" && "request_key" in result) {
          fail = false;
          throw Error("connection lost after commit");
        }
        return result;
      },
    };
    await expect(createRoutineScheduler(crashing, { launch: f.launch, observe: f.observe }).tick()).rejects.toThrow(
      "connection lost after commit",
    );
    expect(f.launches).toHaveLength(0);
    const key = (await f.runs())[0]!.request_key;
    await f.db.query("update routines set prompt='Edited later',ttl_seconds=900,version=version+1 where id=$1", [
      f.routine.id,
    ]);
    await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where routine_id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ requestKey: key, prompt: "Inspect\nexact bytes", ttlSeconds: 600 });
    expect((await f.runs())[0]).toMatchObject({ state: "reconciling", request_key: key });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("run input snapshots and sandbox links stay outside JWT history grants", async () => {
  const f = await fixture();
  try {
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.admin]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query("select id from routine_runs")).rows).toEqual([]);
    await expect(f.db.query("select * from routine_run_inputs")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.owner]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query("select id,state from routine_runs")).rows).toHaveLength(1);
    await expect(f.db.query("select sandbox_id from routine_runs")).rejects.toThrow("permission denied");
    await expect(f.db.query("update routine_runs set state='failed'")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
  } finally {
    await f.close();
  }
});

test("calendar admission counts missed occurrences once and pauses unavailable schedules without compute", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "update routines set cron='0 * * * *',timezone='UTC',interval_hours=null,status='enabled',next_due_at=date_trunc('hour',now())-interval '2000 hours' where id=$1",
      [f.routine.id],
    );
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.boat.forks).toHaveLength(0);
    // The run's created_at and the scheduler's clock come from the same transaction.
    const row = (
      await f.db.query<{ next_due_at: Date; expected: Date }>(
        `select r.next_due_at,date_trunc('hour',run.created_at,'UTC')+interval '1 hour' as expected
         from routines r join routine_runs run on run.routine_id=r.id where r.id=$1`,
        [f.routine.id],
      )
    ).rows[0]!;
    expect(row.next_due_at).toEqual(row.expected);
    const run = (
      await f.db.query<{ missed_intervals: number; missed_count_capped: boolean }>(
        "select missed_intervals,missed_count_capped from routine_runs where routine_id=$1",
        [f.routine.id],
      )
    ).rows[0];
    expect(run).toEqual({ missed_intervals: 1000, missed_count_capped: true });
    await f.db.query("update routines set timezone='Invalid/Zone',next_due_at=now()-interval '1 second' where id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.boat.forks).toHaveLength(0);
    expect((await f.runs()).at(-1)).toMatchObject({ state: "skipped", reason: "schedule_unavailable" });
    expect(
      (await f.db.query("select status,next_due_at,pause_reason from routines where id=$1", [f.routine.id])).rows[0],
    ).toEqual({ status: "paused", next_due_at: null, pause_reason: "schedule_unavailable" });
  } finally {
    await f.close();
  }
});

test("stalled launch and observation retain their slots without blocking healthy provider admission", async () => {
  const f = await fixture();
  await f.due();
  await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
  await f.db.query(
    "update routine_runs set state='succeeded',task_state='running',prompt_id='existing-turn',task_checked_at=null where routine_id=$1",
    [f.routine.id],
  );
  const definition = (
    await f.db.query<{ definition: Record<string, unknown> }>(
      "select definition from launch_template_revisions where template_id=$1",
      [f.routine.templateId],
    )
  ).rows[0]!.definition;
  const secondTemplate = (
    await f.templates.command(f.actor, "create", {
      org: f.people.org,
      scope: "personal",
      name: "Healthy",
      definition: {
        goldenId: definition.goldenId,
        provider: "boat",
        harness: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        variables: [],
        connections: [],
      },
    })
  ).item as { id: string };
  await f.db.query(
    "insert into launch_template_revisions(template_id,revision,definition,digest,created_by) select template_id,2,jsonb_set(definition,'{provider}','\"modal\"'),digest,created_by from launch_template_revisions where template_id=$1",
    [secondTemplate.id],
  );
  for (const [name, templateId] of [
    ["Blocked", f.routine.templateId],
    ["Healthy", secondTemplate.id],
  ]) {
    const routine = (
      await f.service.command(f.actor, "create", {
        org: f.people.org,
        scope: "personal",
        name,
        templateId,
        templateRevision: templateId === secondTemplate.id ? 2 : 1,
        prompt: "Inspect",
        intervalHours: 1,
        maxRunsPerDay: 24,
        ttlSeconds: 600,
      })
    ).item as Routine;
    await f.db.query("update routines set status='enabled',next_due_at=now()-interval '1 second' where id=$1", [
      routine.id,
    ]);
  }
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launches: string[] = [];
  let observations = 0;
  const instance = scheduler(f.sql, {
    launch: async (_actor, input) => {
      launches.push(input.id as string);
      if (input.id === f.routine.templateId) await pending;
      return {};
    },
    observe: async () => {
      observations++;
      await pending;
      return "finished";
    },
  });
  await instance.tick();
  expect(launches).toContain(secondTemplate.id);
  expect(launches).toContain(f.routine.templateId);
  expect(observations).toBe(1);
  await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where state='admitted'");
  await instance.tick();
  expect(launches.filter((id) => id === f.routine.templateId)).toHaveLength(1);
  instance.stop();
  release();
  await instance.drain();
  expect((await f.runs())[0]).toMatchObject({ state: "succeeded" });
});
