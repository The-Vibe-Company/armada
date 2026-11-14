import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import { objectiveStore } from "./objectives.ts";
import { waitStore } from "./waits.ts";

let db: PGlite;
const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const caller = { userId: user, orgs: [{ orgId: org, role: "admin" as const }], via: "supabase" as const };
let sql: Sql;
beforeAll(async () => {
  db = await openMigratedDatabase();
  sql = { query: (text, params) => db.query(text, params) };
  await db.query("insert into auth.users(id) values ($1)", [user]);
  await db.query("insert into public.orgs(id,name) values ($1,'Wait test')", [org]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [org, user]);
});
afterAll(async () => {
  await db?.close();
});
test("durable questions default only reversible choices, dedupe reminders, cap work and isolate owners", async () => {
  const objective = await objectiveStore(sql, caller, org).create("owner/repo", "Request");
  const store = waitStore(sql, caller, org);
  const base = {
    objective_id: objective!.id,
    kind: "human" as const,
    phase: "work" as const,
    question: "Choose a path",
    choices: [{ id: "yes", label: "Continue" }],
  };
  const reversible = await store.create({
    ...base,
    dedupe_key: "reversible",
    reason: "reversible",
    default_choice: "yes",
  });
  const approval = await store.create({ ...base, dedupe_key: "approval", reason: "approval" });
  expect(
    (await store.create({ ...base, dedupe_key: "reversible", reason: "reversible", default_choice: "yes" }))?.id,
  ).toBe(reversible!.id);
  await store.create({ ...base, dedupe_key: "budget", reason: "budget" });
  await expect(store.create({ ...base, dedupe_key: "fourth", reason: "irreversible" })).rejects.toThrow(
    "objective_question_limit",
  );
  await store.create({ ...base, dedupe_key: "interview", phase: "interview", reason: "approval" });
  const access = await store.create({
    ...base,
    dedupe_key: "access",
    kind: "access",
    phase: "interview",
    reason: "access",
    choices: [],
    connection_url: "/settings",
  });
  expect(access?.connection_url).toBe("/settings");
  for (const reason of ["irreversible", "two_failed_attempts"] as const)
    await store.create({ ...base, dedupe_key: reason, phase: "interview", reason });
  const reminders = await store.reconcile("2099-01-01T00:00:00Z");
  expect(reminders.find((w) => w.id === reversible!.id)?.status).toBe("defaulted");
  expect(
    reminders.filter((w) => w.reason !== "reversible").every((w) => w.status === "parked" && w.resolution === null),
  ).toBe(true);
  expect(await store.reconcile("2099-01-02T00:00:00Z")).toEqual([]);
  expect(await store.answer(approval!.id, "arbitrary secret")).toBeNull();
  expect((await store.answer(approval!.id, "yes"))?.status).toBe("answered");
  const ci = await store.create({ ...base, dedupe_key: "ci-head", kind: "ci", reason: "observation", choices: [] });
  expect((await store.pending()).some((w) => w.id === ci!.id)).toBe(true);
  expect(await store.answer(ci!.id, "yes")).toBeNull();
  expect((await store.pending()).find((w) => w.id === ci!.id)?.status).toBe("open");
  const stranger = waitStore(sql, { ...caller, userId: "33333333-3333-4333-8333-333333333333" }, org);
  expect(await stranger.list()).toEqual([]);
  expect(await stranger.answer(approval!.id, "yes")).toBeNull();
  await db.query("insert into auth.users(id) values ($1)", ["44444444-4444-4444-8444-444444444444"]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [
    org,
    "44444444-4444-4444-8444-444444444444",
  ]);
  await db.query("delete from public.members where org_id=$1 and user_id=$2", [org, user]);
  expect(await store.list()).toEqual([]);
});
