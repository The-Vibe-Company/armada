// Explicit dependency-combination runner: actual #661/#662 classes and real migrations.
// Synthetic provider/transport only. This is NOT operator-native continuity proof.
import { expect, test } from "bun:test";
import type { OrchestratorCreate, OrchestratorDetail, OrchestratorOperation } from "@armada/core";
import {
  createSqlSandboxStore,
  OrchestratorAuthority,
  reserveOrchestratorOperation,
  type Sql,
} from "@armada/core/server";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { createLifecycleAwareOrchestratorRuntime } from "../src/orchestrator-lifecycle-integration.ts";
import { database, fakeBoat } from "./support.ts";

test("actual shared runtime caller persists owner activity, and journal cursor cannot commit without activity", async () => {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const boat = fakeBoat();
    const services = createLifecycleAwareOrchestratorRuntime(sql, {
      reserveOperation: reserveOrchestratorOperation,
      authority: new OrchestratorAuthority(sql, async () => {
        throw Error("No delegated account operation in this owner activity test.");
      }),
      skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
      async resolveBackend() {
        return {
          provider: boat.provider,
          projectDir: "/workspace",
          mcpUrl: "https://armada.example.com/mcp",
          consent: { scopes: [], goldenIds: [], credentialIds: [] },
          transport: {
            async deliver() {
              throw Error("unexpected grant");
            },
            async scrub() {},
          },
          // Synthetic backend contract; production is still absent/native-proof gated.
          async assertNativeProof() {},
          async launch() {
            throw Error("unexpected launch");
          },
          async checkpointAndStop() {
            throw Error("unexpected stop");
          },
          async revalidate() {},
        };
      },
    });
    const configuration: OrchestratorCreate = {
      version: 1,
      orgId: p.org,
      name: "lifecycle",
      goldenId: golden.id,
      provider: "boat",
      harness: "codex",
      model: "m",
      modelAccountId: crypto.randomUUID(),
      idleSeconds: 900,
    };
    const created = await services.store.create({
      ownerId: p.owner,
      configuration,
      key: "create",
      skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
    });
    const native = await boat.provider.fork({ from: "synthetic-snapshot" });
    const parent = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: native.id,
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      status: "ready",
      model: "m",
      reasoningEffort: "high",
      visibility: "private",
    });
    await db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, parent.id]);
    created.identity = await services.store.preparing(created);
    expect(await services.store.complete(created, { state: "succeeded", parentState: "ready" })).toBe(true);
    const owner = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" as const }], via: "supabase" as const };
    const op = (await callOrchestrator(
      services.runtime,
      owner,
      "message",
      { orgId: p.org, id: created.identity.id, expectedRevision: 1, text: "one scoped ticket" },
      "message",
    )) as OrchestratorOperation;
    expect(op.state).toBe("succeeded");
    expect(boat.prompts).toHaveLength(1);
    const detail = (await callOrchestrator(services.runtime, owner, "detail", {
      orgId: p.org,
      id: created.identity.id,
    })) as OrchestratorDetail;
    expect(detail.waits).toEqual([]);
    expect(detail.childSandboxIds).toEqual([]);
    expect(detail.delegation).toBeNull();
    const activity = (
      await db.query<{ last_activity_at: Date }>(
        "select last_activity_at from orchestrator_lifecycle where orchestrator_id=$1",
        [created.identity.id],
      )
    ).rows[0];
    if (!activity) throw new Error("Missing persisted lifecycle activity.");
    expect(detail.orchestrator.lastActivityAt).toBe(activity.last_activity_at.toISOString());
    expect(detail.orchestrator.idleDeadline).toBeNull();
    const identity = await services.store.read(p.owner, p.org, created.identity.id);
    const page = await boat.provider.events({ sandboxId: native.id });
    expect(page.events.length).toBeGreaterThan(0);
    await db.exec(`create function reject_activity() returns trigger language plpgsql as $$ begin raise exception 'synthetic activity persistence failure'; end $$;
      create trigger reject_activity before insert on orchestrator_activity for each row execute function reject_activity()`);
    await expect(services.store.appendEvents(identity, page, null)).rejects.toThrow(
      "synthetic activity persistence failure",
    );
    expect(
      (
        await db.query<{ provider_cursor: string | null }>(
          "select provider_cursor from orchestrator_runtime where orchestrator_id=$1",
          [identity.id],
        )
      ).rows[0]?.provider_cursor,
    ).toBeNull();
    expect((await db.query("select event_id from orchestrator_activity")).rows).toHaveLength(0);
    expect(
      (await db.query("select upstream_id from orchestrator_runtime_events where upstream_id is not null")).rows,
    ).toHaveLength(0);
    await db.exec("drop trigger reject_activity on orchestrator_activity;drop function reject_activity()");
    expect(await services.store.appendEvents(identity, page, null)).toBe(true);
    expect((await db.query("select event_id from orchestrator_activity")).rows).toHaveLength(1);
    expect(await services.store.appendEvents(identity, page, null)).toBe(false);
    const usageEvent = {
      id: "usage-result",
      at: 1794311658248,
      conversationId: identity.conversationId!,
      promptId: page.events.find((event) => event.kind === "prompt")!.promptId!,
      kind: "other" as const,
      type: "armada/turnUsage",
      data: { model: "gpt-6.1-sol", inputTokens: 13136, outputTokens: 5, cachedTokens: 0 },
    };
    expect(
      await services.store.appendEvents(identity, { events: [usageEvent], cursor: "usage-page" }, page.cursor ?? null),
    ).toBe(true);
    const usageDetail = await services.runtime.detail(owner, p.org, identity.id);
    expect(usageDetail.usage?.own?.turns[0]?.inputTokens).toBe(13136);
    expect(usageDetail.usage?.children.inputTokens).toBe(0);
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "child-usage",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      status: "ready",
      model: "m",
      reasoningEffort: "high",
      visibility: "private",
    });
    await db.query(
      "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
      [child.id, identity.id, p.org, p.owner],
    );
    await db.query("update sandboxes set usage_turns=$2::jsonb where id=$1", [
      child.id,
      JSON.stringify({
        turnCount: 1,
        turns: [{ promptId: "child-turn", model: "gpt-6.1-sol", inputTokens: 10, outputTokens: 2, cachedTokens: 0 }],
      }),
    ]);
    const withChild = await services.runtime.detail(owner, p.org, identity.id);
    expect(withChild.usage?.own?.tokenTotals?.inputTokens).toBe(13136);
    expect(withChild.usage?.children.inputTokens).toBe(10);
    expect(withChild.usage?.children.reasoningTokens).toBeNull();

    await expect(
      callOrchestrator(services.runtime, { ...owner, userId: p.admin }, "detail", { orgId: p.org, id: identity.id }),
    ).rejects.toThrow("not_found");
  } finally {
    await db.close();
  }
});
