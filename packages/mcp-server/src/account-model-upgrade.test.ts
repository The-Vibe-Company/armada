import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { accountWorkingCountSql, encryptSecret, type Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { admitAccountCapacity } from "./account-capacity.ts";
import { repairHistoricalTurnModels } from "./account-model-upgrade.ts";

const db = new PGlite();
const key = Buffer.alloc(32, 7).toString("base64");
const account = "10000000-0000-4000-8000-000000000001";
const ids = [1, 2, 3].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const query = <T>(q: string, v?: unknown[]) => db.query<T>(q, v);
const sql = {
  query,
  transaction: (fn: (tx: Sql) => Promise<unknown>) =>
    db.transaction((tx) => fn({ query: (q: string, v?: unknown[]) => tx.query(q, v) } as Sql)),
} as Sql;
beforeAll(async () => {
  await db.exec(`create role authenticated;
    create table credentials(id uuid primary key,name text,max_agents integer);
    create table sandboxes(id uuid primary key,credential_id uuid,model text,status text,
      deleted_at timestamptz,stopped_at timestamptz,activity_lease_id uuid,task_prompt_id text,lifecycle_generation bigint default 1);
    create table runtime_idle_turns(sandbox_id uuid,prompt_id text,settled boolean);
    create table account_turn_queue(sandbox_id uuid,request_id uuid,input_enc bytea,state text,sequence bigint,dispatch_generation bigint,account_id uuid,dispatch_until timestamptz);
    create table account_agent_reservations(sandbox_id uuid primary key,account_id uuid);`);
  await query("insert into credentials values($1,'Upgrade account',10)", [account]);
  for (const [i, id] of ids.entries()) {
    await query("insert into sandboxes(id,credential_id,model,status,task_prompt_id) values($1,$2,'deepseek',$3,$4)", [
      id,
      account,
      i === 0 ? "running" : "ready",
      i === 0 ? "override_turn" : null,
    ]);
  }
  const sealed = await encryptSecret(JSON.stringify({ model: "kimi", prompt: "override turn" }), key);
  for (const [i, id] of ids.slice(0, 2).entries())
    await query("insert into account_turn_queue(sandbox_id,request_id,input_enc,state,sequence,dispatch_generation) values($1,$1,$2,$3,$4,null)", [
      id,
      sealed,
      i === 0 ? "admitted" : "queued",
      i + 1,
    ]);
  await query("insert into account_agent_reservations values($1,$2)", [ids[0], account]);
  await db.exec(readFileSync("supabase/migrations/20261116180000_account_model_limits.sql", "utf8"));
});
afterAll(() => db.close());

test("upgrade reconstructs override identities for active work, reservations and queued admission", async () => {
  expect((await query<{ model: string }>("select model from account_turn_queue")).rows.map((r) => r.model)).toEqual([
    "deepseek",
    "deepseek",
  ]); // Reproduces the released migration's incorrect attribution.
  await db.exec(readFileSync("supabase/migrations/20261116200000_repair_historical_turn_models.sql", "utf8"));
  await query("update credentials set model_limits='{\"kimi\":1}'");
  await expect(admitAccountCapacity(sql, account, ids[2]!, "kimi")).rejects.toThrow("kimi");
  await repairHistoricalTurnModels(sql, key);
  expect(
    (await query<{ model: string }>("select model from account_turn_queue order by sequence")).rows.map((r) => r.model),
  ).toEqual(["kimi", "kimi"]);
  expect((await query<{ model: string }>("select model from account_agent_reservations")).rows[0]?.model).toBe("kimi");
  const usage = await query<{ running: number }>(
    `select ${accountWorkingCountSql("$1", "null::uuid", "'kimi'")} as running`,
    [account],
  );
  expect(Number(usage.rows[0]?.running)).toBe(1); // Reservation and running turn are one slot.
  const queued = (await query<{ model: string }>("select model from account_turn_queue where state='queued'")).rows[0]!;
  await expect(admitAccountCapacity(sql, account, ids[1]!, queued.model)).rejects.toThrow("kimi");
  await admitAccountCapacity(sql, account, ids[2]!, "deepseek");
});

test("unreadable historical input aborts the entire repair without exposing plaintext", async () => {
  await query("update account_turn_queue set model=null");
  const malformed = await encryptSecret("private_prompt_invalid_json", key);
  await query("update account_turn_queue set input_enc=$1 where state='queued'", [malformed]);
  await expect(repairHistoricalTurnModels(sql, key)).rejects.toThrow("Historical turn model reconstruction failed.");
  expect(
    (await query<{ model: string | null }>("select model from account_turn_queue")).rows.map((row) => row.model),
  ).toEqual([null, null]);
});
