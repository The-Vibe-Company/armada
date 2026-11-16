import { expect, test } from "bun:test";
import { rowOnlyConnection } from "../../mcp-server/test/row-only-database.ts";

const connection = rowOnlyConnection();

test("golden backend slots are service-role only", async () => {
  const db = await connection();
  const grants = await db.query<{ grantee: string }>(
    "select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'golden_backend_slots' and grantee in ('anon', 'authenticated', 'PUBLIC')",
  );
  expect(grants.rows).toEqual([]);
  const rls = await db.query<{ relrowsecurity: boolean }>(
    "select relrowsecurity from pg_class where relname = 'golden_backend_slots'",
  );
  expect(rls.rows[0]?.relrowsecurity).toBe(true);
  const routines = await db.query<{
    proname: string;
    prosecdef: boolean;
    public_execute: boolean;
    service_execute: boolean;
  }>(
    `select p.proname, p.prosecdef,
      has_function_privilege('public', p.oid, 'execute') as public_execute,
      has_function_privilege('service_role', p.oid, 'execute') as service_execute
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'reserve_golden_backend_slot', 'reserve_existing_golden_backend_slot',
       'finalize_golden_backend_slot', 'release_golden_backend_slot', 'rebuild_golden_backend_slots'
     ) order by p.proname`,
  );
  expect(routines.rows).toHaveLength(5);
  for (const routine of routines.rows) {
    expect(routine.prosecdef).toBe(false);
    expect(routine.public_execute).toBe(false);
    expect(routine.service_execute).toBe(true);
  }
});

const org = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
test("reserve enforces backend capacity across pending slots", async () => {
  const db = await connection();
  await db.query("insert into auth.users (id,email) values ($1,'x@test.dev')", [owner]);
  await db.query("insert into orgs (id,name) values ($1,'x')", [org]);
  const reserve = (max: number) =>
    db.query<{ build: string }>("select public.reserve_golden_backend_slot('test','account', $1,$2,$3) as build", [
      max,
      org,
      owner,
    ]);
  expect((await reserve(1)).rows[0]?.build).toBeDefined();
  await expect(reserve(1)).rejects.toThrow("capacity reached");
  expect((await reserve(2)).rows[0]?.build).toBeDefined();
});
