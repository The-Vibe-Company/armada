import { expect, test } from "bun:test";
import {
  type ApplicationVaultActor,
  createRoutineScheduler,
  createRoutineService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createTemplateService,
  promptOutcome,
  type Routine,
  type RoutineLaunchAdmission,
  type Sql,
  type TemplateRuntime,
} from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Owns durable scheduler behavior through real SQL + template admission; only physical provider is fake.
async function fixture() {
  const { db, people } = await database();
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
    provider: async () => boat.provider,
    options: { sleep: async () => {} },
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
      options: {
        ...runtime.options,
        beforeFork: async (id) => {
          await runtime.options?.beforeFork?.(id);
          await admission?.beforeFork();
        },
      },
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
  const due = async (hours = 0) =>
    db.query(
      "update routines set status='enabled',next_due_at=now()-($2*interval '1 hour')-interval '1 second' where id=$1",
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
  return { db, people, sql, actor, service, templates, boat, runtime, launch, observe, launches, routine, due, runs };
}

test("replicas fire one ordinary template launch, skip alive machines, preserve interval phase and never catch up", async () => {
  const f = await fixture();
  try {
    await f.due(8);
    await Promise.all([
      createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick(),
      createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick(),
    ]);
    expect(f.boat.forks).toHaveLength(1);
    expect(f.boat.prompts).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ revision: 1, prompt: "Inspect\nexact bytes", ttlSeconds: 600 });
    const first = (await f.runs())[0]!;
    expect(first).toMatchObject({ state: "succeeded", missed_intervals: 8 });
    const schedule = (
      await f.db.query<{ future: boolean; soon: boolean }>(
        "select next_due_at>now() as future,next_due_at<now()+interval '1 hour' as soon from routines where id=$1",
        [f.routine.id],
      )
    ).rows[0];
    expect(schedule).toEqual({ future: true, soon: true });
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs()).at(-1)).toMatchObject({ state: "skipped", reason: "previous_run_alive" });
    expect(f.boat.forks).toHaveLength(1);
    await f.db.query("update sandboxes set status='failed',stopped_at=now() where id=$1", [first.sandbox_id]);
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.boat.forks).toHaveLength(2);
    expect((await f.runs()).at(-1)).toMatchObject({ state: "succeeded" });
    const second = (await f.runs()).at(-1)!;
    await f.db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [second.sandbox_id]);
    await f.db.query("update sandboxes set status='running',stopped_at=null where id=$1", [first.sandbox_id]);
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs()).at(-1)).toMatchObject({ state: "skipped", reason: "previous_run_alive" });
    expect(f.boat.forks).toHaveLength(2);
    await f.db.query("update routines set status='paused',next_due_at=now()-interval '1 hour' where id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.boat.forks).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

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
    await expect(createRoutineScheduler(crashing, { launch: f.launch, observe: f.observe }).tick()).rejects.toThrow(
      "lost database connection",
    );
    expect((await f.runs())[0]).toMatchObject({ state: "admitted" });
    const key = (await f.runs())[0]!.request_key;
    expect((await f.db.query("select id from template_launch_requests where client_key=$1", [key])).rows).toHaveLength(
      1,
    );
    await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where routine_id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "succeeded", request_key: key });
    expect(f.launches).toHaveLength(1);
    expect(f.boat.forks).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

test("daily cap includes failures, skipped ticks do not reset failures, and three refused launches pause safely", async () => {
  const f = await fixture();
  try {
    const launch = async () => {
      throw Error("secret raw provider output must not persist");
    };
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
    expect(JSON.stringify(await f.runs())).not.toContain("secret raw");
  } finally {
    await f.db.close();
  }
});

test("uncertain template claims never refork and remain visible across restart", async () => {
  const f = await fixture();
  try {
    await f.due();
    f.runtime.provider = async () => ({
      ...f.boat.provider,
      fork: async () => {
        throw Error("connection lost after dispatch");
      },
    });
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect((await f.runs())[0]).toMatchObject({ state: "reconciling", reason: "launch_uncertain" });
    await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where routine_id=$1", [
      f.routine.id,
    ]);
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.launches).toHaveLength(1);
    expect((await f.runs()).at(-1)).toMatchObject({ state: "skipped", reason: "previous_run_uncertain" });
  } finally {
    await f.db.close();
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
    await f.db.close();
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
    expect((await f.runs())[0]).toMatchObject({ state: "succeeded", request_key: key });
    expect(f.boat.forks).toHaveLength(1);
  } finally {
    await f.db.close();
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
    await f.db.close();
  }
});

