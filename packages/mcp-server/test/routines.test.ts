import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createRoutineService,
  createSqlVaultStore,
  createTemplateService,
  type Routine,
  type Sql,
} from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

// Primary owner for routine CRUD/admission and grants: real services over the real migrations.
async function fixture() {
  const { db, people } = await database();
  const sql: Sql = { query: (s, p) => db.query(s, p), transaction: (work) => db.transaction((tx) => work(tx)) };
  const actor = (userId = people.owner) => ({ userId, orgs: [{ orgId: people.org }] });
  const templates = createTemplateService(sql);
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!.id;
  const template = async (user = people.owner, scope = "personal") => {
    const result = await templates.command(actor(user), "create", {
      org: people.org,
      name: crypto.randomUUID(),
      scope,
      definition: {
        goldenId: golden,
        provider: "boat",
        harness: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        connections: [],
        variables: [],
      },
    });
    return (result.item as { id: string }).id;
  };
  const service = createRoutineService(sql);
  const config = (templateId: string) => ({
    name: "Daily inspection",
    templateId,
    templateRevision: 1,
    prompt: "Inspect\nwithout editing",
    intervalHours: 1,
    maxRunsPerDay: 24,
    ttlSeconds: 3600,
  });
  const command = (operation: string, input: Record<string, unknown>, user = people.owner) =>
    service.command(actor(user), operation, { org: people.org, ...input });
  const create = async (templateId: string, scope = "personal", user = people.owner) =>
    (await command("create", { ...config(templateId), scope }, user)).item as Routine;
  return { db, sql, people, actor, service, template, config, command, create };
}

