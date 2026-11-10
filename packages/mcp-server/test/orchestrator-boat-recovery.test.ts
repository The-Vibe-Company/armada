import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import { createBoatOrchestratorRecovery } from "../src/orchestrator-boat-recovery.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, fakeBoat } from "./support.ts";

// Recovery's primary contract: owner-only retirement fences a later incarnation,
// survives ambiguous archival, and replays without touching compute after success.
test("Boat retirement recovers an uncertain later-incarnation stop without restoring authority", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (await core.createSqlGoldenStore(sql).list(p.org)).find((g) => g.name === "shared")!;
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const creation = await store.create({
      ownerId: p.owner,
      key: "retire-create",
      skillRevision: "a".repeat(40),
      configuration: {
        version: 1,
        orgId: p.org,
        name: "retirement",
        goldenId: golden.id,
        provider: "boat",
        harness: "codex",
        model: "gpt-6.1-sol",
        modelAccountId: crypto.randomUUID(),
      },
    });
    const saved = await core.createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      orgId: p.org,
      ownerId: p.owner,
      goldenId: golden.id,
      provider: "boat",
      providerSandboxId: crypto.randomUUID(),
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      harness: "codex",
      status: "ready",
      visibility: "private",
    });
    await sql.query(`update public.orchestrators set sandbox_id=$2,state='ready' where id=$1`, [
      creation.identity.id,
      saved.id,
    ]);
    await sql.query(
      `update public.sandboxes set lifecycle_generation=2,orchestrator_native_generation='boot-2' where id=$1`,
      [saved.id],
    );
    await sql.query(`update public.orchestrator_operations set state='succeeded' where id=$1`, [creation.operation.id]);
    const stop = await core.reserveOrchestratorOperation(sql, {
      orchestratorId: creation.identity.id,
      actorId: p.owner,
      action: "stop",
      key: "ambiguous-stop",
      digest: "0".repeat(64),
      expectedRevision: 1,
    });
    await sql.query(`update public.orchestrator_operations set state='uncertain' where id=$1`, [stop.id]);
    await sql.query(`update public.orchestrators set state='blocked' where id=$1`, [creation.identity.id]);
    const placement = fakeBoat();
    let fail = true,
      calls = 0,
      stopped = false;
    const provider = {
      ...placement.provider,
      get: async () => ({
        id: saved.providerSandboxId,
        name: "retire",
        providerState: stopped ? "stopped" : "ready",
        state: stopped ? ("stopped" as const) : ("ready" as const),
        labels: {},
      }),
      resumeBestEffort: async () => {},
      conversations: async () => [],
      stopBestEffort: async () => {
        calls++;
        if (fail) throw Error("ambiguous archival");
        stopped = true;
      },
    } as BoatProvider;
    const recover = createBoatOrchestratorRecovery(sql, { resolve: async () => provider });
    const input = { ownerId: p.owner, orgId: p.org, id: creation.identity.id, expectedRevision: 2, key: "retire" };
    await expect(recover({ ...input, ownerId: p.member })).rejects.toThrow();
    expect(calls).toBe(0);
    expect((await recover(input)).state).toBe("uncertain");
    fail = false;
    expect((await recover(input)).state).toBe("succeeded");
    expect((await recover(input)).state).toBe("succeeded");
    expect(calls).toBe(2);
    const row = (
      await sql.query<{ status: string; stop_requested_at: unknown; lifecycle_generation: number }>(
        `select status,stop_requested_at,lifecycle_generation from public.sandboxes where id=$1`,
        [saved.id],
      )
    ).rows[0]!;
    expect(row.status).toBe("stopped");
    expect(row.stop_requested_at).not.toBeNull();
    expect(Number(row.lifecycle_generation)).toBe(2);
    await expect(recover({ ...input, key: "different-key" })).rejects.toThrow();
  } finally {
    await db.close();
  }
});
