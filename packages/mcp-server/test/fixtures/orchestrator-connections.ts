import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createSqlMcpRegistry, type OrchestratorDetail, type Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";

/** PGlite has one connection: provider metadata reads made during native
 * configuration must reuse that connection, rather than await their own open
 * transaction. Background requests still queue independently. No policies or
 * query results are replaced. */
export function fixtureSql(db: PGlite): Sql {
  const current = new AsyncLocalStorage<Sql>();
  const sql: Sql = {
    query: (q, values) => current.getStore()?.query(q, values) ?? db.query(q, values),
    transaction: async (work) => {
      const active = current.getStore();
      if (active) return work(active);
      return db.transaction((tx) => {
        const scoped: Sql = { query: (q, values) => tx.query(q, values), transaction: async (next) => next(scoped) };
        return current.run(scoped, () => work(scoped));
      });
    },
  };
  return sql;
}

/** Infrastructure setup: stand in for an already-completed upstream MCP login. */
export async function connectionFixture(sql: Sql, key: string, ownerId: string, orgId: string) {
  const registry = createSqlMcpRegistry(sql, key);
  const other = crypto.randomUUID();
  await sql.query("insert into auth.users(id) values($1)", [other]);
  await sql.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [orgId, other]);
  const make = async (user: string, name: string) => {
    const connection = await registry.save(user, orgId, {
      name,
      scope: "personal",
      transport: "http",
      url: "https://tools.example/mcp",
      authType: "bearer",
      authentication: JSON.stringify({ token: "synthetic-upstream-connection-secret" }),
    });
    await sql.query("update public.mcp_grants set status='connected' where connection_id=$1", [connection.id]);
    await registry.metadata(user, orgId, connection.id, { defaultForLaunch: false });
    return { id: connection.id, name };
  };
  return {
    first: await make(ownerId, "First tools"),
    second: await make(ownerId, "Second tools"),
    forbidden: await make(other, "Other member's tools"),
  };
}

/** Primary owner: actual serve auth/routes/runtime/registry/lifecycle/native
 * configuration composition. Provider fixtures only supply external I/O. */
export async function exerciseConnections(input: {
  request(path: string, body?: object, key?: string): Promise<{ status: number; value: any }>;
  detail: OrchestratorDetail;
  selected: Awaited<ReturnType<typeof connectionFixture>>;
  running(value: boolean): void;
  expectServers(ids: string[]): void;
  sawPrompt(ids: string[]): void;
}) {
  const { first, second, forbidden } = input.selected;
  const id = input.detail.orchestrator.id;
  const orgId = input.detail.orchestrator.configuration.orgId;
  const root = `/api/v1/orchestrators/${id}`;
  let revision = input.detail.orchestrator.revision;
  assert.deepEqual(input.detail.connections, [first]);
  const request = input.request;
  const read = () => request(`${root}/connections?orgId=${orgId}`);
  assert.deepEqual((await read()).value, { version: 1, connections: [first] });
  const change = async (action: string, connections: string[], key: string, expectedRevision = revision) =>
    request(`${root}/connections/${action}`, { orgId, connections, expectedRevision }, key);
  const send = async (key: string) => {
    const result = await request(
      `${root}/message`,
      { orgId, expectedRevision: revision, text: "Inspect the connected tools" },
      key,
    );
    assert.equal(result.status, 202, JSON.stringify(result));
    assert.equal(result.value.state, "succeeded", JSON.stringify(result));
    revision = result.value.revision;
  };
  input.expectServers([first.id]);
  await send("connections-first-turn");
  input.sawPrompt([first.id]);
  const conversation = (await request(`${root}?orgId=${orgId}`)).value.orchestrator.conversationId;
  input.running(true);
  const busy = await change("add", [second.id], "connections-running");
  assert.equal(busy.status, 409, JSON.stringify(busy));
  assert.equal(busy.value.error.code, "conflict");
  input.running(false);
  assert.deepEqual((await read()).value.connections, [first]);
  const denied = await change("add", [forbidden.id], "connections-forbidden");
  assert.equal(denied.status, 404, JSON.stringify(denied));
  assert.deepEqual((await read()).value.connections, [first]);
  const originalRevision = revision;
  const added = await change("add", [second.id], "connections-add");
  assert.equal(added.status, 202, JSON.stringify(added));
  assert.equal(added.value.state, "succeeded");
  revision = added.value.revision;
  assert.equal(revision, originalRevision + 1, "Rejected mutations must not consume a revision");
  assert.deepEqual((await change("add", [second.id], "connections-add", originalRevision)).value, added.value);
  assert.equal((await change("add", [first.id], "connections-add", originalRevision)).status, 409);
  assert.equal((await change("remove", [first.id], "connections-stale", originalRevision)).status, 409);
  const both = [first, second].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual((await read()).value.connections, both);
  input.expectServers(both.map((c) => c.id));
  await send("connections-added-turn");
  input.sawPrompt(both.map((c) => c.id));
  const removed = await change("remove", [second.id], "connections-remove");
  assert.equal(removed.status, 202, JSON.stringify(removed));
  revision = removed.value.revision;
  input.expectServers([first.id]);
  await send("connections-removed-turn");
  input.sawPrompt([first.id]);
  const detail = (await request(`${root}?orgId=${orgId}`)).value;
  assert.deepEqual(detail.connections, [first]);
  assert.equal(detail.orchestrator.conversationId, conversation, "MCP changes must retain the conversation");
  const page = (await request(`${root}/events?orgId=${orgId}`)).value;
  const selections = page.events
    .filter((event: any) => event.kind === "connections")
    .map((event: any) => event.connections);
  assert(
    selections.some((set: any) => JSON.stringify(set) === JSON.stringify(both)),
    JSON.stringify(page),
  );
  assert.deepEqual(selections.at(-1), [first]);
  for (const set of selections)
    for (const connection of set) assert.deepEqual(Object.keys(connection).sort(), ["id", "name"]);
  assert(!JSON.stringify({ detail, page }).includes("synthetic-upstream-connection-secret"));
  assert(!JSON.stringify((await read()).value).includes("armada_orchestrator"));
  return revision;
}
