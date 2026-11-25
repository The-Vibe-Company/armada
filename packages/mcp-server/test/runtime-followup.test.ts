import { describe, expect, jest, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureDiagnostic, type Sql } from "@armada/core/server";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { createSqlData } from "../src/data.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createRuntimeFollowup, RuntimeFollowupConflict } from "../src/runtime-followup.ts";
import { RuntimeReconciliationConflict } from "../src/runtime-reconciliation-conflict.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture as fixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

describe.each([
  { provider: "boat", harness: "codex" },
  { provider: "boat", harness: "claude" },
  { provider: "modal", harness: "codex" },
  { provider: "modal", harness: "claude" },
  { provider: "modal", harness: "opencode" },
] as const)("$provider $harness shared runtime send", ({ provider, harness }) => {
  let preparations = 0;
  // Cold PGlite WASM startup, all migrations, fixture seeding and the initial
  // Runner turn are setup, not send/replay behavior. Keep them out of the test's
  // 5s budget; the real SQL/Runner/epoch assertions below remain unchanged.
  const prepared = scopedRuntimeFixture(
    async () => {
      const f = await fixture(await sharedDatabase(), provider, harness);
      if (provider === "modal")
        f.context.runtimeSend = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, async () => {
          preparations++;
          return undefined;
        });
      return f;
    },
    { timeout: 20_000 },
  );

  test("shared send preserves the Runner session and epoch; replay cannot duplicate turns or overwrite a newer task", async () => {
    const f = await prepared();
    const original = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    const originalGeneration = original.lifecycleGeneration!;
    const input = {
      ...f.input(),
      ...(provider === "boat" ? { model: original.model, reasoning_effort: original.reasoningEffort } : {}),
    };
    if (provider === "modal")
      await expect(callSharedTool(f.context, "send", { ...input, model: original.model })).rejects.toThrow(
        "Runtime follow-up uses the launch model and effort.",
      );
    const receipt = (await callSharedTool(f.context, "send", input)) as Awaited<ReturnType<typeof f.send>>;
    expect(receipt).toMatchObject({
      id: f.row.id,
      conversationId: f.first.conversationId,
      runtime: { kind: "armada", epoch: f.active.epoch },
    });
    expect(receipt.promptId).not.toBe(f.first.promptId);
    const next = (await callSharedTool(f.context, "send", f.input("another"))) as Awaited<ReturnType<typeof f.send>>;
    expect(f.starts).toEqual([undefined, "native-thread", "native-thread"]);
    expect(await callSharedTool(f.context, "send", input)).toEqual(receipt);
    if (provider === "boat")
      expect(
        await callSharedTool(f.context, "send", { ...input, model: undefined, reasoning_effort: undefined }),
      ).toEqual(receipt);
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.taskPromptId).toBe(next.promptId as string);
    expect(row.lifecycleGeneration).toBe(originalGeneration);
    expect(f.starts).toHaveLength(3);
    if (provider === "modal") expect(preparations).toBe(2);
    expect(await f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true)).toBe(true);
  });
});

test("uncertain send reconciles the same durable identity/lease; changed input and unauthorized/stopped targets never start work", async () => {
  const f = await fixture(await sharedDatabase());
  try {
    const input = f.input();
    f.lose();
    await expect(f.send(f.caller, input)).rejects.toMatchObject({ details: { runtimeOutcome: "unknown" } });
    const recovered = await createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, input);
    expect(recovered.conversationId).toBe(f.first.conversationId);
    expect(f.starts).toHaveLength(2);
    await expect(f.send(f.caller, { ...input, prompt: "different" })).rejects.toThrow();
    for (const extra of [
      { request_id: undefined },
      { conversation_id: "foreign" },
      { model: "changed_model" },
      { reasoning_effort: "changed_effort" },
    ])
      await expect(f.send(f.caller, { ...f.input(), ...extra })).rejects.toThrow();
    expect(await createSqlData(f.sql)({ ...f.caller, userId: f.people.admin }).sandboxes.get(f.row.id)).not.toBeNull();
    await expect(f.send({ ...f.caller, userId: f.people.admin }, f.input())).rejects.toMatchObject({
      code: "not_found",
    });
    await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "not_found" });
    await f.db.query("update credentials set status='active' where id=$1", [f.account.id]);
    // A checkpoint fences new turns, never the stored reply of an admitted one.
    await f.db.query("insert into runtime_checkpoints(sandbox_id,epoch,request_id) values($1,$2,$3)", [
      f.row.id,
      f.active.epoch,
      crypto.randomUUID(),
    ]);
    expect(await f.send(f.caller, input)).toEqual(recovered);
    await expect(f.send(f.caller, f.input())).rejects.toThrow("Runtime checkpoint is pending or complete");
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.row.id]);
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

