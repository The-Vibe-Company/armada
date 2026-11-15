import { expect, test } from "bun:test";
import { createSqlVaultStore, type Sql } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createSqlGoldenList } from "../src/golden-list.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const fixture = rowOnlyDatabase();

test("one-statement golden lists retain fresh scope guards, private ownership, name semantics and caller order", async () => {
  const { db, people } = await fixture();
  let queries = 0;
  const sql: Sql = {
    query: async <T>(text: string, params?: unknown[]) => {
      queries++;
      return db.query<T>(text, params);
    },
  };
  const list = createSqlGoldenList(sql, createSqlVaultStore(sql));
  const caller: Caller = {
    userId: people.member,
    via: "supabase",
    orgs: [
      { orgId: people.otherOrg, role: "admin" },
      { orgId: people.org, role: "member" },
    ],
  };
  async function names(who: Caller, ref?: string) {
    queries = 0;
    try {
      return (await list(who, ref)).map((row) => row.name);
    } finally {
      expect(queries).toBe(1);
    }
  }
  expect(await names(caller)).toEqual(["elsewhere", "shared"]);
  expect(await names(caller, people.org.toUpperCase())).toEqual(["shared"]);
  // Use core's exact JS normalization, not PostgreSQL's different Unicode trim/case rules.
  await db.query("update orgs set name=$2 where id=$1", [people.org, "\u00a0ExAmPle\u2007"]);
  expect(await names(caller, " example ")).toEqual(["shared"]);
  await expect(names(caller, "")).rejects.toMatchObject({ code: "invalid" });
  const owner: Caller = { userId: people.owner, via: "supabase", orgs: [{ orgId: people.org, role: "member" }] };
  expect(await names(owner, people.org)).toEqual(["mine", "shared"]);
  const admin: Caller = { userId: people.admin, via: "supabase", orgs: [{ orgId: people.org, role: "admin" }] };
  expect(await names(admin, people.org)).toEqual(["shared"]);
  // Actual memberships cannot expand the principal's frozen organization set.
  const limited = { ...caller, orgs: [{ orgId: people.org, role: "member" as const }] };
  expect(await names(limited)).toEqual(["shared"]);
  expect(await names(limited, people.otherOrg)).toEqual([]);
  const service = { ...limited, via: "service" as const };
  queries = 0;
  await expect(list(service, people.otherOrg)).rejects.toMatchObject({ code: "forbidden" });
  expect(queries).toBe(0);
  await db.query("update goldens set removed_at=now() where org_id=$1", [people.org]);
  expect(await names(caller, people.org)).toEqual([]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.member]);
  await expect(names(caller, people.org)).rejects.toMatchObject({ code: "not_found" });
  expect(await names(caller)).toEqual(["elsewhere"]);
});

test("HTTP golden listing uses the combined read without a separate scope lookup", async () => {
  const { db, people } = await fixture();
  let queries = 0;
  const sql: Sql = {
    query: async <T>(text: string, params?: unknown[]) => {
      queries++;
      return db.query<T>(text, params);
    },
  };
  const store = createSqlVaultStore(sql);
  const options = {
    store,
    data: createSqlData(sql),
    listGoldenRecords: createSqlGoldenList(sql, store),
    authStore: { memberships: async () => [{ orgId: people.org, name: "Example", role: "member" }] },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => Response.json({ id: people.member }),
    },
  } as unknown as ControlOptions;
  const response = await handleControlRequest(
    new Request("https://armada.test/api/v1/golden/list", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" },
      body: JSON.stringify({ org: people.org }),
    }),
    options,
  );
  if (!response) throw new Error("Expected a control response.");
  expect(response.status).toBe(200);
  expect(((await response.json()) as { goldens: { name: string }[] }).goldens.map((row) => row.name)).toEqual([
    "shared",
  ]);
  expect(queries).toBe(1);
});
