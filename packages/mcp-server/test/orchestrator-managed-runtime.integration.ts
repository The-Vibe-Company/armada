// Explicit actual673+210 combination; native backend is synthetic, never enablement proof.
import { expect, test } from "bun:test";
import type { Provider, Sql } from "@armada/core/server";
import * as foundation from "@armada/core/server";
import {
  createManagedOrchestratorRuntime,
  type ManagedMachine,
  type ManagedStopReceipt,
} from "../src/orchestrator-managed-runtime.ts";
import type { OrchestratorRuntimeFoundation } from "../src/orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database } from "./support.ts";

async function fixture() {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const reserve = Reflect.get(
    foundation,
    "reserveOrchestratorOperation",
  ) as OrchestratorRuntimeFoundation["reserveOperation"];
  const Authority = Reflect.get(foundation, "OrchestratorAuthority") as new (
    sql: Sql,
    authorize: () => Promise<void>,
  ) => OrchestratorRuntimeFoundation["authority"];
  if (typeof reserve !== "function" || typeof Authority !== "function") throw Error("Actual673 dependency required.");
  const authority = new Authority(sql, async () => {
    throw Error("Cleanup must not resolve a model credential.");
  });
  const store = new OrchestratorRuntimeStore(sql, reserve);
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const created = await store.create({
    ownerId: p.owner,
    configuration: {
      version: 1,
      orgId: p.org,
      name: "managed",
      provider: "boat",
      harness: "claude",
      goldenId: golden.id,
      model: "m",
      modelAccountId: crypto.randomUUID(),
    },
    key: "create",
    skillRevision: "a".repeat(40),
  });
  const sandbox = await foundation.createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: crypto.randomUUID(),
    goldenId: golden.id,
    ownerId: p.owner,
    orgId: p.org,
    harness: "claude",
    model: "m",
    reasoningEffort: "high",
    status: "running",
    visibility: "private",
  });
  await db.query("update orchestrators set sandbox_id=$2 where id=$1", [created.identity.id, sandbox.id]);
  created.identity = await store.preparing(created);
  await store.complete(created, { state: "succeeded", conversationId: "native-session", continuity: "native" });
  const reserveStop = () =>
    store.reserve({
      ownerId: p.owner,
      orgId: p.org,
      id: created.identity.id,
      action: "stop",
      key: "stop",
      expectedRevision: 1,
      payload: { expectedRevision: 1 },
    });
  const machine: ManagedMachine = {
    orchestratorId: created.identity.id,
    sandboxId: sandbox.id,
    providerSandboxId: sandbox.providerSandboxId,
    generation: String(created.identity.generation),
  };
  return { db, p, sql, authority, store, reserveStop, machine };
}

test("trusted removed-owner stop scrubs before checkpoint, persists dispatch, and retries only read the exact receipt", async () => {
  const f = await fixture();
  const stop = await f.reserveStop();
  const calls: string[] = [];
  let completed: ManagedStopReceipt | null = null;
  const provider = {
    id: "boat",
    get: async () => ({ physicalGeneration: "native-1", state: "running" }),
    installOrchestratorEpoch: async () => ({ acknowledged: true }),
    quiesceOrchestrator: async () => {
      calls.push("quiesce");
      return { acknowledged: true };
    },
    scrubOrchestratorEpoch: async () => {
      calls.push("scrub");
      return { acknowledged: true };
    },
  } as unknown as Provider;
  const runtime = createManagedOrchestratorRuntime({
    sql: f.sql,
    authority: f.authority,
    resolveManaged: async (_machine, selection) => {
      expect(selection.ownerId).toBe(f.p.owner);
      return {
        provider,
        mcpUrl: "https://armada.invalid/private/mcp",
        observe: async (machine) => ({ ...machine, state: "quiescent", evidence: "native:1" }),
        checkpointAndStop: async () => {
          calls.push("checkpoint");
          throw Error("lost native response");
        },
        readStopReceipt: async () => {
          calls.push("read-receipt");
          return completed;
        },
      };
    },
  });
  try {
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.p.org, f.p.owner]);
    await expect(f.store.read(f.p.owner, f.p.org, f.machine.orchestratorId)).rejects.toThrow("not_found");
    const first = await runtime.stop(f.machine, "owner_removed", stop.operation.id);
    expect(first.state).toBe("uncertain");
    expect(first.continuity).toBe("unverified");
    expect(calls).toEqual(["quiesce", "scrub", "checkpoint"]);
    const persisted = (
      await f.db.query<{ runtime_result: ManagedStopReceipt }>(
        "select runtime_result from orchestrator_operations where id=$1",
        [stop.operation.id],
      )
    ).rows[0];
    expect(persisted?.runtime_result).toEqual(first);
    const prior = JSON.stringify(persisted);
    completed = { ...f.machine, operationId: stop.operation.id, state: "stopped", continuity: "native" };
    expect(await runtime.stop(f.machine, "owner_removed", stop.operation.id)).toEqual(completed);
    expect(calls).toEqual(["quiesce", "scrub", "checkpoint", "read-receipt"]);
    const after = (
      await f.db.query<{ runtime_result: ManagedStopReceipt }>(
        "select runtime_result from orchestrator_operations where id=$1",
        [stop.operation.id],
      )
    ).rows[0];
    expect(JSON.stringify(after)).toBe(prior); // Reconcile is genuinely read-only, not another completion writer.
  } finally {
    await f.db.close();
  }
});

