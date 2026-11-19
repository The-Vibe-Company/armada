import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";

const user = "00000000-0000-0000-0000-000000000001";
const first = "00000000-0000-0000-0000-000000000002";
const second = "00000000-0000-0000-0000-000000000003";
const shared = "00000000-0000-0000-0000-000000000004";
let connection: Awaited<ReturnType<typeof openDatabase>> | undefined = await openDatabase();

beforeAll(async () => {
  const db = database();
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create table auth.users (id uuid primary key);
    create table public.credentials (id uuid primary key, scope text not null, owner_id uuid not null);
  `);
  await db.exec(await Bun.file(join(migrationsDir, "20261115220000_agent_defaults.sql")).text());
  await db.query("insert into auth.users values ($1)", [user]);
  await db.query("insert into public.credentials values ($1,'user',$4), ($2,'user',$4), ($3,'org',$3)", [
    first,
    second,
    shared,
    user,
  ]);
  await db.query(
    "insert into public.agent_defaults(user_id,harness,credential_id) values ($1,'codex',$2), ($1,'claude',$3)",
    [user, first, shared],
  );
  await db.exec(await Bun.file(join(migrationsDir, "20261119113923_agent_default_account_order.sql")).text());
});

beforeEach(() => database().exec("begin"));
afterEach(() => connection?.exec("rollback"));
afterAll(async () => {
  const db = connection;
  connection = undefined;
  await db?.close();
});

function database() {
  if (!connection) throw new Error("Database fixture is not open");
  return connection;
}

async function order(harness: string) {
  return (
    await database().query<{ credential_ids: string[] }>(
      "select credential_ids from public.agent_defaults where user_id=$1 and harness=$2",
      [user, harness],
    )
  ).rows[0]?.credential_ids;
}

test("backfills personal defaults while leaving shared defaults outside personal pools", async () => {
  expect(await order("codex")).toEqual([first]);
  expect(await order("claude")).toEqual([]);
});

test("scalar-only default writes keep the ordered column current during database overlap", async () => {
  const upsert = (id: string | null) =>
    database().query(
      `insert into public.agent_defaults(user_id,harness,credential_id) values ($1,'opencode',$2)
       on conflict(user_id,harness) do update set credential_id=excluded.credential_id`,
      [user, id],
    );

  await upsert(first);
  expect(await order("opencode")).toEqual([first]);
  await upsert(second);
  expect(await order("opencode")).toEqual([second]);
  await upsert(null);
  expect(await order("opencode")).toEqual([]);
});

test("explicit pool writes preserve account order independently of the scalar default", async () => {
  await database().query(
    "update public.agent_defaults set credential_id=$2, credential_ids=array[$2::uuid,$3::uuid] where user_id=$1 and harness='claude'",
    [user, second, first],
  );
  expect(await order("claude")).toEqual([second, first]);
});

test("an explicitly empty pool remains empty when a scalar default is present on insert", async () => {
  await database().query(
    "insert into public.agent_defaults(user_id,harness,credential_id,credential_ids) values ($1,'opencode',$2,'{}')",
    [user, first],
  );
  expect(await order("opencode")).toEqual([]);
});

test("deleting the scalar default preserves surviving ordered accounts", async () => {
  await database().query(
    "update public.agent_defaults set credential_id=$2, credential_ids=array[$2::uuid,$3::uuid] where user_id=$1 and harness='codex'",
    [user, second, first],
  );
  await database().query("delete from public.credentials where id=$1", [second]);
  expect(await order("codex")).toEqual([first]);
});

test("a pool writer can restore an unchanged array after updating the scalar mirror", async () => {
  await database().query("update public.agent_defaults set credential_id=$2 where user_id=$1 and harness='claude'", [
    user,
    first,
  ]);
  await database().query("update public.agent_defaults set credential_ids='{}' where user_id=$1 and harness='claude'", [
    user,
  ]);
  expect(await order("claude")).toEqual([]);
});
