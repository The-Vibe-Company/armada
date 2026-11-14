import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import { objectiveStore } from "./objectives.ts";

let db: PGlite;
const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => {
  db = await openMigratedDatabase();
  await db.query("insert into auth.users(id) values ($1)", [user]);
  await db.query("insert into public.orgs(id,name) values ($1,'Objective test')", [org]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [org, user]);
});
afterAll(async () => {
  await db?.close();
});

test("appending messages advances the durable objective revision and modification time", async () => {
  const sql: Sql = { query: (text, params) => db.query(text, params) };
  const store = objectiveStore(sql, { userId: user, orgs: [{ orgId: org, role: "admin" }], via: "supabase" }, org);
  const objective = await store.create("owner/repository", "Original request");
  expect(objective?.revision).toBe(1);
  // Fixed historical time: no sleep or wall-clock timing assumption.
  await db.query("update public.otto_objectives set updated_at='2000-01-01' where id=$1", [objective!.id]);
  await store.append(objective!.id, "First message");
  await store.append(objective!.id, "Second message");
  const thread = await store.thread(objective!.id);
  expect(thread?.objective.revision).toBe(3);
  expect(new Date(thread!.objective.updated_at).getTime()).toBeGreaterThan(Date.UTC(2000, 0, 1));
  expect(thread?.messages.map((message) => message.body)).toEqual(["First message", "Second message"]);
});
