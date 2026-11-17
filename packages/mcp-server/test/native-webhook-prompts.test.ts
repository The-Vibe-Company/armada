import { expect, test } from "bun:test";
import type { Provider, ProviderRegistry, Sql } from "@armada/core/server";
import { createMcpSandboxProviderResolver } from "../src/mcp-sandbox-provider.ts";
import { createNativeWebhookPrompts } from "../src/native-webhook-prompts.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
async function fixture() {
  const { db, people } = await database();
  const sql: Sql = { query: (q, p) => db.query(q, p) };
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
     select $1,id,org_id,owner_id,'native_fixture','codex','ready' from goldens
     where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  await db.query(
    "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)",
    [people.org, new Uint8Array([1])],
  );
  return { db, sql, id, people };
}

test("native receipts survive replacement and stopping, without duplicate runtime observation", async () => {
  const { db, sql, id, people } = await fixture();
  const publicPrompt = "00000000-0000-4000-8000-000000000019";
  await db.query(
    `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
       actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
     select s.id,$2,c.id,s.owner_id,s.org_id,1,c.version,'input_hash',$3,'conversation','dispatching',s.lifecycle_generation
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
    [id, publicPrompt, new Uint8Array([1])],
  );
  await db.query(
    `update sandboxes set task_prompt_id='old_prompt',task_outcome='{"state":"ready"}'::jsonb where id=$1`,
    [id],
  );
  expect((await db.query("select native_prompt_id,result_enc from account_turn_queue")).rows).toEqual([
    { native_prompt_id: "old_prompt", result_enc: null },
  ]);
  expect(
    (
      await db.query<{ payload: { promptId: string } }>(
        "select payload from outbound_webhook_deliveries where payload->>'type'='agent.report.ready'",
      )
    ).rows.map(({ payload }) => payload.promptId),
  ).toEqual([publicPrompt]);
  await db.query("update account_turn_queue set state='admitted' where sandbox_id=$1", [id]);
  await db.query(
    "update sandboxes set task_prompt_id='new_prompt',status='stopped',stopped_at=now(),lifecycle_generation=lifecycle_generation+1 where id=$1",
    [id],
  );
  const observed: string[] = [];
  const provider = {
    id: "boat",
    async getPrompt({ promptId }: { promptId: string }) {
      observed.push(promptId);
      return { promptId, status: promptId === "old_prompt" ? "finished" : "interrupted", done: true };
    },
  } as Provider;
  const registry: ProviderRegistry = {
    async resolve(target, actor) {
      expect(target.id).toBe(id);
      expect(actor.userId).toBe(people.owner);
      return provider;
    },
  };
  await expect(createMcpSandboxProviderResolver(sql, registry)(id)).rejects.toThrow();
  const worker = createNativeWebhookPrompts(
    sql,
    createMcpSandboxProviderResolver(sql, registry, { terminalObservation: true }),
  );
  for (let i = 0; i < 2; i++) expect(await worker.reconcileOne(new AbortController().signal)).toBe(true);
  expect(observed.sort()).toEqual(["new_prompt", "old_prompt"]);
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  expect(
    (
      await db.query<{ payload: { promptId: string; type: string } }>(
        "select payload from outbound_webhook_deliveries where payload->>'type' like 'turn.%' order by payload->>'promptId'",
      )
    ).rows.map(({ payload }) => [payload.promptId, payload.type]),
  ).toEqual([
    [publicPrompt, "turn.finished"],
    ["new_prompt", "turn.failed"],
  ]);
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime,task_prompt_id)
     select $1,golden_id,org_id,owner_id,'runtime_fixture',harness,'ready',true,'runtime_prompt'
     from sandboxes where id=$2`,
    [crypto.randomUUID(), id],
  );
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  expect((await db.query("select prompt_id from native_webhook_prompts")).rows).toHaveLength(2);
});

test("running native turns retain receipt eligibility while provider failures stop after five retries", async () => {
  const { db, sql, id } = await fixture();
  await db.query("update sandboxes set task_prompt_id='long_prompt' where id=$1", [id]);
  let failures = false;
  let cancelled: AbortController | undefined;
  let calls = 0;
  const worker = createNativeWebhookPrompts(sql, async () => ({
    id: "boat",
    async getPrompt() {
      calls++;
      cancelled?.abort();
      if (failures) throw Error("private_provider_error");
      return { promptId: "long_prompt", status: "running", done: false };
    },
  }));
  for (let i = 0; i < 6; i++) {
    await db.query("update native_webhook_prompts set next_attempt_at=now()");
    expect(await worker.reconcileOne(new AbortController().signal)).toBe(true);
  }
  expect((await db.query("select failures from native_webhook_prompts")).rows).toEqual([{ failures: 0 }]);
  failures = true;
  for (let i = 0; i < 5; i++) {
    await db.query("update native_webhook_prompts set next_attempt_at=now()");
    if (i < 3) expect(await worker.reconcileOne(new AbortController().signal)).toBe(true);
    else {
      cancelled = new AbortController();
      await expect(worker.reconcileOne(cancelled.signal)).rejects.toThrow();
      await worker.drain();
      await db.query("update native_webhook_prompts set lease_until=null");
    }
  }
  await db.query("update native_webhook_prompts set next_attempt_at=now()");
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  expect(calls).toBe(11);
  expect((await db.query("select * from outbound_webhook_deliveries")).rows).toHaveLength(0);
});

test("native receipt admission rejects removed membership and changed physical authority", async () => {
  const { db, sql, id, people } = await fixture();
  await db.query("update sandboxes set task_prompt_id='prompt' where id=$1", [id]);
  let calls = 0;
  const worker = createNativeWebhookPrompts(sql, async () => ({
    id: "boat",
    async getPrompt() {
      calls++;
      await db.query("update sandboxes set provider_sandbox_id='replacement_machine' where id=$1", [id]);
      return { promptId: "prompt", status: "finished", done: true };
    },
  }));
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(true);
  expect((await db.query("select * from outbound_webhook_deliveries")).rows).toHaveLength(0);
  await db.query("update native_webhook_prompts set lease_until=null");
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  await db.query("update sandboxes set provider_sandbox_id='native_fixture' where id=$1", [id]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  expect(calls).toBe(1);
});
