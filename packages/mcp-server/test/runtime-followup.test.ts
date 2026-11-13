import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSqlData } from "../src/data.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture as fixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

describe("shared runtime send", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  // Cold PGlite WASM startup, all migrations, fixture seeding and the initial
  // Runner turn are setup, not send/replay behavior. Keep them out of the test's
  // 5s budget; the real SQL/Runner/epoch assertions below remain unchanged.
  beforeAll(async () => {
    f = await fixture();
  }, 20_000);
  afterAll(async () => {
    await f?.close();
  });

  test("shared send preserves the Runner session and epoch; replay cannot duplicate turns or overwrite a newer task", async () => {
    const originalGeneration = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
    const input = f.input();
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
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.taskPromptId).toBe(next.promptId as string);
    expect(row.lifecycleGeneration).toBe(originalGeneration + 4);
    expect(f.starts).toHaveLength(3);
    expect(await f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true)).toBe(true);
  });
});

test("uncertain send reconciles the same durable identity/lease; changed input and unauthorized/stopped targets never start work", async () => {
  const f = await fixture();
  try {
    const input = f.input();
    f.lose();
    await expect(f.send(f.caller, input)).rejects.toMatchObject({ details: { runtimeOutcome: "unknown" } });
    const recovered = await createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, input);
    expect(recovered.conversationId).toBe(f.first.conversationId);
    expect(f.starts).toHaveLength(2);
    await expect(f.send(f.caller, { ...input, prompt: "different" })).rejects.toThrow();
    for (const extra of [{ request_id: undefined }, { conversation_id: "foreign" }, { model: "gpt-5.4" }])
      await expect(f.send(f.caller, { ...f.input(), ...extra })).rejects.toThrow();
    expect(await createSqlData(f.sql)({ ...f.caller, userId: f.people.admin }).sandboxes.get(f.row.id)).not.toBeNull();
    await expect(f.send({ ...f.caller, userId: f.people.admin }, f.input())).rejects.toMatchObject({
      code: "not_found",
    });
    await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "not_found" });
    await f.db.query("update credentials set status='active' where id=$1", [f.account.id]);
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.row.id]);
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("stop committing after runtime acceptance fences late turn publication and never rearms the sandbox", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`create function stop_accepted_runtime() returns trigger language plpgsql as $$ begin
      update public.sandboxes set stop_requested_at=now() where id=new.sandbox_id; return new; end $$;
      create trigger stop_accepted_runtime after insert on public.sandbox_turn_models for each row execute function stop_accepted_runtime();`);
    await expect(f.send(f.caller, f.input())).rejects.toThrow();
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.stopRequestedAt).not.toBeNull();
    expect(row.taskPromptId).toBeNull(); // No late completion over the stop fence.
    expect(f.starts).toHaveLength(2); // Accepted before stop, not replayed or resumed.
    await expect(f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("a competing accepted turn invalidates an older finished probe before admission can clear its task", async () => {
  const f = await fixture();
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
    expect(row.lifecycleGeneration).toBe(generation + 2);
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
