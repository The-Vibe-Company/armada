// Run explicitly in the reviewed dependency combination, never substitute fake SQL.
import { expect, test } from "bun:test";
import type { OrchestratorCreate } from "@armada/core";
import type { Sql } from "@armada/core/server";
import * as foundation from "@armada/core/server";
import type { OrchestratorRuntimeFoundation } from "../src/orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database } from "./support.ts";

const reserveOrchestratorOperation: OrchestratorRuntimeFoundation["reserveOperation"] = (() => {
  if (!("reserveOrchestratorOperation" in foundation) || typeof foundation.reserveOrchestratorOperation !== "function")
    throw new Error("Run this integration file explicitly in the actual #661 dependency checkout.");
  return foundation.reserveOrchestratorOperation as OrchestratorRuntimeFoundation["reserveOperation"];
})();

const revision = "78884de87066851b75e09cbda134606c0a8bc6d7";

test("runtime receipts serialize retries, block uncertain replay, fence completion and keep owner cursor scope", async () => {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const store = new OrchestratorRuntimeStore(sql, reserveOrchestratorOperation);
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing fixture golden");
    const configuration: OrchestratorCreate = {
      version: 1,
      orgId: p.org,
      name: "coordinator",
      goldenId: golden.id,
      provider: "boat",
      harness: "claude",
      model: "native-model",
      modelAccountId: crypto.randomUUID(),
    };
    const first = await store.create({ ownerId: p.owner, configuration, key: "create-key", skillRevision: revision });
    expect(first.fresh).toBe(true);
    const retry = await store.create({ ownerId: p.owner, configuration, key: "create-key", skillRevision: revision });
    expect(retry.fresh).toBe(false);
    expect(retry.operation.id).toBe(first.operation.id);
    expect((await db.query("select id from orchestrators")).rows).toHaveLength(1);
    await expect(
      store.create({
        ownerId: p.owner,
        configuration: { ...configuration, name: "different" },
        key: "create-key",
        skillRevision: revision,
      }),
    ).rejects.toThrow("conflict");
    await expect(store.read(p.admin, p.org, first.identity.id)).rejects.toThrow("not_found");
    await expect(
      store.reserve({
        ownerId: p.owner,
        orgId: p.org,
        id: first.identity.id,
        action: "message",
        key: "message",
        expectedRevision: 1,
        payload: { text: "hello" },
      }),
    ).rejects.toThrow("conflict");
    expect(await store.complete(first, { state: "succeeded", parentState: "ready" })).toBe(true);
    const operation = await store.reserve({
      ownerId: p.owner,
      orgId: p.org,
      id: first.identity.id,
      action: "message",
      key: "message",
      expectedRevision: 1,
      payload: { text: "hello" },
    });
    expect(operation.fresh).toBe(true);
    expect(await store.complete(operation, { state: "uncertain", errorCode: "runtime_uncertain" })).toBe(true);
    const repeated = await store.reserve({
      ownerId: p.owner,
      orgId: p.org,
      id: first.identity.id,
      action: "message",
      key: "message",
      expectedRevision: 1,
      payload: { text: "hello" },
    });
    expect(repeated.fresh).toBe(false);
    expect(repeated.operation.state).toBe("uncertain");
    const page = await store.events(p.owner, p.org, first.identity.id);
    expect(page.events).toHaveLength(2);
    if (!page.cursor) throw Error("missing retained-event cursor");
    const other = await store.create({
      ownerId: p.owner,
      configuration: { ...configuration, name: "other" },
      key: "other",
      skillRevision: revision,
    });
    await expect(store.events(p.owner, p.org, other.identity.id, page.cursor)).rejects.toThrow("invalid_request");
    const uncertain = await store.create({
      ownerId: p.owner,
      configuration,
      key: "uncertain-create",
      skillRevision: revision,
    });
    expect(await store.complete(uncertain, { state: "uncertain", errorCode: "runtime_uncertain" })).toBe(true);
    const replayed = await store.create({
      ownerId: p.owner,
      configuration,
      key: "uncertain-create",
      skillRevision: revision,
    });
    expect(replayed.operation.errorCode).toBe("runtime_uncertain");
    expect(replayed.operation.state).toBe("uncertain");
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect(await store.complete(other, { state: "succeeded" })).toBe(false);
    await expect(store.events(p.owner, p.org, first.identity.id, page.cursor)).rejects.toThrow("not_found");
  } finally {
    await db.close();
  }
});

test("generation replacement cannot publish native history or an old operation receipt", async () => {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const store = new OrchestratorRuntimeStore(sql, reserveOrchestratorOperation);
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const configuration: OrchestratorCreate = {
      version: 1,
      orgId: p.org,
      name: "generation",
      goldenId: golden.id,
      provider: "boat",
      harness: "claude",
      model: "m",
      modelAccountId: crypto.randomUUID(),
    };
    const created = await store.create({ ownerId: p.owner, configuration, key: "create", skillRevision: revision });
    const sandboxId = crypto.randomUUID();
    await foundation.createSqlSandboxStore(sql).insert({
      id: sandboxId,
      provider: "boat",
      providerSandboxId: "native-generation",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "claude",
      model: "m",
      reasoningEffort: "high",
      status: "running",
      visibility: "private",
    });
    await db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandboxId]);
    created.identity = await store.preparing(created);
    expect(await store.complete(created, { state: "succeeded", conversationId: "native-session" })).toBe(true);
    const message = await store.reserve({
      ownerId: p.owner,
      orgId: p.org,
      id: created.identity.id,
      action: "message",
      key: "message",
      expectedRevision: 1,
      payload: { text: "continue" },
    });
    const event = {
      id: "native-event",
      at: 1,
      conversationId: "native-session",
      kind: "message" as const,
      text: "durable",
      partial: false,
      tools: [],
    };
    expect(await store.appendEvents(message.identity, { events: [event], cursor: "provider-1" }, null)).toBe(true);
    expect(await store.appendEvents(message.identity, { events: [event], cursor: "provider-1" }, null)).toBe(false);
    expect((await store.events(p.owner, p.org, created.identity.id)).events).toHaveLength(2);
    await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [sandboxId]);
    expect(await store.complete(message, { state: "succeeded", conversationId: "native-session" })).toBe(false);
    expect(
      await store.appendEvents(
        message.identity,
        { events: [{ ...event, id: "late", text: "stale" }], cursor: "provider-2" },
        "provider-1",
      ),
    ).toBe(false);
    expect(
      (
        await db.query<{ state: string }>("select state from orchestrator_operations where id=$1", [
          message.operation.id,
        ])
      ).rows[0]?.state,
    ).toBe("pending");
    expect((await store.events(p.owner, p.org, created.identity.id)).events).toHaveLength(2);
  } finally {
    await db.close();
  }
});
