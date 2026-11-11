import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import type { GoldenActor, Sql } from "@armada/core/server";
import { createSqlVaultStore } from "@armada/core/server";
import type { GoldenRow } from "../../core/src/golden-store.ts";
import { GOLDEN_SELECT, mapGoldenRow } from "../../core/src/golden-store.ts";
import { createSkillDefaultsService } from "../../core/src/skill-defaults.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Owner boundary: real migrations and service-role SQL, including user-JWT access.
async function fixture() {
  const { db, people } = await database();
  const sql: Sql = { query: (s, p) => db.query(s, p), transaction: (work) => db.transaction((tx) => work(tx)) };
  const service = createSkillDefaultsService(sql);
  const actor = (userId = people.owner, org = people.org) => ({
    userId,
    orgs: [{ orgId: org, role: "member" as const }],
  });
  const rows = (await db.query<GoldenRow>(`select ${GOLDEN_SELECT} from goldens`)).rows;
  const sharedRow = rows.find((r) => r.name === "shared");
  const privateRow = rows.find((r) => r.name === "mine");
  if (!sharedRow || !privateRow) throw new Error("Missing golden fixtures.");
  const shared = mapGoldenRow(sharedRow);
  const privateGolden = mapGoldenRow(privateRow);
  const request = (scope: string, skills?: unknown, goldenId?: string) => ({
    org: people.org,
    scope,
    ...(skills !== undefined ? { skills } : {}),
    ...(goldenId ? { goldenId } : {}),
  });
  return { db, people, sql, service, actor, shared, privateGolden, request };
}

test("skill defaults require strict exact pins and authorized current membership, not stale role claims", async () => {
  const f = await fixture();
  try {
    for (const input of [
      f.request("personal", ["tools@latest"]),
      f.request("personal", ["tools@1.0.0", "team/tools@2.0.0"]),
      f.request("personal", ["armada-tools@1.0.0"]),
      f.request("personal", "tools@1.0.0"),
      f.request(
        "personal",
        Array.from({ length: 21 }, (_, i) => `tool-${i}@1.0.0`),
      ),
      { ...f.request("personal", []), unexpected: true },
      { ...f.request("personal", []), goldenId: f.shared.id },
      f.request("golden", []),
    ]) {
      await expect(f.service.command(f.actor(), "set", input)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(f.service.command(f.actor(), "get", f.request("personal", []))).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(f.service.command(f.actor(), "set", f.request("org", ["team/tool@1.0.0"]))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(f.service.command(f.actor(), "set", f.request("golden", [], f.shared.id))).rejects.toMatchObject({
      code: "forbidden",
    });
    await f.service.command(f.actor(f.people.admin), "set", f.request("org", ["team/tool@1.0.0"]));
    await f.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await f.db.query("update members set role='member' where org_id=$1 and user_id=$2", [f.people.org, f.people.admin]);
    await expect(f.service.command(f.actor(f.people.admin), "set", f.request("org", []))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      f.service.command(f.actor(f.people.member, f.people.otherOrg), "get", f.request("personal")),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    await expect(f.service.command(f.actor(), "get", f.request("personal"))).rejects.toMatchObject({
      code: "forbidden",
    });
  } finally {
    await f.db.close();
  }
});

test("skill defaults resolve global personal and org/golden layers, clear with empty lists, and reject stale golden access", async () => {
  const f = await fixture();
  try {
    const actor: GoldenActor = { userId: f.people.member, orgId: f.people.org, role: "admin" };
    expect(await f.service.resolve(actor, f.shared)).toEqual({ personal: [], org: [], environment: [] });
    await f.service.command(f.actor(f.people.member, f.people.otherOrg), "set", {
      org: f.people.otherOrg,
      scope: "personal",
      skills: ["personal@1.0.0"],
    });
    await f.service.command(f.actor(f.people.admin), "set", f.request("org", ["team/org@2.0.0"]));
    await f.service.command(f.actor(f.people.admin), "set", f.request("golden", ["team/env@3.0.0"], f.shared.id));
    expect(await f.service.resolve(actor, f.shared)).toEqual({
      personal: ["personal@1.0.0"],
      org: ["team/org@2.0.0"],
      environment: ["team/env@3.0.0"],
    });
    expect(await f.service.command(f.actor(f.people.member), "get", f.request("personal"))).toEqual({
      skills: ["personal@1.0.0"],
    });
    await f.service.command(f.actor(f.people.member), "set", f.request("personal", []));
    expect((await f.service.resolve(actor, f.shared)).personal).toEqual([]);
    for (const goldenId of [f.privateGolden.id, crypto.randomUUID()]) {
      for (const operation of ["get", "set"] as const) {
        await expect(
          f.service.command(
            f.actor(f.people.admin),
            operation,
            f.request("golden", operation === "set" ? [] : undefined, goldenId),
          ),
        ).rejects.toMatchObject({ code: "not_found", message: "Golden unavailable." });
      }
    }
    await f.service.command(f.actor(), "set", f.request("golden", ["private@1.0.0"], f.privateGolden.id));
    await expect(f.service.resolve(actor, f.privateGolden)).rejects.toMatchObject({ code: "not_found" });
    await f.db.query("update goldens set removed_at=now() where id=$1", [f.shared.id]);
    await expect(f.service.resolve(actor, f.shared)).rejects.toMatchObject({ code: "not_found" });
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await expect(f.service.resolve(actor, f.shared)).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await f.db.close();
  }
});

test("skill defaults JWT reads obey own/org/private visibility and never permit direct writes", async () => {
  const f = await fixture();
  try {
    await f.service.command(f.actor(), "set", f.request("personal", ["own@1.0.0"]));
    await f.service.command(f.actor(f.people.admin), "set", f.request("personal", ["admin@1.0.0"]));
    await f.service.command(f.actor(f.people.admin), "set", f.request("org", []));
    await f.service.command(f.actor(), "set", f.request("golden", [], f.privateGolden.id));
    await f.service.command(f.actor(f.people.admin), "set", f.request("golden", [], f.shared.id));
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.admin]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query("select skills from personal_skill_defaults")).rows).toEqual([
      { skills: ["admin@1.0.0"] },
    ]);
    expect((await f.db.query("select golden_id from golden_skill_defaults")).rows).toEqual([
      { golden_id: f.shared.id },
    ]);
    expect((await f.db.query("select * from org_skill_defaults")).rows).toHaveLength(1);
    for (const table of ["personal_skill_defaults", "org_skill_defaults", "golden_skill_defaults"]) {
      await expect(f.db.query(`update ${table} set skills='[]'`)).rejects.toThrow("permission denied");
      await expect(f.db.query(`delete from ${table}`)).rejects.toThrow("permission denied");
    }
    await f.db.exec("reset role");
    await f.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.admin]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query("select * from org_skill_defaults")).rows).toEqual([]);
    expect((await f.db.query("select * from golden_skill_defaults")).rows).toEqual([]);
    await f.db.exec("reset role; set role anon");
    await expect(f.db.query("select * from personal_skill_defaults")).rejects.toThrow("permission denied");
  } finally {
    await f.db.close();
  }
});

