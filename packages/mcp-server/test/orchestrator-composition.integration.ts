// Explicit exact673 + actual663 candidate209 + owned662 combination. No native proof.
import { expect, test } from "bun:test";
import type { Provider, Sql } from "@armada/core/server";
import * as foundation from "@armada/core/server";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { createOrchestratorServices, type OrchestratorLifecyclePorts } from "../src/orchestrator-composition.ts";
import type { OrchestratorRuntimeFoundation } from "../src/orchestrator-runtime-foundation.ts";
import { database } from "./support.ts";

async function fixture() {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const settingsPath = "../src/" + "orchestrator-lifecycle-settings.ts";
  const activityPath = "../src/" + "orchestrator-activity.ts";
  const workerPath = "../src/" + "orchestrator-lifecycle.ts";
  const detailPath = "../src/" + "orchestrator-lifecycle-integration.ts";
  const settings = await import(settingsPath),
    activity = await import(activityPath),
    worker = await import(workerPath),
    projection = await import(detailPath);
  const clock = new Date(Date.now() + 10_000);
  const lifecycle: OrchestratorLifecyclePorts = {
    ownerCompletion: (sql, reserve) => {
      const actual = new projection.LifecycleRuntimeStore(sql, reserve);
      return actual.complete.bind(actual);
    },
    configure: settings.configureOrchestratorLifecycle,
    recordActivity: activity.recordOrchestratorActivity,
    detail: projection.lifecycleDetail,
    worker: (sql, runtime) => worker.createOrchestratorLifecycle(sql, runtime, () => clock),
  };
  const reserve = Reflect.get(
    foundation,
    "reserveOrchestratorOperation",
  ) as OrchestratorRuntimeFoundation["reserveOperation"];
  const Authority = Reflect.get(foundation, "OrchestratorAuthority") as new (
    sql: Sql,
    auth: () => Promise<void>,
  ) => OrchestratorRuntimeFoundation["authority"];
  if (typeof reserve !== "function" || typeof Authority !== "function") throw Error("Actual673 required.");
  const authority = new Authority(sql, async () => {
    throw Error("No credential lookup expected.");
  });
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const configuration = {
    version: 1 as const,
    orgId: p.org,
    name: "actual composition",
    goldenId: golden.id,
    provider: "boat" as const,
    harness: "claude" as const,
    model: "fixture",
    modelAccountId: crypto.randomUUID(),
    idleSeconds: 900,
  };
  const provider = { id: "boat" } as unknown as Provider;
  const options = {
    authority,
    skillRevision: "a".repeat(40),
    resolveBackend: async () => ({
      provider,
      projectDir: "/home/user/project",
      mcpUrl: "https://armada.invalid/mcp",
      consent: { scopes: [], goldenIds: [golden.id], credentialIds: [configuration.modelAccountId] },
      assertNativeProof: async () => {},
      revalidate: async () => {},
      launch: async () => {
        throw Error("Synthetic allocation transport failure.");
      },
    }),
    managed: {
      sql,
      resolveManaged: async () => ({
        provider,
        mcpUrl: "https://armada.invalid/mcp",
        observe: async (
          machine: Parameters<
            NonNullable<ReturnType<typeof createOrchestratorServices>["runtime"]["lifecycleRuntime"]>["observe"]
          >[0],
        ) => ({
          ...machine,
          physicalGeneration: machine.physicalGeneration ?? null,
          state: "active" as const,
          evidence: "native:active:1",
        }),
        checkpointAndStop: async () => {
          throw Error("No stop expected.");
        },
        readStopReceipt: async () => null,
      }),
    },
  };
  const caller = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" as const }], via: "supabase" as const };
  return { db, p, sql, lifecycle, options, reserve, configuration, caller };
}

test("actual owner create configures209 before reserving208 receipt, without stranding the operation revision", async () => {
  const f = await fixture();
  const services = createOrchestratorServices({
    sql: f.sql,
    reserveOperation: f.reserve,
    options: f.options,
    lifecycle: f.lifecycle,
  });
  try {
    const result = (await callOrchestrator(services.runtime, f.caller, "create", f.configuration, "create-key")) as {
      id: string;
      orchestratorId: string;
      state: string;
      revision: number;
    };
    expect(result.state).toBe("uncertain");
    expect(result.revision).toBe(2);
    const row = (
      await f.db.query<{ revision: string | number; idle_seconds: number; max_active_children: number | null }>(
        "select o.revision,l.idle_seconds,l.max_active_children from orchestrators o join orchestrator_lifecycle l on l.orchestrator_id=o.id where o.id=$1",
        [result.orchestratorId],
      )
    ).rows[0];
    expect(Number(row?.revision)).toBe(result.revision);
    expect(row?.idle_seconds).toBe(900);
    expect(row?.max_active_children).toBeNull();
    const replay = (await callOrchestrator(services.runtime, f.caller, "create", f.configuration, "create-key")) as {
      id: string;
      revision: number;
    };
    expect(replay.id).toBe(result.id);
    expect(replay.revision).toBe(2);
  } finally {
    await services.lifecycle.drain();
    await f.db.close();
  }
});

