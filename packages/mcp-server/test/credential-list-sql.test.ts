import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, encryptSecret, listCredentials, type Sql } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlCredentialList } from "../src/credential-list-sql.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

test("one metadata statement preserves canonical credentials, all reference forms and fresh membership", async () => {
  const { db, people } = await database();
  await db.query(
    "insert into credentials(scope,owner_id,kind,value_enc,status) values('user',$1,'anthropic',$2,'deleted')",
    [people.owner, await encryptSecret("deleted_placeholder", ENCRYPTION_KEY)],
  );
  let queries = 0;
  const sql: Sql = {
    query: async <T>(text: string, params?: unknown[]) => {
      queries++;
      return db.query<T>(text, params);
    },
  };
  const store = createSqlVaultStore(sql);
  const list = createSqlCredentialList(sql, store);
  // Independent legacy SQL projection is the existing wire contract, not the new mapper's output.
  const canonical = await listCredentials(store, people.owner, people.org);
  queries = 0;
  expect(await list(people.owner, people.org.toUpperCase())).toEqual(canonical);
  expect(queries).toBe(1);
  expect(canonical.user.map((row) => row.kind)).not.toContain("anthropic");
  expect(canonical.orgs[0]!.credentials[0]).toEqual({ kind: "boat", createdAt: null });
  await db.query("update orgs set name=$2 where id=$1", [people.org, "\u00a0ExAmPle\u2007"]);
  for (const ref of ["example", "", undefined]) {
    queries = 0;
    const result = await list(people.owner, ref);
    expect(result.orgs.map((row) => row.id)).toEqual([people.org]);
    expect(queries).toBe(1);
  }
  const expectedOrgOrder = (await store.memberships(people.member)).map((row) => row.id);
  queries = 0;
  const multiple = await list(people.member, undefined);
  expect(multiple.orgs.map((row) => row.id)).toEqual(expectedOrgOrder);
  expect(multiple.orgs.find((row) => row.id === people.otherOrg)?.credentials).toEqual([]);
  expect(queries).toBe(1);
  queries = 0;
  await expect(list(people.member, "")).rejects.toMatchObject({ code: "invalid" });
  expect(queries).toBe(1);
  await db.query("delete from members where user_id=$1 and org_id=$2", [people.owner, people.org]);
  queries = 0;
  await expect(list(people.owner, people.org)).rejects.toMatchObject({ code: "not_found" });
  expect(queries).toBe(1);
  queries = 0;
  const ownOnly = await list(people.owner, undefined);
  expect(ownOnly.orgs).toEqual([]);
  expect(ownOnly.user).toEqual(canonical.user);
  expect(queries).toBe(1);
});

test("HTTP credentials use one statement after auth and preserve service-token binding", async () => {
  const { db, people } = await database();
  const authStore = createMemoryAuthStore();
  authStore.addMembership(people.member, { orgId: people.org, name: "Example", role: "member" });
  authStore.addMembership(people.member, { orgId: people.otherOrg, name: "Other", role: "admin" });
  const service = generateToken("service");
  await authStore.insertToken("service", {
    userId: people.member,
    orgId: people.org,
    label: "fixture",
    hash: await sha256Hex(service),
    createdAt: new Date().toISOString(),
  });
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
    authStore,
    listCredentialMetadata: createSqlCredentialList(sql, store),
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => Response.json({ id: people.member }),
    },
  } as unknown as ControlOptions;
  const call = async (org: string, bearer = "header.payload.signature") => {
    queries = 0;
    const response = await handleControlRequest(
      new Request("https://armada.test/api/v1/creds/list", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ org }),
      }),
      options,
    );
    if (!response) throw new Error("Expected a control response");
    return {
      status: response.status,
      body: (await response.json()) as { orgs?: { id: string }[]; error?: { code: string } },
      queries,
    };
  };
  const visible = await call(people.org);
  expect([visible.status, visible.queries, visible.body.orgs?.map((row) => row.id)]).toEqual([200, 1, [people.org]]);
  const bound = await call(people.org, service);
  expect([bound.status, bound.queries]).toEqual([200, 1]);
  const foreign = await call(people.otherOrg, service);
  expect([foreign.status, foreign.queries, foreign.body.error?.code]).toEqual([403, 0, "forbidden"]);
  await db.query("delete from members where user_id=$1 and org_id=$2", [people.member, people.org]);
  const revoked = await call(people.org);
  expect([revoked.status, revoked.queries, revoked.body.error?.code]).toEqual([404, 1, "not_found"]);
});