test("HTTP and MCP default operations share persisted state and strict authenticated transport validation", async () => {
  const f = await fixture();
  try {
    const boat = fakeBoat();
    const options: ControlOptions = {
      skillDefaults: f.service,
      store: createSqlVaultStore(f.sql),
      authStore: createSqlAuthStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(f.sql),
      providers: { resolve: async () => boat.provider },
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "synthetic-anon",
        fetch: async () => Response.json({ id: f.people.owner }),
      },
    };
    const api = (operation: string, body: unknown, authenticated = true, query = "") =>
      handleControlRequest(
        new Request(`https://armada.test/api/v1/skills/defaults/${operation}${query}`, {
          method: "POST",
          headers: authenticated ? { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" } : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    const read = f.request("personal");
    expect((await api("get", read, false))?.status).toBe(401);
    expect((await api("get", read, true, "?scope=org"))?.status).toBe(400);
    expect((await api("set", { ...f.request("personal", []), extra: 1 }))?.status).toBe(400);
    const saved = await api("set", f.request("personal", ["team/tool@1.2.3"]));
    expect(saved?.status).toBe(200);
    expect(saved?.headers.get("cache-control")).toBe("no-store");
    expect(await saved?.json()).toEqual({ skills: ["team/tool@1.2.3"] });
    const caller = { ...f.actor(), via: "supabase" as const };
    const context = {
      skillDefaults: f.service,
      caller,
      data: createSqlData(f.sql)(caller),
      provider: async () => boat.provider,
      launchCredentials: {
        resolve: async () => {
          throw new Error("Defaults operations never resolve launch credentials.");
        },
      },
      exposedSecrets: async () => [],
      now: () => new Date(),
      sleep: async () => {},
    };
    expect(await callSharedTool(context, "skill_defaults_get", read)).toEqual({ skills: ["team/tool@1.2.3"] });
    await expect(
      callSharedTool(context, "skill_defaults_set", { ...f.request("personal", []), extra: 1 }),
    ).rejects.toThrow();
    await expect(callSharedTool(context, "skill_defaults_get", f.request("personal", []))).rejects.toThrow();
    expect(await callSharedTool(context, "skill_defaults_set", f.request("personal", []))).toEqual({ skills: [] });
    expect(await (await api("get", read))?.json()).toEqual({ skills: [] });
  } finally {
    await f.db.close();
  }
});
