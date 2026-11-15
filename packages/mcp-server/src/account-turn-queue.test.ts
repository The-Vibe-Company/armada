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
    create table sandboxes(id uuid primary key,provider text,boat_runtime boolean,runtime_transport text,model text,reasoning_effort text,credential_id uuid,credential_version int,org_id uuid,owner_id uuid,
      conversation_ids text[],status text,deleted_at timestamptz,stopped_at timestamptz,stop_requested_at timestamptz,expires_at timestamptz,
      activity_lease_id uuid,task_prompt_id text,lifecycle_generation bigint default 0);
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
    "delete from account_turn_queue; delete from account_agent_reservations; delete from runtime_idle_turns; update sandboxes set status='ready',task_prompt_id=null,stopped_at=null,lifecycle_generation=0; update mcp_actor_epochs set epoch=1;",
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
