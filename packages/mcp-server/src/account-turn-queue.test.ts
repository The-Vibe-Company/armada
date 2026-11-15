import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { createAccountTurnQueue } from "./account-turn-queue.ts";
import type { Caller } from "./caller.ts";

const db = new PGlite();
const org = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const account = "10000000-0000-4000-8000-000000000003";
const ids = [1, 2, 3].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const requests = [1, 2].map((n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const caller: Caller = { userId: owner, via: "service", orgs: [{ orgId: org, role: "member" }] };
const sql = {
  query: (q: string, values?: unknown[]) => db.query(q, values),
  transaction: (work: (tx: Sql) => Promise<unknown>) =>
    db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) } as Sql)),
} as Sql;
const queue = createAccountTurnQueue(sql, btoa("x".repeat(32)));
beforeAll(async () => {
  await db.exec(`create table credentials(id uuid primary key,name text,max_agents int,version int,status text,expires_at timestamptz,scope text,owner_id uuid);
    create table orgs(id uuid primary key);
    create table members(org_id uuid,user_id uuid,role text);
    create table mcp_actor_epochs(org_id uuid,user_id uuid,epoch bigint);
    create table sandboxes(id uuid primary key,harness text default 'codex',provider text,boat_runtime boolean,runtime_transport text,model text,reasoning_effort text,credential_id uuid,credential_version int,org_id uuid,owner_id uuid,
      conversation_ids text[],visibility text default 'private',status text,deleted_at timestamptz,stopped_at timestamptz,stop_requested_at timestamptz,expires_at timestamptz,
      activity_lease_id uuid,task_prompt_id text,lifecycle_generation bigint default 0,reconcile_lease_until timestamptz);
    create table runtime_commands(sandbox_id uuid,sequence bigint,request_id text);
    create table docker_host_jobs(bound_sandbox_id uuid,position bigint,request_id uuid);
    create table runtime_resumes(sandbox_id uuid,request_id uuid);
    create table runtime_idle_turns(sandbox_id uuid,prompt_id text,settled boolean);
    create table account_agent_reservations(sandbox_id uuid primary key,account_id uuid);`);
  // Apply this migration against a minimal real schema: no hand-written queue store behavior.
  const migration = await Bun.file(
    new URL("../../../supabase/migrations/20261115123000_account_turn_queue.sql", import.meta.url),
  ).text();
  // Role grants are outside the admission contract and these roles do not exist in PGlite.
  await db.exec(migration.split("alter table")[0]!);
  await db.query("insert into credentials values($1,'Shared account',1,1,'active',null,'user',$2)", [account, owner]);
  await db.query("insert into orgs values($1)", [org]);
  await db.query("insert into members values($1,$2,'member')", [org, owner]);
  await db.query("insert into mcp_actor_epochs values($1,$2,1)", [org, owner]);
  for (const id of ids)
    await db.query(
      "insert into sandboxes(id,credential_id,credential_version,org_id,owner_id,conversation_ids,status,expires_at) values($1,$2,1,$3,$4,array['history'],'ready',now()+interval '1 day')",
      [id, account, org, owner],
    );
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(
    "delete from runtime_commands; delete from docker_host_jobs; delete from runtime_resumes; delete from account_turn_queue; delete from account_agent_reservations; delete from runtime_idle_turns; update sandboxes set status='ready',task_prompt_id=null,stopped_at=null,lifecycle_generation=0,activity_lease_id=null,provider=null,boat_runtime=false,runtime_transport=null; update mcp_actor_epochs set epoch=1;",
  );
});

