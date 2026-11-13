import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Driver, Journal, Runner, type RunnerRequest } from "@armada/agent-runtime";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
  const root = await mkdtemp(join(tmpdir(), "runtime-followup-"));
  const journal = new Journal(join(root, "journal"), (value) => value);
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const account = (
    await db.query<{ id: string; version: number }>(
      "select id,version from credentials where kind='openai' and owner_id=$1",
      [people.org],
    )
  ).rows[0]!;
  const golden = (
    await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [people.org])
  ).rows[0]!;
  const row = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "physical",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    visibility: "org",
    model: "gpt-5.4",
    reasoningEffort: "high",
    boatRuntime: true,
    credentialId: account.id,
    credentialVersion: account.version,
  });
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const active = await authority.enrol(
    (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
  );
  const starts: (string | undefined)[] = [];
  let lost = false,
    now = 0;
  const driver: Driver = {
    start(context) {
      starts.push(context.sessionId);
      context.session("native-thread");
      return { done: Promise.resolve("finished"), async steer() {}, async interrupt() {} };
    },
    async close() {},
  };
  const runner = new Runner(
    journal,
    { sandboxId: row.id, generation: active.epoch, token: active.runtimeToken, expiresAt: Date.now() + 60000 },
    { codex: driver },
    {
      async append(batch) {
        const reply = await createRuntimeEvents(authority, ENCRYPTION_KEY).append(
          active.runtimeToken,
          active.epoch,
          batch,
        );
        if (!("acknowledgedSequence" in reply)) throw Error("wrong ACK");
        return reply;
      },
    },
  );
  const bridge = createRuntimeCommands(authority, ENCRYPTION_KEY, {
    now: () => now,
    async wait() {
      now++;
      const command = (await bridge.next(active.runtimeToken, active.epoch)).command;
      if (!command) throw Error("Expected a durable command, not a timer wait");
      // Fake guest mount maps /home/user to the fixture home; all request identity,
      // Runner/session/journal/SQL/epoch behavior remains real. No host/provider I/O.
      const wire: RunnerRequest =
        command.op === "prompt" ? { ...command, input: { ...command.input, cwd: root } } : command;
      const reply = await runner.handle(
        new Request("http://runtime/v1", {
          method: "POST",
          headers: { "x-armada-runner-grant": active.runtimeToken },
          body: JSON.stringify(wire),
        }),
      );
      await bridge.complete(active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: command.requestId,
        status: reply.status,
        body: await reply.json(),
      });
      if (lost && command.op === "prompt" && command.requestId.startsWith("follow_")) {
        lost = false;
        throw Error("lost_wait_after_commit");
      }
    },
  });
  const agent = createRuntimeAgent(bridge, {
    ownerId: people.owner,
    sandboxId: row.id,
    providerSandboxId: "physical",
    cwd: root,
    defaults: { model: "gpt-5.4", reasoningEffort: "high" },
  });
  const first = await agent.prompt({ sandboxId: "physical", harness: "codex", text: "initial" });
  await createSqlData(sql)(caller).sandboxes.update(row.id, {
    status: "running",
    taskPromptId: first.promptId,
    conversationIds: [first.conversationId],
  });
  await runner.flushOutbox();
  const send = createRuntimeFollowup(sql, ENCRYPTION_KEY, bridge);
  const context: ToolContext = {
    caller,
    data: createSqlData(sql)(caller),
    runtimeSend: send,
    async provider() {
      throw Error("No host/native provider resolution");
    },
    launchCredentials: {
      async resolve() {
        throw Error("No native credential hooks");
      },
    },
    async exposedSecrets() {
      throw Error("No native secret reads");
    },
    now: () => new Date(),
    async sleep() {
      throw Error("No wall-clock sleeps");
    },
  };
  const input = (prompt = "follow-up") => ({
    id: row.id,
    prompt,
    request_id: crypto.randomUUID(),
    conversation_id: first.conversationId,
  });
  return {
    db,
    people,
    sql,
    caller,
    row,
    account,
    active,
    starts,
    first,
    runner,
    journal,
    authority,
    bridge,
    send,
    context,
    input,
    lose() {
      lost = true;
    },
    async close() {
      await runner.flushOutbox().catch(() => {});
      journal.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("shared send preserves the Runner session and epoch; replay cannot duplicate turns or overwrite a newer task", async () => {
  const f = await fixture();
  try {
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
  } finally {
    await f.close();
  }
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