describe("direct Modal runtime admission", () => {
  const modalSetupFixture = scopedRuntimeFixture(async () => fixture(await sharedDatabase(), "modal", "codex"), {
    perTest: true,
    timeout: 20_000,
  });

  test("direct Modal sends wait for the current setup receipt before claiming runtime activity", async () => {
    const f = await modalSetupFixture();
    const request = f.input();
    const { lifecycleGeneration } = (await createSqlData(f.sql)(f.caller).sandboxes.get(request.id))!;
    const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
    const setupId = await jobs.enqueue(
      "launch_initial_turn",
      request.id,
      lifecycleGeneration!,
      request.id,
      {},
      { orgId: f.row.orgId, maxAttempts: 1 },
    );

    const refused = async (message: string) => {
      await expect(f.send(f.caller, request)).rejects.toMatchObject({ code: "conflict", message });
      expect(await f.bridge.result(f.caller.userId, request.id, `follow_${request.request_id}`)).toMatchObject({
        state: "missing",
      });
      expect(
        (await f.sql.query("select activity_lease_id from public.sandboxes where id=$1", [request.id])).rows,
      ).toEqual([{ activity_lease_id: null }]);
    };
    await f.db.query(
      `with template as (
         insert into launch_templates(org_id,owner_id,scope,name)
         values($1,$2,'personal','runtime-followup-template') returning id
       ), revision as (
         insert into launch_template_revisions(template_id,revision,definition,digest,created_by)
         select id,1,'{}',repeat('a',64),$2 from template returning id,template_id
       )
       insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,
                                            manifest,golden_operation_fence_id,sandbox_id)
       select $1,$2,'runtime-followup',repeat('a',64),template_id,id,'{}',$3,$4 from revision`,
      [f.row.orgId, f.caller.userId, crypto.randomUUID(), request.id],
    );
    await refused("Modal launch setup is still in progress.");
    await f.db.query("delete from template_launch_requests where sandbox_id=$1", [request.id]);
    await f.db.query("update public.jobs set state='failed' where id=$1", [setupId]);
    await refused("Modal launch setup failed.");
    const queue = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
    expect(
      await queue.acceptInitialLaunch(
        f.caller,
        { id: request.id, request_id: setupId, prompt: "initial launch prompt" },
        String(lifecycleGeneration),
        async () => true,
      ),
    ).toBe(true);
    await f.db.query("update public.jobs set state='done' where id=$1", [setupId]);
    await refused("Modal launch prompt is awaiting dispatch.");
    await queue.cancelQueued(f.caller, request.id);
    const receipt = await f.send(f.caller, request);
    expect(receipt.promptId).not.toBe(f.first.promptId);
    expect(f.starts).toHaveLength(2);
  });

  test("a fresh wake cannot bypass setup on a retained Modal sandbox", async () => {
    const f = await modalSetupFixture();
    const request = f.input();
    const { lifecycleGeneration } = (await createSqlData(f.sql)(f.caller).sandboxes.get(request.id))!;
    await createJobsStore(f.sql, ENCRYPTION_KEY).enqueue(
      "launch_initial_turn",
      request.id,
      lifecycleGeneration!,
      request.id,
      {},
      { orgId: f.row.orgId, maxAttempts: 1 },
    );
    await f.db.query("update public.sandboxes set status='stopped',stopped_at=now() where id=$1", [request.id]);
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, undefined, async () => {
      throw new Error("Resume dispatch was reached before launch setup.");
    });
    await expect(send(f.caller, request)).rejects.toMatchObject({
      code: "conflict",
      message: "Modal launch setup is still in progress.",
    });
  });
});

