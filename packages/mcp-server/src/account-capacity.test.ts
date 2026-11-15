import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { admitAccountCapacity } from "./account-capacity.ts";

test("account capacity refuses a full account and admits available or unlimited capacity", async () => {
  for (const [max, running, refused] of [
    [2, 2, true],
    [2, 1, false],
    [null, 20, false],
  ] as const) {
    let reserved = false;
    const tx = {
      query: async (query: string) => {
        if (query.startsWith("select name")) return { rows: [{ name: "Shared Morph", max_agents: max }] };
        if (query.endsWith(" as running")) return { rows: [{ running }] };
        if (query.startsWith("select s.id")) return { rows: [] };
        reserved = true;
        return { rows: [] };
      },
    } as unknown as Sql;
    const admission = admitAccountCapacity(tx, "account", "sandbox");
    if (refused) {
      await expect(admission).rejects.toThrow("Shared Morph is at its limit: 2/2 agents working");
      expect(reserved).toBe(false);
    } else {
      await admission;
      expect(reserved).toBe(max !== null);
    }
  }
});

// Real SQL at the admission boundary: row locking/count predicates are the
// behavior under test, not a mock implementation of those predicates.
const db = new PGlite();
const account = "10000000-0000-4000-8000-000000000001";
const ids = [1, 2, 3].map((id) => `20000000-0000-4000-8000-${String(id).padStart(12, "0")}`);
const sql = { query: (q: string, values?: unknown[]) => db.query(q, values) } as Sql;
beforeAll(async () => {
  await db.exec(`create table credentials(id uuid primary key,name text,max_agents integer);
    create table sandboxes(id uuid primary key,credential_id uuid,deleted_at timestamptz,stopped_at timestamptz,
      status text,activity_lease_id uuid,task_prompt_id text,lifecycle_generation bigint default 1);
    create table account_turn_queue(sandbox_id uuid,state text,dispatch_generation bigint);
    create table runtime_commands(sandbox_id uuid,request_id text,result_enc bytea);
    create table runtime_idle_turns(sandbox_id uuid,prompt_id text,settled boolean,primary key(sandbox_id,prompt_id));
    create table account_agent_reservations(sandbox_id uuid primary key,account_id uuid);`);
  await db.query("insert into credentials values($1,'Shared account',2)", [account]);
  for (const id of ids)
    await db.query("insert into sandboxes(id,credential_id,status) values($1,$2,'ready')", [id, account]);
});
afterAll(() => db.close());
test("simultaneous admission serializes and terminal, failure, and stop evidence free only their work slot", async () => {
  const admit = (id: string) =>
    db.transaction((tx) => admitAccountCapacity({ query: (q, v) => tx.query(q, v) } as Sql, account, id));
  // Three live but idle machines do not occupy any account slots.
  const starts = await Promise.allSettled(ids.map(admit));
  expect(starts.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
  for (const [i, id] of ids.slice(0, 2).entries()) {
    await db.query("update sandboxes set task_prompt_id=$2,status='running' where id=$1", [id, `turn_${i}`]);
    await db.query("delete from account_agent_reservations where sandbox_id=$1", [id]);
  }
  await expect(admit(ids[2]!)).rejects.toThrow("2/2 agents working");
  // Requesting stop is not evidence that the old turn stopped computing.
  await db.query("update sandboxes set status='stopping' where id=$1", [ids[0]]);
  await expect(admit(ids[2]!)).rejects.toThrow("2/2 agents working");
  // Every harness final status (including failure/interruption) projects settled.
  await db.query("insert into runtime_idle_turns values($1,'turn_0',true)", [ids[0]]);
  await admit(ids[2]!);
  await db.query("delete from account_agent_reservations where sandbox_id=$1", [ids[2]]);
  await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [ids[1]]);
  await admit(ids[0]!);
  await db.query("delete from account_agent_reservations");
  await db.query("update sandboxes set status='failed' where id=$1", [ids[2]]);
  await admitAccountCapacity(sql, account, ids[1]!);
});

test("pending Docker prompt retains capacity until its receipt transfers ownership to the turn", async () => {
  await db.exec("truncate sandboxes,account_agent_reservations,runtime_idle_turns,account_turn_queue,runtime_commands");
  const migration = readFileSync(
    new URL("../../../supabase/migrations/20261115123000_account_turn_queue.sql", import.meta.url),
    "utf8",
  );
  // Install the actual production trigger policy rather than recreating its logic.
  await db.exec(
    migration
      .slice(migration.indexOf("create or replace function public.release_account_agent_reservation"))
      .replace(
        "drop trigger release_account_agent_reservation",
        "drop trigger if exists release_account_agent_reservation",
      ),
  );
  await db.query("update credentials set max_agents=1 where id=$1", [account]);
  for (const id of ids)
    await db.query("insert into sandboxes(id,credential_id,status) values($1,$2,'ready')", [id, account]);
  await admitAccountCapacity(sql, account, ids[0]!);
  await db.query("insert into runtime_commands values($1,'docker_prompt_pending',null)", [ids[0]]);
  await db.query("update sandboxes set task_prompt_id=null,status='running' where id=$1", [ids[0]]);
  await expect(admitAccountCapacity(sql, account, ids[1]!)).rejects.toThrow("1/1 agents working");
  await db.query("update runtime_commands set result_enc='\\x01' where sandbox_id=$1", [ids[0]]);
  await db.query("update sandboxes set task_prompt_id='native_turn' where id=$1", [ids[0]]);
  expect((await db.query("select * from account_agent_reservations")).rows).toHaveLength(0);
  await expect(admitAccountCapacity(sql, account, ids[1]!)).rejects.toThrow("1/1 agents working");
  await db.query("insert into runtime_idle_turns values($1,'native_turn',true)", [ids[0]]);
  await admitAccountCapacity(sql, account, ids[1]!);
});