test("a replaced generation cannot publish a late managed native receipt", async () => {
  const f = await fixture();
  const stop = await f.reserveStop();
  const provider = {
    id: "boat",
    get: async () => ({ physicalGeneration: "native-1", state: "running" }),
    installOrchestratorEpoch: async () => ({ acknowledged: true }),
    quiesceOrchestrator: async () => ({ acknowledged: true }),
    scrubOrchestratorEpoch: async () => ({ acknowledged: true }),
  } as unknown as Provider;
  const runtime = createManagedOrchestratorRuntime({
    sql: f.sql,
    authority: f.authority,
    resolveManaged: async () => ({
      provider,
      mcpUrl: "https://armada.invalid/private/mcp",
      observe: async (machine) => ({ ...machine, state: "quiescent", evidence: "native:quiescent" }),
      checkpointAndStop: async (machine, operationId) => {
        await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [
          machine.sandboxId,
        ]);
        return { ...machine, operationId, state: "stopped", continuity: "native" };
      },
      readStopReceipt: async () => null,
    }),
  });
  try {
    await expect(runtime.stop(f.machine, "idle", stop.operation.id)).rejects.toThrow("conflict");
    const saved = (
      await f.db.query<{ runtime_result: ManagedStopReceipt }>(
        "select runtime_result from orchestrator_operations where id=$1",
        [stop.operation.id],
      )
    ).rows[0];
    expect(saved?.runtime_result.state).toBe("uncertain");
    expect(saved?.runtime_result.continuity).toBe("unverified");
  } finally {
    await f.db.close();
  }
});

test.each(["native", "unknown", "lost"] as const)(
  "owner stop never resolves model credentials and requires verified quiescence (%s)",
  async (mode) => {
    const f = await fixture();
    let checkpoints = 0;
    let physicalStopped = false;
    const provider = {
      id: "boat",
      get: async () => ({ physicalGeneration: "native-1", state: physicalStopped ? "stopped" : "running" }),
      installOrchestratorEpoch: async () => ({ acknowledged: true }),
      quiesceOrchestrator: async () => ({ acknowledged: true }),
      scrubOrchestratorEpoch: async () => ({ acknowledged: true }),
    } as unknown as Provider;
    const { OrchestratorRuntime } = await import("../src/orchestrator-runtime.ts");
    const runtime = new OrchestratorRuntime({
      store: f.store,
      authority: f.authority,
      skillRevision: "a".repeat(40),
      resolveBackend: async () => {
        throw Error("Revoked model account must not block compute cleanup.");
      },
      managed: {
        sql: f.sql,
        resolveManaged: async () => ({
          provider,
          mcpUrl: "https://armada.invalid/private/mcp",
          observe: async (machine) => ({
            ...machine,
            state: mode !== "unknown" ? "quiescent" : "unknown",
            evidence: "native:observation",
          }),
          checkpointAndStop: async (machine, operationId) => {
            checkpoints++;
            physicalStopped = true;
            return { ...machine, operationId, state: "stopped", continuity: mode === "lost" ? "lost" : "native" };
          },
          readStopReceipt: async () => null,
        }),
      },
    });
    try {
      const result = await runtime.mutate(
        { userId: f.p.owner, orgs: [{ orgId: f.p.org, role: "member" }], via: "supabase" },
        { orgId: f.p.org, id: f.machine.orchestratorId, action: "stop", key: "stop", expectedRevision: 1 },
      );
      expect(result.state).toBe(mode === "native" ? "succeeded" : mode === "lost" ? "failed" : "uncertain");
      expect(checkpoints).toBe(mode !== "unknown" ? 1 : 0);
      if (mode === "lost") expect(result.errorCode).toBe("native_continuity_lost");
      const saved = await f.store.read(f.p.owner, f.p.org, f.machine.orchestratorId);
      expect(saved.state).toBe(mode === "native" ? "stopped" : "blocked");
      expect(saved.continuity).toBe(mode === "native" ? "native" : mode === "lost" ? "lost" : "unverified");
      const listed = await runtime.list(
        { userId: f.p.owner, orgs: [{ orgId: f.p.org, role: "member" }], via: "supabase" },
        f.p.org,
      );
      expect(listed.items[0]?.continuity).toBe(mode === "native" ? "native" : mode === "lost" ? "lost" : "unverified");
      const replay = await runtime.mutate(
        { userId: f.p.owner, orgs: [{ orgId: f.p.org, role: "member" }], via: "supabase" },
        { orgId: f.p.org, id: f.machine.orchestratorId, action: "stop", key: "stop", expectedRevision: 1 },
      );
      expect(replay.id).toBe(result.id);
      expect(checkpoints).toBe(mode !== "unknown" ? 1 : 0);
      if (mode === "lost") {
        const next = await runtime.mutate(
          { userId: f.p.owner, orgs: [{ orgId: f.p.org, role: "member" }], via: "supabase" },
          { orgId: f.p.org, id: f.machine.orchestratorId, action: "stop", key: "new-stop", expectedRevision: 2 },
        );
        expect(next.state).toBe("uncertain");
        expect((await f.store.read(f.p.owner, f.p.org, f.machine.orchestratorId)).continuity).toBe("lost");
        expect(checkpoints).toBe(1);
      }
    } finally {
      await f.db.close();
    }
  },
);
