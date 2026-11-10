import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { createManagedParentMcp } from "../src/mcp-managed-parent.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test.each([false, true])(
  "internal managed MCP preserves the public parent boundary (connection=%s)",
  async (connected) => {
    const { db, people: p } = await database();
    const sql: core.Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) =>
        db.transaction((tx) => work({ query: (q, v) => tx.query(q, v), transaction: async (next) => next(tx) })),
    };
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    try {
      const golden = (await sql.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
      const created = await store.create({
        ownerId: p.owner,
        key: "managed-create",
        skillRevision: "a".repeat(40),
        configuration: {
          version: 1,
          orgId: p.org,
          name: "managed",
          provider: "boat",
          harness: "claude",
          model: "fixture",
          goldenId: golden.id,
          modelAccountId: crypto.randomUUID(),
        },
      });
      const sandbox = await core.createSqlSandboxStore(sql).insert({
        id: crypto.randomUUID(),
        provider: "boat",
        providerSandboxId: "bx_managed",
        goldenId: golden.id,
        orgId: p.org,
        ownerId: p.owner,
        harness: "claude",
        model: "fixture",
        reasoningEffort: "high",
        status: "starting",
        visibility: "private",
        effectiveTtlSeconds: 3600,
      });
      await sql.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandbox.id]);
      const registry = core.createSqlMcpRegistry(sql, ENCRYPTION_KEY);
      if (connected) {
        const connection = await registry.save(p.owner, p.org, {
          name: "owned",
          scope: "personal",
          transport: "http",
          url: "https://tools.example/mcp",
          authType: "none",
        });
        await sql.query("update mcp_grants set status='connected' where connection_id=$1", [connection.id]);
        await core.createSqlMcpLaunchPort(sql, registry).bind(sandbox.id, [connection.id]);
      }
      let configurations = 0;
      const provider = {
        id: "boat",
        async get() {
          return {
            state: "ready",
            expiresAt: new Date(Date.now() + 3600_000),
            physicalGeneration: "physical-generation-not-sql",
          };
        },
        async configureMcp({ configuration }: { configuration: { revision: string; servers: object } }) {
          configurations++;
          expect(Object.keys(configuration.servers)).toHaveLength(1);
          return { revision: configuration.revision };
        },
      } as unknown as core.Provider;
      const managed = createManagedParentMcp({
        sql,
        registry,
        encryptionKey: ENCRYPTION_KEY,
        origin: "https://gateway.example",
      });
      const actor = { userId: p.owner, orgId: p.org, role: "member" as const };
      await expect(registry.sandboxConnections(p.owner, p.org, sandbox.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await managed.prepare(provider, sandbox, actor);
      expect(configurations).toBe(connected ? 1 : 0);
      await expect(
        managed.prepare(provider, sandbox, { ...actor, userId: p.admin, role: "admin" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      created.identity = await store.preparing(created);
      expect(await store.complete(created, { state: "succeeded", parentState: "ready" })).toBe(true);
      await expect(managed.beforePrompt(provider, "bx_managed", actor)).rejects.toMatchObject({ code: "forbidden" });
      const message = await store.reserve({
        ownerId: p.owner,
        orgId: p.org,
        id: created.identity.id,
        action: "message",
        key: "message",
        expectedRevision: created.operation.revision,
        payload: { expectedRevision: created.operation.revision, text: "hello" },
      });
      expect(await managed.beforePrompt(provider, "bx_managed", actor)).toBe(sandbox.id);
      expect(await store.complete(message, { state: "succeeded" })).toBe(true);
      await expect(registry.sandboxConnections(p.owner, p.org, sandbox.id)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await db.close();
    }
  },
);
