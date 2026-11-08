import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
const org = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
test("reserve enforces backend capacity across pending slots", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users (id,email) values ($1,'x@test.dev')", [owner]);
    await db.query("insert into orgs (id,name) values ($1,'x')", [org]);
    const reserve = (max: number) =>
      db.query<{ build: string }>("select public.reserve_golden_backend_slot('boat','account', $1,$2,$3) as build", [
        max,
        org,
        owner,
      ]);
    expect((await reserve(1)).rows[0]?.build).toBeDefined();
    await expect(reserve(1)).rejects.toThrow("capacity reached");
    expect((await reserve(2)).rows[0]?.build).toBeDefined();
  } finally {
    await db.close();
  }
});