// The lease must fence allocation, not only history writes: an expired caller can still be in
// credential preflight while its replacement records a terminal pre-claim failure.
test("expired preflight cannot allocate after a replacement lease records failure", async () => {
  const f = await fixture();
  let resume!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let pending: Promise<void> | undefined;
  try {
    await f.due();
    const first = createRoutineScheduler(f.sql, {
      observe: f.observe,
      launch: async (actor, input, admission) => {
        entered();
        await gate;
        return f.launch(actor, input, admission);
      },
    });
    pending = first.tick();
    await ready;
    await f.db.query("update routine_runs set lease_until=now()-interval '1 second' where routine_id=$1", [
      f.routine.id,
    ]);
    const replacement = createRoutineScheduler(f.sql, {
      observe: f.observe,
      launch: async () => {
        throw Error("credential preflight refused");
      },
    });
    await replacement.tick();
    expect((await f.runs())[0]).toMatchObject({ state: "failed", sandbox_id: null });
    expect((await f.db.query("select id from template_launch_requests")).rows).toHaveLength(0);
    resume();
    await pending;
    expect(f.boat.forks).toHaveLength(0);
    expect((await f.db.query<{ state: string }>("select state from template_launch_requests")).rows[0]).toEqual({
      state: "failed",
    });
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    expect(f.boat.forks).toHaveLength(1);
    expect((await f.runs()).at(-1)).toMatchObject({ state: "succeeded" });
  } finally {
    resume();
    await pending?.catch(() => {});
    await f.db.close();
  }
});

test.each(["finished", "failed"] as const)(
  "history observes original prompt %s, not a later turn, without changing launch failure counters",
  async (status) => {
    const f = await fixture();
    try {
      await f.due();
      await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
      const row = (
        await f.db.query<{
          sandbox_id: string;
          prompt_id: string;
          conversation_id: string;
          template_request_id: string;
        }>("select sandbox_id,prompt_id,conversation_id,template_request_id from routine_runs where routine_id=$1", [
          f.routine.id,
        ])
      ).rows[0]!;
      const physical = (
        await f.db.query<{ provider_sandbox_id: string }>("select provider_sandbox_id from sandboxes where id=$1", [
          row.sandbox_id,
        ])
      ).rows[0]!.provider_sandbox_id;
      f.boat.finish(physical, row.prompt_id, status);
      const later = await f.boat.provider.prompt({ sandboxId: physical, harness: "codex", text: "Later turn" });
      f.boat.finish(physical, later.promptId, status === "finished" ? "failed" : "finished");
      await f.db.query("update routine_runs set task_checked_at=now()-interval '2 minutes' where routine_id=$1", [
        f.routine.id,
      ]);
      await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
      expect(
        (await f.db.query("select state,task_state,prompt_id from routine_runs where routine_id=$1", [f.routine.id]))
          .rows[0],
      ).toEqual({ state: "succeeded", task_state: status, prompt_id: row.prompt_id });
      expect(
        (await f.db.query("select status,consecutive_failures from routines where id=$1", [f.routine.id])).rows[0],
      ).toEqual({ status: "enabled", consecutive_failures: 0 });
      const history = await f.service.command(f.actor, "history", { org: f.people.org, id: f.routine.id });
      expect((history.items as Record<string, unknown>[])[0]).toMatchObject({
        taskState: status,
        templateRequestId: row.template_request_id,
      });
      if (status === "failed") expect(typeof (history.items as Record<string, unknown>[])[0]!.taskHelp).toBe("string");
      expect(f.boat.forks).toHaveLength(1);
    } finally {
      await f.db.close();
    }
  },
);

test("unavailable task evidence is unknown, not a launch failure or auto-pause", async () => {
  const f = await fixture();
  try {
    await f.due();
    await createRoutineScheduler(f.sql, { launch: f.launch, observe: f.observe }).tick();
    let observations = 0;
    const observe = async () => {
      observations++;
      throw Error("sensitive provider diagnostics");
    };
    for (let i = 0; i < 3; i++) {
      await f.db.query("update routine_runs set task_checked_at=now()-interval '2 minutes' where routine_id=$1", [
        f.routine.id,
      ]);
      await createRoutineScheduler(f.sql, { launch: f.launch, observe }).tick();
    }
    expect(observations).toBe(3);
    expect(
      (await f.db.query("select state,task_state from routine_runs where routine_id=$1", [f.routine.id])).rows[0],
    ).toEqual({ state: "succeeded", task_state: "unknown" });
    expect(
      (await f.db.query("select status,consecutive_failures from routines where id=$1", [f.routine.id])).rows[0],
    ).toEqual({ status: "enabled", consecutive_failures: 0 });
    await f.db.query("delete from members where user_id=$1 and org_id=$2", [f.people.owner, f.people.org]);
    await f.db.query("update routine_runs set task_checked_at=now()-interval '2 minutes' where routine_id=$1", [
      f.routine.id,
    ]);
    await createRoutineScheduler(f.sql, { launch: f.launch, observe }).tick();
    expect(observations).toBe(3);
  } finally {
    await f.db.close();
  }
});
