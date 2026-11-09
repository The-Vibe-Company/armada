import { expect, test } from "bun:test";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createOrchestratorWaits, type WaitEvidence } from "../src/orchestrator-waits.ts";
import { database } from "./support.ts";

test("evidenced waits retain absolute deadline, reject heartbeat-only renewal and scope receipt retries", async () => {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const parent = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "wait-parent",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      status: "running",
      model: "m",
      reasoningEffort: "high",
      visibility: "private",
    });
    const id = crypto.randomUUID();
    await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id,state) values($1,$2,$3,$4,'ready')", [
      id,
      p.org,
      p.owner,
      parent.id,
    ]);
    let now = new Date("2030-01-01T00:00:00Z");
    let identity = "run-event-1";
    let state: WaitEvidence["state"] = "active";
    const waits = createOrchestratorWaits(
      sql,
      {
        async inspect(input) {
          return { ...input, identity, at: now, state } satisfies WaitEvidence;
        },
      },
      () => now,
    );
    const input = {
      key: "register",
      orchestratorId: id,
      ownerId: p.owner,
      expectedRevision: 0,
      generation: String(parent.lifecycleGeneration ?? 1),
      kind: "ci" as const,
      reference: "repo:run-663",
      reason: "Waiting for verified run",
    };
    const first = await waits.record(input);
    expect(first.expiresAt).toBe("2030-01-01T00:15:00.000Z");
    expect(await waits.record(input)).toEqual(first);
    await expect(waits.record({ ...input, expectedRevision: 1 })).rejects.toThrow("Idempotency conflict");
    await expect(waits.record({ ...input, reason: "changed" })).rejects.toThrow("Idempotency conflict");
    now = new Date("2030-01-01T00:10:00Z");
    await expect(waits.record({ ...input, key: "heartbeat", expectedRevision: 1 })).rejects.toThrow("new evidence");
    identity = "run-event-2";
    const renewed = await waits.record({ ...input, key: "renew", expectedRevision: 1 });
    expect(renewed.deadline).toBe(first.deadline);
    expect(renewed.expiresAt).toBe("2030-01-01T00:25:00.000Z");
    now = new Date("2030-01-02T00:00:01Z");
    identity = "run-event-3";
    await expect(waits.record({ ...input, key: "reset", expectedRevision: 2 })).rejects.toThrow("original deadline");
    state = "complete";
    const completed = await waits.record({ ...input, key: "completed-after-cap", expectedRevision: 2 });
    expect(completed.released).toBe(true);
    expect(completed.deadline).toBe(first.deadline);
    await expect(waits.record({ ...input, key: "admin", ownerId: p.admin, expectedRevision: 2 })).rejects.toThrow(
      "unavailable",
    );
    state = "active";
    const requestedExpiry = new Date(now.getTime() + 60_000).toISOString();
    const shortened = await waits.record({
      ...input,
      key: "short-lease",
      reference: "repo:another-approved-run",
      expectedRevision: 3,
      expiresAt: requestedExpiry,
    });
    expect(shortened.expiresAt).toBe(requestedExpiry);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [p.admin]);
    expect((await db.query("select id from orchestrator_waits")).rows).toHaveLength(0);
    await expect(db.query("update orchestrator_waits set deadline=deadline+interval '1 day'")).rejects.toThrow();
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});
