import { describe, expect, test } from "bun:test";
import { createSqlData } from "../src/data.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture as fixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
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

test("a newly enrolled generation after the prompt probe refuses admission even if the task matches", async () => {
  const f = await fixture(await sharedDatabase());
  try {
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