test("runtime follow-up preserves the operator cause behind an uncertain send", async () => {
  const f = await fixture(await sharedDatabase(), "modal", "codex");
  try {
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, async () => {
      throw Object.assign(new Error("private transport response"), { code: "ECONNRESET" });
    });
    const error = await send(f.caller, f.input()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "conflict",
      message: "Runtime send outcome is uncertain; reuse the original request_id and identical input.",
    });
    expect(failureDiagnostic(error).message).toBe("ECONNRESET");
  } finally {
    await f.close();
  }
});

test("losing the shared lease during follow-up admission rolls back activity before sending", async () => {
  const f = await fixture(await sharedDatabase());
  try {
    const request = f.input();
    await expect(
      f.send(f.caller, request, {
        async canDispatch(tx) {
          const { rows } = await (tx ?? f.sql).query(
            "select id from public.sandboxes where id=$1 and activity_lease_id=$2",
            [request.id, request.request_id],
          );
          return rows.length === 0;
        },
        async handoffGeneration() {
          throw new Error("A running follow-up never hands off its generation.");
        },
      }),
    ).rejects.toThrow("Queued runtime turn lease is no longer current.");
    expect(await f.bridge.result(f.caller.userId, request.id, `follow_${request.request_id}`)).toMatchObject({
      state: "missing",
    });
    const { rows } = await f.sql.query("select activity_lease_id from public.sandboxes where id=$1", [request.id]);
    expect(rows).toEqual([{ activity_lease_id: null }]);
  } finally {
    await f.close();
  }
});

