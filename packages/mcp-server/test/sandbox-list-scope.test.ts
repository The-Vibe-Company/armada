import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, resolveOrg, type Sql } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createScopedSandboxData, createSqlData } from "../src/data.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
async function fixture() {
  const { db, people } = await database();
  const caller: Caller = {
    userId: people.member,
    via: "supabase",
    orgs: [
      { orgId: people.org, role: "member" },
      { orgId: people.otherOrg, role: "admin" },
    ],
  };
  // Descending UUIDs preserve insertion order even when database timestamps tie.
  const ids = [
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ] as const;

  for (let index = 0; index < 3; index++) {
    const orgId = index === 2 ? people.otherOrg : people.org;
    const golden = (
      await db.query<{ id: string }>("select id from goldens where name=$1", [
        index === 0 ? "mine" : index === 1 ? "shared" : "elsewhere",
      ])
    ).rows[0]!.id;
    const ownerId = index === 0 ? people.owner : people.member;
    const source = createSqlData(db)({ ...caller, userId: ownerId, orgs: [{ orgId, role: "member" }] });
    await source.sandboxes.insert({
      id: ids[index]!,
      goldenId: golden,
      orgId,
      ownerId: index === 0 ? people.owner : people.member,
      provider: "boat",
      providerSandboxId: `bx_list_${index}`,
      harness: index === 0 ? "claude" : "codex",
      status: "running",
      model: index === 0 ? "claude-sonnet-4-6" : "gpt-5.4",
      reasoningEffort: "high",
    });
  }
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
  const options = {
    authStore,
    store: createSqlVaultStore(sql),
    data: createSqlData(sql),
    scopedSandboxData: createScopedSandboxData(sql, createSqlVaultStore(sql)),
    providers: {
      resolve: async () => {
        throw new Error("list must not call a provider");
      },
    },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => Response.json({ id: people.member }),
    },
  } as unknown as ControlOptions;
  const call = async (body: Record<string, unknown>, bearer = "header.payload.signature") => {
    queries = 0;
    const response = await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/list", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      options,
    );
    if (!response) throw new Error("Expected a control response");
    const responseBody = (await response.json()) as {
      total: number;
      hasMore: boolean;
      sandboxes: ({ id: string } & Record<string, unknown>)[];
      error?: { code: string };
    };
    return { status: response.status, body: responseBody, queries };
  };
  return { db, people, ids, call, service, authStore };
}