test("actual native activity and cursor ACK commit together; replay is not activity and actual detail/worker are bound", async () => {
  const f = await fixture();
  let fail = true;
  const services = createOrchestratorServices({
    sql: f.sql,
    reserveOperation: f.reserve,
    options: f.options,
    lifecycle: {
      ...f.lifecycle,
      recordActivity: async (...args) => {
        const accepted = await f.lifecycle.recordActivity(...args);
        if (fail) throw Error("Activity transaction failure.");
        return accepted;
      },
    },
  });
  try {
    const created = await services.store.create({
      ownerId: f.p.owner,
      configuration: f.configuration,
      key: "create",
      skillRevision: f.options.skillRevision,
    });
    const sandbox = await foundation.createSqlSandboxStore(f.sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: crypto.randomUUID(),
      goldenId: f.configuration.goldenId,
      orgId: f.p.org,
      ownerId: f.p.owner,
      harness: "claude",
      model: "fixture",
      reasoningEffort: "high",
      status: "running",
      visibility: "private",
      effectiveTtlSeconds: 7200,
    });
    await f.db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandbox.id]);
    created.identity = await services.store.preparing(created);
    await services.store.complete(created, { state: "succeeded", conversationId: "native-conversation" });
    const identity = await services.store.read(f.p.owner, f.p.org, created.identity.id);
    const event = {
      id: "native-event",
      at: 1,
      promptId: "native-prompt",
      conversationId: "native-conversation",
      kind: "message" as const,
      text: "native work",
      partial: false,
      tools: [],
    };
    await expect(
      services.store.appendEvents(identity, { events: [event], cursor: "native-cursor" }, null),
    ).rejects.toThrow("Activity transaction failure");
    expect((await f.db.query("select event_id from orchestrator_activity")).rows).toHaveLength(0);
    expect(
      (await f.db.query("select sequence from orchestrator_runtime_events where upstream_id='native-event'")).rows,
    ).toHaveLength(0);
    expect(await services.store.providerCursor(identity)).toBeNull();
    fail = false;
    expect(await services.store.appendEvents(identity, { events: [event], cursor: "native-cursor" }, null)).toBe(true);
    const at = (
      await f.db.query<{ at: string }>(
        "select last_activity_at::text as at from orchestrator_lifecycle where orchestrator_id=$1",
        [identity.id],
      )
    ).rows[0]?.at;
    expect((await f.db.query("select event_id from orchestrator_activity")).rows).toHaveLength(1);
    expect(
      await services.store.appendEvents(identity, { events: [event], cursor: "native-cursor" }, "native-cursor"),
    ).toBe(true);
    expect(
      (
        await f.db.query<{ at: string }>(
          "select last_activity_at::text as at from orchestrator_lifecycle where orchestrator_id=$1",
          [identity.id],
        )
      ).rows[0]?.at,
    ).toBe(at);
    const detail = await services.runtime.detail(f.caller, f.p.org, identity.id);
    expect(detail.version).toBe(1);
    expect(detail.orchestrator.id).toBe(identity.id);
    expect(detail.waits).toEqual([]);
    expect(await services.lifecycle.reconcileOne()).toBe(true);
    expect(
      (
        await f.db.query<{ state: string }>(
          "select observation_state as state from orchestrator_lifecycle where orchestrator_id=$1",
          [identity.id],
        )
      ).rows[0]?.state,
    ).toBe("active");
  } finally {
    await services.lifecycle.drain();
    await f.db.close();
  }
});

test("an accepted owner turn refreshes actual209 activity without polling provider events", async () => {
  const f = await fixture();
  const provider = {
    id: "boat",
    get: async () => ({ state: "ready" }),
    prompt: async () => ({ promptId: "owner-turn", conversationId: "native-conversation", status: "finished" }),
    events: async () => {
      throw Error("No provider event poll expected.");
    },
  } as unknown as Provider;
  const options = { ...f.options, resolveBackend: async () => ({ ...(await f.options.resolveBackend()), provider }) };
  const services = createOrchestratorServices({
    sql: f.sql,
    reserveOperation: f.reserve,
    options,
    lifecycle: f.lifecycle,
  });
  try {
    const created = await services.store.create({
      ownerId: f.p.owner,
      configuration: f.configuration,
      key: "create",
      skillRevision: f.options.skillRevision,
    });
    const sandbox = await foundation.createSqlSandboxStore(f.sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: crypto.randomUUID(),
      goldenId: f.configuration.goldenId,
      orgId: f.p.org,
      ownerId: f.p.owner,
      harness: "claude",
      model: "fixture",
      reasoningEffort: "high",
      status: "running",
      visibility: "private",
    });
    await f.db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandbox.id]);
    created.identity = await services.store.preparing(created);
    await services.store.complete(created, { state: "succeeded", conversationId: "native-conversation" });
    await f.db.query(
      "update orchestrator_lifecycle set last_activity_at=clock_timestamp()-interval '3 hours',observation_state='quiescent' where orchestrator_id=$1",
      [created.identity.id],
    );
    const result = await services.runtime.mutate(f.caller, {
      orgId: f.p.org,
      id: created.identity.id,
      action: "message",
      text: "new owner work",
      key: "owner-turn",
      expectedRevision: created.operation.revision,
    });
    expect(result.state).toBe("succeeded");
    const row = (
      await f.db.query<{ state: string; recent: boolean }>(
        "select observation_state as state,last_activity_at>clock_timestamp()-interval '1 minute' as recent from orchestrator_lifecycle where orchestrator_id=$1",
        [created.identity.id],
      )
    ).rows[0];
    expect(row?.state).toBe("unknown");
    expect(row?.recent).toBe(true);
    const detail = await services.runtime.detail(f.caller, f.p.org, created.identity.id);
    expect(detail.orchestrator.idleDeadline).toBeNull();
  } finally {
    await services.lifecycle.drain();
    await f.db.close();
  }
});