test.each(["command insert", "task publication"] as const)(
  "losing the shared lease at %s rolls back the write and lets a successor finish the same follow-up",
  async (point) => {
    const f = await fixture(await sharedDatabase());
    try {
      const request = f.input();
      const commandId = `follow_${request.request_id}`;
      const generation = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
      const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
      const id = await jobs.enqueue(
        "turn_dispatch",
        request.id,
        generation,
        request.request_id,
        { requestId: request.request_id },
        { orgId: f.row.orgId, maxAttempts: 2 },
      );
      await f.db.query(
        `insert into public.account_turn_queue
           (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,
            conversation_id,queued_generation,state,dispatch_generation,dispatch_until)
         select id,$2,credential_id,owner_id,org_id,1,credential_version,'fixture',''::bytea,$3,
                lifecycle_generation,'dispatching',lifecycle_generation,'infinity'
         from public.sandboxes where id=$1`,
        [request.id, request.request_id, f.first.conversationId],
      );
      const owner = crypto.randomUUID();
      const job = (await jobs.claim("turn_dispatch", owner, 30, 1))!;
      expect(job.id).toBe(id);
      const handoffGeneration = () => Promise.reject(Error("A running follow-up never advances generation."));
      await expect(
        f.send(f.caller, request, {
          handoffGeneration,
          async canDispatch(tx) {
            if ((await jobs.inspect(job, owner, tx)) !== "dispatch") return false;
            if (!tx) return true;
            const { rows } =
              point === "command insert"
                ? await tx.query("select 1 from public.runtime_commands where sandbox_id=$1 and request_id=$2", [
                    request.id,
                    commandId,
                  ])
                : await tx.query(
                    "select 1 from public.sandboxes where id=$1 and task_prompt_id is not null and task_prompt_id<>$2",
                    [request.id, f.first.promptId],
                  );
            return rows.length === 0;
          },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      const accepted = point === "task publication";
      expect(await f.bridge.result(f.caller.userId, request.id, commandId, f.active.epoch)).toMatchObject({
        state: accepted ? "finished" : "missing",
      });
      expect(
        (await f.sql.query("select task_prompt_id,activity_lease_id from public.sandboxes where id=$1", [request.id]))
          .rows,
      ).toEqual([{ task_prompt_id: null, activity_lease_id: request.request_id }]);
      expect(f.starts).toHaveLength(accepted ? 2 : 1);
      await f.db.query("update public.jobs set lease_until='-infinity' where id=$1", [id]);
      const successor = crypto.randomUUID();
      const retry = (await jobs.claim("turn_dispatch", successor, 30, 1))!;
      expect(retry.id).toBe(id);
      const receipt = await f.send(f.caller, request, {
        handoffGeneration,
        canDispatch: async (tx) => (await jobs.inspect(retry, successor, tx)) === "dispatch",
      });
      expect(await createSqlData(f.sql)(f.caller).sandboxes.get(request.id)).toMatchObject({
        taskPromptId: receipt.promptId,
        lifecycleGeneration: generation,
      });
      expect(f.starts).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);

test("losing the shared lease during the activity heartbeat rolls back the renewal", async () => {
  const f = await fixture(await sharedDatabase());
  const request = f.input();
  const heartbeatSettled = Promise.withResolvers<void>();
  let heartbeatStarted = false;
  let lost = false;
  const sql: Sql = {
    ...f.sql,
    transaction(work) {
      const transaction = f.sql.transaction!(work);
      return heartbeatStarted ? transaction.finally(() => heartbeatSettled.resolve()) : transaction;
    },
  };
  const send = createRuntimeFollowup(sql, ENCRYPTION_KEY, f.bridge, async () => {
    await f.sql.query("update public.sandboxes set activity_until='-infinity' where id=$1", [request.id]);
    heartbeatStarted = true;
    jest.advanceTimersByTime(30_000);
    await heartbeatSettled.promise;
    return undefined;
  });
  jest.useFakeTimers();
  try {
    await expect(
      send(f.caller, request, {
        async canDispatch(tx) {
          if (!heartbeatStarted || !tx) return !lost;
          const { rows } = await tx.query(
            "select 1 from public.sandboxes where id=$1 and activity_until > '-infinity'::timestamptz",
            [request.id],
          );
          lost ||= rows.length > 0;
          return !lost;
        },
        handoffGeneration: () => Promise.reject(Error("A running follow-up never advances generation.")),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(lost).toBe(true);
    const { rows } = await f.sql.query("select activity_until::text from public.sandboxes where id=$1", [request.id]);
    expect(rows).toEqual([{ activity_until: "-infinity" }]);
    expect(await f.bridge.result(f.caller.userId, request.id, `follow_${request.request_id}`)).toMatchObject({
      state: "missing",
    });
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test("stop committing after runtime acceptance fences late turn publication and never rearms the sandbox", async () => {
  const f = await fixture(await sharedDatabase());
  try {
    await f.db.exec(`create function stop_accepted_runtime() returns trigger language plpgsql as $$ begin
      update public.sandboxes set stop_requested_at=now() where id=new.sandbox_id; return new; end $$;
      create trigger stop_accepted_runtime after insert on public.sandbox_turn_models for each row
      when (new.sandbox_id = '${f.row.id}') execute function stop_accepted_runtime();`);
    await expect(f.send(f.caller, f.input())).rejects.toThrow();
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.stopRequestedAt).not.toBeNull();
    expect(row.taskPromptId).toBeNull(); // No late completion over the stop fence.
    expect(f.starts).toHaveLength(2); // Accepted before stop, not replayed or resumed.
    await expect(f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true)).rejects.toThrow();
  } finally {
    try {
      await f.close();
    } finally {
      await f.db.exec(`drop trigger if exists stop_accepted_runtime on public.sandbox_turn_models;
        drop function if exists stop_accepted_runtime();`);
    }
  }
});

test("a competing accepted turn invalidates an older finished probe before admission can clear its task", async () => {
  const f = await fixture(await sharedDatabase());
  const done = Promise.withResolvers<"finished">();
  try {
    await f.db.query("delete from public.runtime_idle_turns where sandbox_id=$1", [f.row.id]);
    const generation = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
    let competing: Awaited<ReturnType<typeof f.send>> | undefined;
    f.race(async () => {
      f.hold(done.promise);
      competing = await f.send(f.caller, f.input("competing"));
    });
    await expect(f.send(f.caller, f.input("stale"))).rejects.toThrow();
    if (!competing) throw Error("No competing turn was accepted");
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.taskPromptId).toBe(competing.promptId);
    expect(row.lifecycleGeneration).toBe(generation);
    expect(f.starts).toHaveLength(2);
  } finally {
    done.resolve("finished");
    await f.runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": f.active.runtimeToken },
        body: JSON.stringify({ version: 1, sandboxId: f.row.id, requestId: crypto.randomUUID(), op: "checkpoint" }),
      }),
    );
    await f.close();
  }
});

test("reconciliation refuses fresh sends before dispatch and preserves prior command uncertainty", async () => {
  const f = await fixture(await sharedDatabase());
  try {
    const prior = f.input("accepted before reconciliation");
    await f.send(f.caller, prior);
    await f.db.query("update sandboxes set reconcile_lease_until='infinity' where id=$1", [f.row.id]);
    await expect(f.send(f.caller, f.input())).rejects.toBeInstanceOf(RuntimeReconciliationConflict);
    await expect(f.send(f.caller, prior)).rejects.toBeInstanceOf(RuntimeFollowupConflict);
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

describe("Boat extension contention", () => {
  const extensionFixture = scopedRuntimeFixture(async () => fixture(await sharedDatabase()), { timeout: 20_000 });

  test("Boat follow-up defers only while an extension holds the sandbox lease", async () => {
    const f = await extensionFixture();
    const prior = f.input("accepted before extension");
    const receipt = await f.send(f.caller, prior);
    const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
    const kind = "boat_runtime_extend";
    const sandbox = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    const job = await jobs.enqueue(kind, sandbox.id, sandbox.lifecycleGeneration!, sandbox.id, null, {
      orgId: sandbox.orgId,
      maxAttempts: 3,
      deadline: new Date("2100-01-01"),
    });
    expect((await jobs.claim(kind, crypto.randomUUID(), 3600, 1))?.id).toBe(job);

    const next = f.input("deferred by extension");
    await expect(f.send(f.caller, next)).rejects.toMatchObject({ reason: "runtime_activity_busy" });
    expect(await f.send(f.caller, prior)).toEqual(receipt);
    expect(f.starts).toHaveLength(2);

    await f.db.query("update public.jobs set lease_until='-infinity' where id=$1", [job]);
    await expect(f.send(f.caller, next)).resolves.toMatchObject({ id: sandbox.id });
    expect(f.starts).toHaveLength(3);
  });
});

test("a newly enrolled generation after the prompt probe refuses admission even if the task matches", async () => {
  const f = await fixture(await sharedDatabase());
  try {
    await f.db.query("delete from public.runtime_idle_turns where sandbox_id=$1", [f.row.id]);
    const store = createSqlData(f.sql)(f.caller).sandboxes;
    const before = (await store.get(f.row.id))!;
    const generation = before.lifecycleGeneration!;
    const taskPromptId = before.taskPromptId!;
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, {
      ...f.bridge,
      async call(ownerId, command, options) {
        const reply = await f.bridge.call(ownerId, command, options);
        if (command.op === "getPrompt") {
          await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [f.row.id]);
          const ticket = await f.authority.issue({ sandboxId: f.row.id, ownerId, configuration: {} });
          await f.authority.enrol(ticket.enrolmentToken);
        }
        return reply;
      },
    });
    await expect(send(f.caller, f.input())).rejects.toThrow("Runtime admission changed");
    expect(await store.get(f.row.id)).toMatchObject({
      lifecycleGeneration: generation + 1,
      taskPromptId,
    });
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("follow-up skips getPrompt when runtime_idle_turns is settled and skips unchanged MCP/env preflight", async () => {
  const f = await fixture(await sharedDatabase(), "modal", "codex");
  try {
    const ops: string[] = [];
    let mcpCalls = 0;
    const send = createRuntimeFollowup(
      f.sql,
      ENCRYPTION_KEY,
      {
        ...f.bridge,
        async call(ownerId, command, options) {
          ops.push(command.op);
          return f.bridge.call(ownerId, command, options);
        },
      },
      async () => {
        mcpCalls++;
        return undefined;
      },
    );
    await f.db.query(
      "insert into public.mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,'rev',true)",
      [f.row.id, `runtime:${f.active.epoch}`],
    );
    const receipt = await send(f.caller, f.input("fast follow-up"));
    expect(receipt.promptId).not.toBe(f.first.promptId);
    expect(ops).not.toContain("getPrompt");
    expect(mcpCalls).toBe(0);

    await f.db.query(
      `insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,$2,false)
       on conflict(sandbox_id,prompt_id) do update set settled=false`,
      [f.row.id, receipt.promptId],
    );
    await send(f.caller, f.input("checked follow-up"));
    expect(ops).toContain("getPrompt");
    expect(mcpCalls).toBe(0);
  } finally {
    await f.close();
  }
});

describe.each([
  { provider: "boat", harness: "codex" },
  { provider: "boat", harness: "claude" },
  { provider: "modal", harness: "codex" },
  { provider: "modal", harness: "claude" },
  { provider: "modal", harness: "opencode" },
] as const)("idle $provider $harness first send", ({ provider, harness }) => {
  const prepared = scopedRuntimeFixture(async () => fixture(await sharedDatabase(), provider, harness, true), {
    timeout: 20_000,
  });

  test("first send opens one conversation; uncertain replay and later follow-up retain it", async () => {
    const f = await prepared();
    const before = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(f.journal.prompts()).toHaveLength(0);
    const request = f.input("first instruction");
    await expect(f.send(f.caller, { ...request, ...{ conversation_id: "foreign" } })).rejects.toThrow();
    expect(f.starts).toHaveLength(0);
    f.lose();
    await expect(f.send(f.caller, request)).rejects.toMatchObject({ details: { runtimeOutcome: "unknown" } });
    expect(f.starts).toEqual([undefined]);
    const recovered = await createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, request);
    expect(recovered.conversationId).toBeTruthy();
    const row = await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id);
    expect(row).toMatchObject({
      status: "ready",
      lifecycleGeneration: before.lifecycleGeneration,
      conversationIds: [recovered.conversationId],
    });
    const next = await f.send(f.caller, f.input("follow-up"));
    expect(next.conversationId).toBe(recovered.conversationId);
    expect(await f.send(f.caller, request)).toEqual(recovered);
    await expect(f.send(f.caller, { ...request, prompt: "changed" })).rejects.toThrow();
    expect(f.starts).toEqual([undefined, "native-thread"]);
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.taskPromptId).toBe(next.promptId);
  });
});

test.each([
  {
    phase: "setup",
    error: "sandbox golden does not exist",
    prepare: (database: Awaited<ReturnType<typeof sharedDatabase>>) =>
      fixture(database, "boat", "codex", true, undefined, {
        goldenId: crypto.randomUUID(),
        providerSandboxId: "missing-golden",
      }),
  },
  {
    phase: "configuration",
    error: "runtime fixture configuration failed",
    async prepare(database: Awaited<ReturnType<typeof sharedDatabase>>) {
      const runtime = await fixture(database, "boat", "codex", true, undefined, {
        goldenId: database.sharedGoldenId,
        providerSandboxId: crypto.randomUUID(),
      });
      return configureRuntimeFixture(runtime, async () => {
        throw new Error("runtime fixture configuration failed");
      });
    },
  },
])(
  "failed runtime $phase removes its journal directory and keeps the caller's database open",
  async ({ error, prepare }) => {
    const database = await sharedDatabase();
    const root = await mkdtemp(join(tmpdir(), "runtime-setup-failure-"));
    const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const previous = process.env[tempKey];
    process.env[tempKey] = root;
    try {
      await expect(prepare(database)).rejects.toThrow(error);
      expect(await readdir(root)).toEqual([]);
      expect(database.db.closed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[tempKey];
      else process.env[tempKey] = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
