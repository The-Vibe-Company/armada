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
  const preferred = (
    await db.query<{ id: string }>(
      "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
      [people.owner],
    )
  ).rows[0]!;
  await db.query(
    "insert into agent_defaults(user_id,harness,credential_id,model) values($1,'claude',$2,'claude-sonnet-5-5')",
    [people.owner, preferred.id],
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
  expect(canonical.defaults).toEqual([{ harness: "claude", credentialId: preferred.id, model: "claude-sonnet-5-5" }]);
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
  expect(multiple.defaults).toEqual([]);
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
  await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2)", [
    people.owner,
    await encryptSecret("private_placeholder", ENCRYPTION_KEY),
  ]);
  const month = (
    await db.query<{ period: string }>(
      `with month as (select date_trunc('month', statement_timestamp() at time zone 'UTC') as start),
       seeded as (
         insert into account_spend(account_id,period_start,usd,unpriced_turns)
         select c.id, m.start::date, 312.125, 2 from credentials c cross join month m where c.kind='openai'
         union all
         select c.id, (m.start - interval '1 month')::date, 900, 6
         from credentials c cross join month m where c.kind='openai'
       )
       select to_char(start, 'YYYY-MM-DD') as period from month`,
    )
  ).rows[0]!.period;
  const reset = (
    await db.query<{ resets_at: string }>(
      `insert into account_exhaustion(account_id,account_version,code,resets_at,event_at)
       select id,version,'usage_limit_exceeded',statement_timestamp()+interval '1 hour',1
       from credentials where kind='openai'
       returning resets_at::text`,
    )
  ).rows[0]!.resets_at;
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
      body: (await response.json()) as {
        user?: unknown[];
        orgs?: { id: string; credentials: { kind: string; monthlySpend?: unknown; exhaustedUntil?: string }[] }[];
        error?: { code: string };
      },
      queries,
    };
  };
  const visible = await call(people.org);
  expect([visible.status, visible.queries, visible.body.orgs?.map((row) => row.id)]).toEqual([200, 1, [people.org]]);
  expect(visible.body.user).toEqual([]);
  const credentials = visible.body.orgs?.[0]?.credentials;
  expect(credentials?.find((row) => row.kind === "openai")?.exhaustedUntil).toBe(new Date(reset).toISOString());
  expect(credentials?.find((row) => row.kind === "openai")?.monthlySpend).toEqual({
    periodStart: month,
    usd: "312.125",
    unpricedTurns: 2,
  });
  expect(credentials?.find((row) => row.kind === "claude_oauth")?.monthlySpend).toBeUndefined();
  const bound = await call(people.org, service);
  expect([bound.status, bound.queries]).toEqual([200, 1]);
  const exhaustedUntil = async () =>
    (await call(people.org)).body.orgs?.[0]?.credentials.find((row) => row.kind === "openai")?.exhaustedUntil;
  await db.query(
    "update account_exhaustion set account_version=account_version-1 where account_id in (select id from credentials where kind='openai')",
  );
  expect(await exhaustedUntil()).toBeUndefined();
  await db.query(
    "update account_exhaustion set account_version=account_version+1, resets_at=statement_timestamp() where account_id in (select id from credentials where kind='openai')",
  );
  expect(await exhaustedUntil()).toBeUndefined();
  const foreign = await call(people.otherOrg, service);
  expect([foreign.status, foreign.queries, foreign.body.error?.code]).toEqual([403, 0, "forbidden"]);
  await db.query("delete from members where user_id=$1 and org_id=$2", [people.member, people.org]);
  const revoked = await call(people.org);
  expect([revoked.status, revoked.queries, revoked.body.error?.code]).toEqual([404, 1, "not_found"]);
});

test("account retry flag aggregates only live unexpired turns on that account", async () => {
  const { db, people } = await database();
  const account = (
    await db.query<{ id: string }>(
      "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
      [people.owner],
    )
  ).rows[0]!;
  const golden = (await db.query<{ id: string }>("select id from goldens where org_id=$1 limit 1", [people.org]))
    .rows[0]!;
  const sandbox = (
    await db.query<{ id: string }>(
      "insert into sandboxes(boat_id,golden_id,org_id,owner_id,harness,status,credential_id) values('retry_placeholder',$1,$2,$3,'claude','running',$4) returning id",
      [golden.id, people.org, people.owner, account.id],
    )
  ).rows[0]!;
  await db.query(
    "insert into sandbox_turn_models(sandbox_id,prompt_id,rate_limit_retry_at) values($1,'retry_prompt',now()+interval '1 minute')",
    [sandbox.id],
  );
  const list = createSqlCredentialList(db, createSqlVaultStore(db));
  const flag = async () =>
    (await list(people.owner, people.org)).user.find((row) => row.id === account.id)?.rateLimited;
  expect(await flag()).toBe(true);
  await db.query("update sandbox_turn_models set rate_limit_retry_at=now()-interval '1 second' where sandbox_id=$1", [
    sandbox.id,
  ]);
  expect(await flag()).toBeUndefined();
  await db.query("update sandbox_turn_models set rate_limit_retry_at=now()+interval '1 minute' where sandbox_id=$1", [
    sandbox.id,
  ]);
  await db.query("update sandboxes set status='stopped', stopped_at=now() where id=$1", [sandbox.id]);
  expect(await flag()).toBeUndefined();
});