test("full-account prompts persist, dispatch FIFO after a turn settles, and queued IDs resolve to actual receipts", async () => {
  await db.query("update sandboxes set status='running',task_prompt_id='active_turn' where id=$1", [ids[0]]);
  const first = { id: ids[1]!, request_id: requests[0]!, prompt: "first instruction" };
  const second = { id: ids[2]!, request_id: requests[1]!, prompt: "second instruction" };
  expect((await queue.accept(caller, first))?.status).toBe("queued");
  expect((await queue.accept(caller, second))?.status).toBe("queued");
  await expect(queue.accept(caller, { ...first, prompt: "changed" })).rejects.toThrow("identical input");
  const dispatched: string[] = [];
  queue.setDispatch(async (_caller, input) => {
    dispatched.push(input.prompt);
    await db.query("update sandboxes set task_prompt_id=$2,status='running' where id=$1", [input.id, input.request_id]);
    await db.query("delete from account_agent_reservations where sandbox_id=$1", [input.id]);
    return { id: input.id, promptId: `actual_${input.request_id}`, conversationId: "history", status: "running" };
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  await db.query("insert into runtime_idle_turns values($1,'active_turn',true)", [ids[0]]);
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(dispatched).toEqual(["first instruction"]);
  expect(await queue.status(caller, ids[1]!)).toEqual({
    nativePromptId: `actual_${requests[0]}`,
    publicPromptId: requests[0]!,
  });
  expect(await queue.status(caller, ids[1]!, requests[0])).toEqual({ nativePromptId: `actual_${requests[0]}` });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  await db.query("insert into runtime_idle_turns values($1,$2,true)", [ids[1], requests[0]]);
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(dispatched).toEqual(["first instruction", "second instruction"]);
});

test("queued sends recheck actor revocation without dispatching or reserving a slot", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "authorized initially" };
  await queue.accept(caller, input);
  await db.exec("update mcp_actor_epochs set epoch=2");
  let dispatched = false;
  queue.setDispatch(async () => {
    dispatched = true;
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  expect(dispatched).toBe(false);
  expect((await queue.status(caller, ids[1]!, requests[0]))?.failed).toBe(true);
  expect((await db.query("select * from account_agent_reservations")).rows).toEqual([]);
});

test("uncertain native dispatch is not retried and confirmed stop releases the account for the next queued turn", async () => {
  const first = { id: ids[1]!, request_id: requests[0]!, prompt: "uncertain instruction" };
  const second = { id: ids[2]!, request_id: requests[1]!, prompt: "next instruction" };
  await queue.accept(caller, first);
  await queue.accept(caller, second);
  let calls = 0;
  queue.setDispatch(async () => {
    calls++;
    await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [ids[1]]);
    throw Error("uncertain");
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  expect(calls).toBe(1);
  await db.query(
    "update sandboxes set status='stopped',stopped_at=now(),lifecycle_generation=lifecycle_generation+1 where id=$1",
    [ids[1]],
  );
  queue.setDispatch(async (_caller, input) => ({
    id: input.id,
    promptId: "actual_next",
    conversationId: "history",
    status: "running",
  }));
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(await queue.status(caller, ids[2]!, requests[1])).toEqual({ nativePromptId: "actual_next" });
});

test("queued public receipts remain usable across server reads, evidence, outcome and conversation controls", async () => {
  const { callSharedTool } = await import("./tool-api.ts");
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "queued Docker instruction" };
  const routedPrompts: unknown[] = [];
  const events = () => [
    {
      id: "positive_tool",
      at: 1,
      kind: "message",
      promptId: "actual_docker_prompt",
      tools: [{ id: "call", name: "launch", input: {} }],
    },
    {
      id: "negative_tool",
      at: 2,
      kind: "message",
      promptId: "second_native",
      tools: [{ id: "refusal", name: "launch", input: {}, result: { error: "no_option" } }],
    },
    { id: "unrelated", at: 0, kind: "prompt", promptId: "unmapped_native", status: "finished" },
  ];
  const outcome = { state: "ready" };
  const context = {
    caller,
    accountTurns: queue,
    data: {
      sandboxes: {
        get: async () => {
          throw Error("Docker routes before native data");
        },
      },
    },
    dockerControls: {
      invoke: async (_caller: Caller, name: string, args: Record<string, unknown>) => {
        if (name === "logs")
          return { handled: true, result: { events: events(), cursor: null, hasMore: false, settled: true } };
        if (name === "report") {
          expect(args.prompt_id).toBe("actual_docker_prompt");
          return { handled: true, result: { id: input.id, taskOutcome: args.outcome } };
        }
        if (name === "interrupt" || name === "steer") {
          expect(args.conversation_id).toBe("history");
          return {
            handled: true,
            result:
              name === "interrupt"
                ? { id: input.id, interrupted: true }
                : { id: input.id, promptId: "steer_native", conversationId: "history", delivery: "native", mode: null },
          };
        }
        expect(name).toBe("status");
        routedPrompts.push(args.prompt_id);
        if (args.prompt_id !== undefined && args.prompt_id !== "actual_docker_prompt") throw Error("unknown prompt");
        return {
          handled: true,
          result: {
            id: input.id,
            golden: null,
            visibility: "private",
            harness: "codex",
            repositoryDir: null,
            model: null,
            reasoningEffort: null,
            machineSize: null,
            statusReason: null,
            providerState: null,
            conversationIds: ["history"],
            usage: {
              computeSeconds: 0,
              turnCount: 3,
              turns: ["actual_docker_prompt", "second_native", "unmapped_native"].map((promptId) => ({
                promptId,
                model: "model",
                inputTokens: 3,
                outputTokens: 1,
                cachedTokens: 0,
              })),
            },
            status: "ready",
            settled: true,
            expiresAt: null,
            prompt: { promptId: "actual_docker_prompt", conversationId: "history", reason: null, state: "finished" },
          },
        };
      },
    },
    now: () => new Date(0),
    sleep: async () => {
      throw Error("No real waits");
    },
  } as unknown as import("./tools.ts").ToolContext;
  expect(await callSharedTool(context, "send", input)).toMatchObject({ promptId: input.request_id, status: "queued" });
  const waiting = await callSharedTool(context, "status", {
    id: input.id,
    prompt_id: input.request_id,
    recorded: true,
  });
  expect(waiting).toMatchObject({
    settled: false,
    statusMessage: "Waiting for a free agent slot on account Shared account (0/1).",
  });
  expect(
    await callSharedTool(context, "wait", { id: input.id, prompt_id: input.request_id, timeout_seconds: 0 }),
  ).toMatchObject({ settled: false, timedOut: true });
  queue.setDispatch(async () => ({ promptId: "actual_docker_prompt", conversationId: "history", status: "finished" }));
  await queue.reconcileOne(new AbortController().signal);
  await queue.drain();
  expect(await callSharedTool(context, "status", { id: input.id, prompt_id: input.request_id })).toMatchObject({
    settled: true,
    prompt: { promptId: input.request_id },
  });
  expect(
    await callSharedTool(context, "wait", { id: input.id, prompt_id: input.request_id, timeout_seconds: 0 }),
  ).toMatchObject({ settled: true, timedOut: false, prompt: { promptId: input.request_id, state: "finished" } });
  expect(routedPrompts).toEqual([undefined, undefined, "actual_docker_prompt", "actual_docker_prompt"]);
  // A second queued turn proves history is not projected using only the latest alias.
  await callSharedTool(context, "send", { ...input, request_id: requests[1], prompt: "second queued instruction" });
  queue.setDispatch(async () => ({ promptId: "second_native", conversationId: "history", status: "finished" }));
  await queue.reconcileOne(new AbortController().signal);
  await queue.drain();
  const expectedIds = [requests[0]!, requests[1]!, "unmapped_native"];
  const logs = (await callSharedTool(context, "logs", { id: input.id })) as {
    events: { promptId: string; tools?: unknown[] }[];
  };
  expect(logs.events.map((event) => event.promptId)).toEqual(expectedIds);
  expect(logs.events.filter((event) => event.promptId === input.request_id)[0]?.tools).toHaveLength(1);
  const { readLogs } = await import("./control-logs.ts");
  const httpLogs = await readLogs(
    { dockerControls: context.dockerControls!, accountTurns: queue },
    caller,
    input.id,
    {},
  );
  expect(httpLogs.events.map((event) => event.promptId)).toEqual(expectedIds);
  const provider = {
    events: async () => ({ events: events(), cursor: null, hasMore: false }),
  } as unknown as import("@armada/core").Provider;
  const nativeContext = {
    ...context,
    dockerControls: undefined,
    provider: async () => provider,
    data: {
      sandboxes: {
        get: async () => ({ id: input.id, provider: "modal", providerSandboxId: "provider_sandbox", status: "ready" }),
      },
    },
  } as unknown as import("./tools.ts").ToolContext;
  const nativeLogs = (await callSharedTool(nativeContext, "logs", { id: input.id })) as {
    events: { promptId: string }[];
  };
  expect(nativeLogs.events.map((event) => event.promptId)).toEqual(expectedIds);
  const nativeHttpLogs = await readLogs(
    { accountTurns: queue, logs: async () => ({ provider, providerSandboxId: "provider_sandbox" }) },
    caller,
    input.id,
    {},
  );
  expect(nativeHttpLogs.events.map((event) => event.promptId)).toEqual(expectedIds);

  const status = (await callSharedTool(context, "status", { id: input.id, prompt_id: input.request_id })) as {
    usage: { turns: { promptId: string }[] };
  };
  expect(status.usage.turns.map((turn) => turn.promptId)).toEqual(expectedIds);
  await callSharedTool(context, "report", { id: input.id, prompt_id: input.request_id, outcome });
  expect(await callSharedTool(context, "interrupt", { id: input.id, conversation_id: "history" })).toMatchObject({
    interrupted: true,
  });
  expect(
    await callSharedTool(context, "steer", { id: input.id, conversation_id: "history", text: "Continue" }),
  ).toMatchObject({ promptId: "steer_native" });
});

test("bounded queue scans advance past full accounts without starving another account", async () => {
  const targets: string[] = [];
  for (let i = 1; i <= 21; i++) {
    const suffix = String(i).padStart(12, "0");
    const accountId = `80000000-0000-4000-8000-${suffix}`;
    const sandboxId = `90000000-0000-4000-8000-${suffix}`;
    const requestId = `70000000-0000-4000-8000-${suffix}`;
    await db.query("insert into credentials values($1,$2,$3,1,'active',null,'user',$4)", [
      accountId,
      `Account ${i}`,
      i === 21 ? 1 : 0,
      owner,
    ]);
    await db.query(
      "insert into sandboxes(id,credential_id,credential_version,org_id,owner_id,conversation_ids,status,expires_at) values($1,$2,1,$3,$4,array['history'],'ready',now()+interval '1 day')",
      [sandboxId, accountId, org, owner],
    );
    await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: `instruction ${i}` });
    targets.push(sandboxId);
  }
  const dispatched: string[] = [];
  queue.setDispatch(async (_caller, input) => {
    dispatched.push(input.id);
    return { promptId: "actual", conversationId: "history", status: "running" };
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(dispatched).toEqual([targets[20]!]);
});

test("a proven pre-dispatch rejection requeues without leaking the account reservation", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "retry after admission conflict" };
  await queue.accept(caller, input);
  let calls = 0;
  queue.setDispatch(async () => {
    calls++;
    if (calls === 1) {
      await db.query("insert into runtime_commands values($1,1,'readonly_get_prompt')", [input.id]);
      throw Error("reconcile lease won admission after getPrompt probe");
    }
    return { promptId: "accepted_after_retry", conversationId: "history", status: "running" };
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect((await db.query("select * from account_agent_reservations")).rows).toEqual([]);
  expect((await queue.status(caller, input.id, input.request_id))?.message).toContain("Waiting for a free agent slot");
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(calls).toBe(2);
  expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "accepted_after_retry" });
});