test("routine CRUD pins revisions, preserves prompt bytes, uses optimistic versions and cannot enable", async () => {
  const f = await fixture();
  try {
    const templateId = await f.template();
    const created = await f.create(templateId);
    expect(created).toMatchObject({
      status: "paused",
      version: 1,
      ownerId: f.people.owner,
      templateRevision: 1,
      prompt: "Inspect\nwithout editing",
    });
    expect((await f.command("get", { id: created.id })).item).toMatchObject({ id: created.id });
    const updated = (
      await f.command("update", { ...f.config(templateId), id: created.id, expectedVersion: 1, prompt: "New prompt" })
    ).item as Routine;
    expect(updated).toMatchObject({ version: 2, prompt: "New prompt", ownerId: created.ownerId });
    await expect(
      f.command("update", { ...f.config(templateId), id: created.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.command("create", { ...f.config(templateId), scope: "personal", status: "enabled" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(f.command("enable", { id: created.id })).rejects.toMatchObject({ code: "invalid" });
    for (const bad of [
      { intervalHours: 0 },
      { intervalHours: null },
      { intervalHours: 1.5 },
      { intervalHours: 721 },
      { maxRunsPerDay: 25 },
      { ttlSeconds: 299 },
      { ttlSeconds: 86401 },
      { prompt: " " },
      { prompt: "x".repeat(32001) },
      { templateRevision: 2 },
    ]) {
      await expect(f.command("create", { ...f.config(templateId), scope: "personal", ...bad })).rejects.toMatchObject({
        code: "templateRevision" in bad ? "not_found" : "invalid",
      });
    }
    const defaults = (
      await f.command("create", {
        name: "Defaults",
        templateId,
        templateRevision: 1,
        prompt: "Inspect",
        scope: "personal",
      })
    ).item as Routine;
    expect(defaults).toMatchObject({ intervalHours: 24, maxRunsPerDay: 24, ttlSeconds: 3600 });
    await f.command("delete", { id: created.id, expectedVersion: 2 });
    await expect(f.command("get", { id: created.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await f.command("list", {})).items).toHaveLength(1);
    expect(
      (await f.db.query<{ status: string }>("select status from routines where id=$1", [created.id])).rows[0]!.status,
    ).toBe("deleted");
  } finally {
    await f.db.close();
  }
});

test("routine authorization isolates personal definitions and confines shared writes to current admins", async () => {
  const f = await fixture();
  try {
    const personalTemplate = await f.template();
    const privateRoutine = await f.create(personalTemplate);
    for (const user of [f.people.admin, f.people.member]) {
      expect((await f.command("list", {}, user)).items).toEqual([]);
      await expect(f.command("get", { id: privateRoutine.id }, user)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(f.create(personalTemplate, "org")).rejects.toMatchObject({ code: "forbidden" });
    const adminsPersonalTemplate = await f.template(f.people.admin);
    await expect(f.create(adminsPersonalTemplate, "org", f.people.admin)).rejects.toMatchObject({ code: "not_found" });
    const sharedTemplate = await f.template(f.people.admin, "org");
    const shared = await f.create(sharedTemplate, "org", f.people.admin);
    const multiOrgActor = { userId: f.people.member, orgs: [{ orgId: f.people.org }, { orgId: f.people.otherOrg }] };
    await expect(
      f.service.command(multiOrgActor, "create", {
        org: f.people.otherOrg,
        ...f.config(sharedTemplate),
        scope: "personal",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.service.command(multiOrgActor, "get", { org: f.people.otherOrg, id: shared.id }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect((await f.command("get", { id: shared.id }, f.people.member)).item).toMatchObject({ id: shared.id });
    await expect(f.command("delete", { id: shared.id, expectedVersion: 1 })).rejects.toMatchObject({
      code: "forbidden",
    });
    await f.db.query("update members set role='admin' where user_id=$1 and org_id=$2", [f.people.member, f.people.org]);
    await f.db.query("update members set role='member' where user_id=$1 and org_id=$2", [f.people.admin, f.people.org]);
    await expect(
      f.command("update", { ...f.config(sharedTemplate), id: shared.id, expectedVersion: 1 }, f.people.admin),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.db.query("delete from members where user_id=$1 and org_id=$2", [f.people.owner, f.people.org]);
    await expect(f.command("list", {})).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await f.db.close();
  }
});

test("routine JWT grants deny direct writes and hide personal prompts including from admins", async () => {
  const f = await fixture();
  try {
    await f.create(await f.template());
    const shared = await f.create(await f.template(f.people.admin, "org"), "org", f.people.admin);
    await f.db.exec("set role anon");
    await expect(f.db.query("select * from routines")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.admin]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query<{ id: string }>("select id from routines")).rows).toEqual([{ id: shared.id }]);
    await expect(f.db.query("update routines set prompt='bypass'")).rejects.toThrow("permission denied");
    await expect(f.db.query("delete from routines")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
  } finally {
    await f.db.close();
  }
});

test("routine HTTP routes authenticate, reject query parameters, and persist strict JSON requests", async () => {
  const f = await fixture();
  try {
    const options: ControlOptions = {
      routines: f.service,
      store: createSqlVaultStore(f.sql),
      authStore: createSqlAuthStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "synthetic-anon",
        fetch: async () => Response.json({ id: f.people.owner }),
      },
    };
    const api = (operation: string, body: unknown, bearer = true, query = "") =>
      handleControlRequest(
        new Request(`https://armada.test/api/v1/routines/${operation}${query}`, {
          method: "POST",
          headers: bearer ? { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" } : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    expect((await api("list", { org: f.people.org }, false))?.status).toBe(401);
    expect((await api("list", { org: f.people.org }, true, "?ignored=1"))?.status).toBe(400);
    const templateId = await f.template();
    expect(
      (await api("create", { org: f.people.org, ...f.config(templateId), scope: "personal", enabled: true }))?.status,
    ).toBe(400);
    const response = await api("create", { org: f.people.org, ...f.config(templateId), scope: "personal" });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const saved = (await response!.json()) as { item: Routine };
    expect((await f.command("get", { id: saved.item.id })).item).toMatchObject({
      prompt: "Inspect\nwithout editing",
      status: "paused",
    });
  } finally {
    await f.db.close();
  }
});