test("UUID sandbox pages use one statement and retain totals, filters and private-source metadata boundaries", async () => {
  const { people, ids, call, authStore } = await fixture();
  const page = await call({ org: people.org, limit: 1, page: 2 });
  expect([page.status, page.queries, page.body.total, page.body.hasMore]).toEqual([200, 1, 2, false]);
  expect(page.body.sandboxes.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
  expect(page.body.sandboxes[0]).toMatchObject({ canOpen: false, usage: null, taskOutcome: null });
  expect(page.body.sandboxes[0]).not.toHaveProperty("scope_member");
  const mine = await call({ org: people.org, owner: "me", harness: "codex" });
  expect([mine.status, mine.queries, mine.body.total]).toEqual([200, 1, 1]);
  expect(mine.body.sandboxes.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
  const unscoped = await call({});
  expect([unscoped.status, unscoped.queries, unscoped.body.total]).toEqual([200, 1, 3]);
  const originalMemberships = authStore.memberships;
  authStore.memberships = async () => [{ orgId: people.org, name: "Example", role: "member" }];
  try {
    const outsideSnapshot = await call({ org: people.otherOrg });
    expect([outsideSnapshot.status, outsideSnapshot.queries, outsideSnapshot.body.total]).toEqual([200, 1, 0]);
  } finally {
    authStore.memberships = originalMemberships;
  }
  const named = await call({ org: "Example" });
  expect([named.status, named.queries, named.body.total]).toEqual([200, 1, 2]);
});

test("scope guard distinguishes empty pages from revoked membership and retains service binding and invalid-input precedence", async () => {
  const { db, people, call, service } = await fixture();
  const empty = await call({ org: people.org, page: 20, limit: 1 });
  expect([empty.status, empty.queries, empty.body.total, empty.body.sandboxes]).toEqual([200, 1, 2, []]);
  const noMatches = await call({ org: people.org, status: ["deleted"] });
  expect([noMatches.status, noMatches.queries, noMatches.body.total, noMatches.body.sandboxes]).toEqual([
    200,
    1,
    0,
    [],
  ]);
  const foreign = await call({ org: people.otherOrg }, service);
  expect([foreign.status, foreign.queries]).toEqual([403, 0]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.member]);
  const revoked = await call({ org: people.org });
  expect([revoked.status, revoked.queries, revoked.body.error?.code]).toEqual([404, 1, "not_found"]);
  const invalid = await call({ org: people.org, limit: 0 });
  expect([invalid.status, invalid.queries, invalid.body.error?.code]).toEqual([404, 1, "not_found"]);
});

test("named and empty selections use one query with exact core normalization and per-org pagination", async () => {
  const { db, people, ids, call, authStore } = await fixture();
  const other = await call({ org: "Other", limit: 1 });
  expect([other.status, other.queries, other.body.total]).toEqual([200, 1, 1]);
  expect(other.body.sandboxes.map((row) => row.id)).toEqual([ids[2]]);
  const original = authStore.memberships;
  authStore.memberships = async () => [{ orgId: people.org, name: "Example", role: "member" }];
  try {
    const frozen = await call({ org: "Other" });
    expect([frozen.status, frozen.queries, frozen.body.total]).toEqual([200, 1, 0]);
  } finally {
    authStore.memberships = original;
  }
  await db.query("update orgs set name=$2 where id=$1", [people.org, "\t\vExAmPle\f\r"]);
  const ascii = await call({ org: "example", limit: 1, page: 2 });
  expect([ascii.status, ascii.queries, ascii.body.total]).toEqual([200, 1, 2]);
  expect(ascii.body.sandboxes.map((row) => row.id)).toEqual([ids[0]]);
  // JavaScript lowercases the final sigma contextually; database lower() need not agree.
  await db.query("update orgs set name=$2 where id=$1", [people.org, "\u00a0ΟΣ\u2007"]);
  await db.query("update orgs set name=$2 where id=$1", [people.otherOrg, "Άλλο"]);
  const unicode = await call({ org: "ος", limit: 1, page: 2 });
  expect([unicode.status, unicode.queries, unicode.body.total]).toEqual([200, 1, 2]);
  expect(unicode.body.sandboxes.map((row) => row.id)).toEqual([ids[0]]);
  for (const field of ["selection_id", "selection_name", "selection_role"])
    expect(unicode.body.sandboxes[0]).not.toHaveProperty(field);
  const noRows = await call({ org: "ος", status: ["deleted"] });
  expect([noRows.status, noRows.queries, noRows.body.total, noRows.body.sandboxes]).toEqual([200, 1, 0, []]);
  const beyond = await call({ org: "ος", limit: 1, page: 20 });
  expect([beyond.status, beyond.queries, beyond.body.total, beyond.body.sandboxes]).toEqual([200, 1, 2, []]);
  await db.query("update orgs set name=$2 where id=$1", [people.otherOrg, "ΟΣ"]);
  const expected = await resolveOrg(createSqlVaultStore(db), people.member, "ος");
  const duplicate = await call({ org: "ος", limit: 1 });
  expect([duplicate.status, duplicate.queries, duplicate.body.total]).toEqual([
    200,
    1,
    expected.id === people.org ? 2 : 1,
  ]);
  expect(duplicate.body.sandboxes[0]?.orgId).toBe(expected.id);
  const ambiguous = await call({ org: "" });
  expect([ambiguous.status, ambiguous.queries, ambiguous.body.error?.code]).toEqual([400, 1, "invalid"]);
  const missing = await call({ org: "unknown_org" });
  expect([missing.status, missing.queries, missing.body.error?.code]).toEqual([404, 1, "not_found"]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [people.otherOrg, people.admin]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.otherOrg, people.member]);
  const only = await call({ org: "", limit: 1, page: 2 });
  expect([only.status, only.queries, only.body.total]).toEqual([200, 1, 2]);
  expect(only.body.sandboxes.map((row) => row.id)).toEqual([ids[0]]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.member]);
  const revoked = await call({ org: "ος" });
  expect([revoked.status, revoked.queries, revoked.body.error?.code]).toEqual([404, 1, "not_found"]);
});

test("counting and pagination do not decode usage metadata outside the returned page", async () => {
  const { db, people, ids, call } = await fixture();
  await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.member]);
  // An older malformed usage record must not break an unrelated page, but it still counts.
  await db.query("update sandboxes set usage_turns=$2::jsonb where id=$1", [
    ids[0],
    JSON.stringify({ turnCount: "unreadable_counter", turns: [] }),
  ]);
  const selected = await call({ org: people.org, limit: 1 });
  expect([selected.status, selected.queries, selected.body.total]).toEqual([200, 1, 2]);
  expect(selected.body.sandboxes.map((row) => row.id)).toEqual([ids[1]]);
  const allOrgs = await call({ limit: 1 });
  expect([allOrgs.status, allOrgs.queries, allOrgs.body.total]).toEqual([200, 1, 3]);
  expect(allOrgs.body.sandboxes.map((row) => row.id)).toEqual([ids[2]]);
});