test("uppercase request UUIDs preserve one queue identity and status alias", async () => {
  const uppercase = "ABCDEF00-ABCD-4ABC-8ABC-000000000001";
  const input = { id: ids[1]!, request_id: uppercase, prompt: "case insensitive request identity" };
  expect(await queue.accept(caller, input)).toMatchObject({ requestId: uppercase.toLowerCase(), status: "queued" });
  expect(await queue.accept(caller, { ...input, request_id: uppercase.toLowerCase() })).toMatchObject({
    requestId: uppercase.toLowerCase(),
    status: "queued",
  });
  expect((await db.query("select * from account_turn_queue")).rows).toHaveLength(1);
  expect(await queue.status(caller, input.id, uppercase)).toMatchObject({
    requestId: uppercase.toLowerCase(),
    failed: false,
  });
  queue.setDispatch(async () => ({ promptId: "case_actual_prompt", conversationId: "history", status: "running" }));
  await queue.reconcileOne(new AbortController().signal);
  await queue.drain();
  expect(await queue.status(caller, input.id, uppercase)).toEqual({ nativePromptId: "case_actual_prompt" });
});

test.each(["docker", "boat", "modal"] as const)(
  "pending %s runtime wake reconciles only its original durable request",
  async (provider) => {
    const input = { id: ids[1]!, request_id: requests[0]!, prompt: "resume the same conversation" };
    await db.query(
      "update sandboxes set provider=$2,boat_runtime=$3,runtime_transport=$4,status='stopped',stopped_at=now() where id=$1",
      [input.id, provider, provider === "boat", provider === "modal" ? "dialout" : null],
    );
    await queue.accept(caller, input);
    const requestsSeen: unknown[] = [];
    queue.setDispatch(async (_caller, request) => {
      requestsSeen.push(request);
      if (requestsSeen.length === 1) {
        await db.query(
          "update sandboxes set status='starting',stopped_at=null,lifecycle_generation=lifecycle_generation+1,activity_lease_id=$2 where id=$1",
          [input.id, input.request_id],
        );
        if (provider === "docker")
          await db.query("insert into docker_host_jobs values($1,1,$2)", [input.id, input.request_id]);
        else await db.query("insert into runtime_resumes values($1,$2)", [input.id, input.request_id]);
        throw Error("wake still pending");
      }
      return { promptId: "resumed_prompt", conversationId: "history", status: "running" };
    });
    expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
    await queue.drain();
    expect((await db.query("select * from account_agent_reservations")).rows).toHaveLength(1);
    expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
    await queue.drain();
    expect(requestsSeen).toEqual([input, input]);
    expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "resumed_prompt" });
  },
);

