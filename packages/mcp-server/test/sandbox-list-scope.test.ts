import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, type Sql } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
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
    scopedSandboxData: (actor: Caller, org: string) => createSqlData(sql, org)(actor),
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
  expect([named.status, named.queries, named.body.total]).toEqual([200, 2, 2]);
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