test("native invalid model settings are rejected before a durable prompt is queued", async () => {
  await expect(
    queue.accept(caller, {
      id: ids[1]!,
      request_id: requests[0]!,
      prompt: "instruction",
      model: "invalid model with spaces",
    }),
  ).rejects.toThrow();
  expect((await db.query("select * from account_turn_queue")).rows).toEqual([]);
});

test("a native request with its own durable mutating command stays uncertain rather than replaying", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "possibly accepted instruction" };
  await queue.accept(caller, input);
  let calls = 0;
  queue.setDispatch(async () => {
    calls++;
    await db.query("insert into runtime_commands values($1,1,$2)", [input.id, `follow_${input.request_id}`]);
    throw Error("reply lost");
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  expect(calls).toBe(1);
  expect((await db.query("select * from account_agent_reservations")).rows).toHaveLength(1);
});

test("runtime dispatch leases survive a server restart without replaying while another dispatcher owns the lease", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "recover a claimed instruction" };
  await db.query("update sandboxes set provider='docker' where id=$1", [input.id]);
  await queue.accept(caller, input);
  await db.query(
    "update account_turn_queue set state='dispatching',dispatch_generation=0,dispatch_until=now()+interval '1 hour' where sandbox_id=$1",
    [input.id],
  );
  await db.query("insert into account_agent_reservations values($1,$2)", [input.id, account]);
  const restarted = createAccountTurnQueue(sql, btoa("x".repeat(32)));
  let calls = 0;
  restarted.setDispatch(async (_caller, request) => {
    calls++;
    expect(request).toEqual(input);
    return { promptId: "recovered_prompt", conversationId: "history", status: "running" };
  });
  expect(await restarted.reconcileOne(new AbortController().signal)).toBe(false);
  await db.query("update account_turn_queue set dispatch_until=now()-interval '1 second' where sandbox_id=$1", [
    input.id,
  ]);
  expect(await restarted.reconcileOne(new AbortController().signal)).toBe(true);
  await restarted.drain();
  expect(calls).toBe(1);
  expect(await restarted.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "recovered_prompt" });
});

test("explicit owner stop cancels waiting prompts before Docker no-op routing, but idle cleanup and dispatching work stay intact", async () => {
  const { callSharedTool } = await import("./tool-api.ts");
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "do not wake after explicit stop" };
  await queue.accept(caller, input);
  const context = {
    caller,
    accountTurns: queue,
    dockerControls: { invoke: async () => ({ handled: true, result: { id: input.id, status: "stopped" } }) },
  } as unknown as import("./tools.ts").ToolContext;
  await callSharedTool(context, "stop", { id: input.id, only_if_idle: true });
  expect((await queue.status(caller, input.id, input.request_id))?.failed).toBe(false);
  // The same sandbox may have another admitted/uncertain operation; cancel only queued facts.
  await db.query(
    "insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,state) select sandbox_id,$2,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,'dispatching' from account_turn_queue where sandbox_id=$1",
    [input.id, requests[1]],
  );
  await db.query("insert into account_agent_reservations values($1,$2)", [input.id, account]);
  await callSharedTool(context, "stop", { id: input.id });
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({
    failed: true,
    message: "Queued prompt was cancelled.",
  });
  expect((await db.query("select * from account_turn_queue where state='dispatching'")).rows).toHaveLength(1);
  expect((await db.query("select * from account_agent_reservations")).rows).toHaveLength(1);
  let dispatched = false;
  queue.setDispatch(async () => {
    dispatched = true;
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  expect(dispatched).toBe(false);
});
