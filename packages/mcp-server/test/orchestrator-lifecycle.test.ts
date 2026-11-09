import { expect, test } from "bun:test";
import { createSqlSandboxStore, reserveOrchestratorOperation, type Sql } from "@armada/core/server";
import { recordOrchestratorActivity } from "../src/orchestrator-activity.ts";
import { createOrchestratorLifecycle } from "../src/orchestrator-lifecycle.ts";
import type {
  LifecycleStopReceipt,
  OrchestratorLifecycleRuntime,
  RuntimeObservation,
} from "../src/orchestrator-lifecycle-contract.ts";
import {
  createLifecycleAwareOrchestratorRuntime,
  LifecycleRuntimeStore,
} from "../src/orchestrator-lifecycle-integration.ts";
import { configureOrchestratorLifecycle } from "../src/orchestrator-lifecycle-settings.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { database, fakeBoat } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw new Error("Fixture golden missing.");
  const parent = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "lifecycle-parent",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "running",
    model: "m",
    reasoningEffort: "high",
    visibility: "private",
  });
  const id = crypto.randomUUID();
  let time = new Date("2030-01-01T00:00:00Z");
  await db.query("update sandboxes set expires_at=$2 where id=$1", [parent.id, new Date("2030-02-01T00:00:00Z")]);
  await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id,state) values($1,$2,$3,$4,'ready')", [
    id,
    people.org,
    people.owner,
    parent.id,
  ]);
  await db.query(
    `insert into orchestrator_runtime(orchestrator_id,configuration,skill_revision,conversation_id,continuity)
    values($1,$2::jsonb,$3,'synthetic-native-conversation','native')`,
    [
      id,
      JSON.stringify({
        version: 1,
        orgId: people.org,
        name: "lifecycle",
        goldenId: golden.id,
        provider: "boat",
        harness: "codex",
        model: "m",
        modelAccountId: crypto.randomUUID(),
      }),
      "78884de87066851b75e09cbda134606c0a8bc6d7",
    ],
  );
  await db.query(
    "insert into orchestrator_lifecycle(orchestrator_id,last_activity_at,reconcile_after) values($1,$2,$2)",
    [id, time],
  );
  let observation: RuntimeObservation["state"] = "quiescent";
  let stopResult: LifecycleStopReceipt["state"] = "stopped";
  let duringObservation: (() => Promise<void>) | undefined;
  let stopCalls = 0;
  let reconcileCalls = 0;
  const runtime: OrchestratorLifecycleRuntime = {
    async observe(machine) {
      await duringObservation?.();
      return {
        ...machine,
        physicalGeneration: "synthetic-native-physical-1",
        state: observation,
        evidence: "actual-prompt-observation",
      };
    },
    async stop(machine, _reason, operationId) {
      stopCalls++;
      return {
        ...machine,
        operationId,
        state: stopResult,
        physicalGeneration: machine.physicalGeneration ?? null,
        continuity: "native",
      };
    },
    async reconcileStop(machine, operationId) {
      reconcileCalls++;
      return {
        ...machine,
        operationId,
        state: stopResult,
        physicalGeneration: machine.physicalGeneration ?? null,
        continuity: "native",
      };
    },
  };
  const worker = createOrchestratorLifecycle(sql, runtime, () => time);
  return {
    db,
    sql,
    people,
    parent,
    id,
    worker,
    runtime,
    now: () => time,
    advance(seconds: number) {
      time = new Date(time.getTime() + seconds * 1000);
    },
    observe(state: RuntimeObservation["state"]) {
      observation = state;
    },
    stopResult(state: LifecycleStopReceipt["state"]) {
      stopResult = state;
    },
    onObservation(work: () => Promise<void>) {
      duringObservation = work;
    },
    calls: () => ({ stopCalls, reconcileCalls }),
    async state() {
      return (
        await db.query<{ state: string; reason: string; last_activity_at: Date }>(
          "select o.state,l.reason,l.last_activity_at from orchestrators o join orchestrator_lifecycle l on l.orchestrator_id=o.id where o.id=$1",
          [id],
        )
      ).rows[0];
    },
  };
}

test("confirmed quiescence starts an idle interval; polling cannot extend it and an uncertain stop reconciles once", async () => {
  const f = await fixture();
  try {
    await f.worker.reconcileOne();
    const first = (await f.state())?.last_activity_at;
    f.advance(3600);
    await f.worker.reconcileOne();
    expect((await f.state())?.last_activity_at).toEqual(first);
    expect(f.calls().stopCalls).toBe(0);
    f.stopResult("uncertain");
    f.advance(3600);
    await f.worker.reconcileOne();
    expect((await f.state())?.state).toBe("blocked");
    expect((await f.state())?.reason).toBe("stop_outcome_unconfirmed");
    f.stopResult("stopped");
    f.advance(61);
    await f.worker.reconcileOne();
    expect((await f.state())?.state).toBe("stopped");
    expect(f.calls()).toEqual({ stopCalls: 1, reconcileCalls: 1 });
    expect((await f.db.query("select id from sandboxes where id=$1", [f.parent.id])).rows).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

for (const kind of [
  "silent-prompt",
  "unknown",
  "child",
  "failed-child-unconfirmed",
  "expired-wait",
  "operation",
] as const) {
  test(`${kind} cannot be mistaken for inactivity after the cutoff`, async () => {
    const f = await fixture();
    try {
      await f.worker.reconcileOne();
      if (kind === "silent-prompt") f.observe("active");
      if (kind === "unknown") f.observe("unknown");
      if (kind === "child" || kind === "failed-child-unconfirmed") {
        const golden = (await f.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
        if (!golden) throw Error("missing golden");
        const child = await createSqlSandboxStore(f.sql).insert({
          id: crypto.randomUUID(),
          provider: "boat",
          providerSandboxId: "silent-child",
          goldenId: golden.id,
          orgId: f.people.org,
          ownerId: f.people.owner,
          harness: "claude",
          status: kind === "failed-child-unconfirmed" ? "failed" : "running",
          model: "m",
          reasoningEffort: "high",
          visibility: "private",
        });
        await f.db.query("insert into orchestrator_children values($1,$2,$3,$4)", [
          child.id,
          f.id,
          f.people.org,
          f.people.owner,
        ]);
      }
      if (kind === "operation")
        await f.db.query(
          `insert into orchestrator_operations(orchestrator_id,actor_id,action,idempotency_key,request_digest,revision)
        values($1,$2,'message','pending',$3,1)`,
          [f.id, f.people.owner, "a".repeat(64)],
        );
      if (kind === "expired-wait")
        await f.db.query(
          `insert into orchestrator_waits(orchestrator_id,parent_generation,kind,reference,reason,evidence,evidence_at,expires_at,deadline,created_at)
        values($1,1,'ci','run:1','CI build','event:1','2030-01-01','2030-01-01T00:15:00Z','2030-01-02','2030-01-01')`,
          [f.id],
        );
      f.advance(7201);
      await f.worker.reconcileOne();
      expect((await f.state())?.state).toBe("ready");
      expect(f.calls().stopCalls).toBe(0);
    } finally {
      await f.db.close();
    }
  });
}

for (const fence of ["machine-generation", "parent-revision"] as const) {
  test(`a ${fence} admission during observation wins over stale idle stop`, async () => {
    const f = await fixture();
    try {
      await f.worker.reconcileOne();
      f.advance(7201);
      f.onObservation(async () => {
        if (fence === "machine-generation")
          await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [
            f.parent.id,
          ]);
        else await f.db.query("update orchestrators set revision=revision+1 where id=$1", [f.id]);
      });
      await f.worker.reconcileOne();
      expect((await f.state())?.state).toBe("ready");
      expect(f.calls().stopCalls).toBe(0);
    } finally {
      await f.db.close();
    }
  });
}

test("hard TTL and owner removal use trusted bound stop, not idle or successful interrupted resume", async () => {
  for (const cause of ["hard-ttl", "removed-owner"] as const) {
    const f = await fixture();
    try {
      f.observe("active");
      if (cause === "hard-ttl")
        await f.db.query("update sandboxes set expires_at='2030-01-01T00:01:00Z' where id=$1", [f.parent.id]);
      else await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
      if (cause === "hard-ttl") f.advance(61);
      await f.worker.reconcileOne();
      expect(f.calls().stopCalls).toBe(1);
      expect((await f.state())?.state).toBe(cause === "hard-ttl" ? "blocked" : "stopped");
      expect((await f.state())?.reason).toBe(
        cause === "hard-ttl" ? "hard_ttl_interrupted_continuity_unverified" : "owner_removed_stopped_native",
      );
    } finally {
      await f.db.close();
    }
  }
});

test("cancelled observation cannot hold the shared lane or publish after another lease wins", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await f.worker.reconcileOne();
    f.advance(7201);
    f.runtime.observe = async (machine) => {
      entered();
      await gate;
      return {
        ...machine,
        physicalGeneration: "synthetic-native-physical-1",
        state: "quiescent",
        evidence: "late-native-observation",
      };
    };
    const controller = new AbortController();
    const first = f.worker.reconcileOne(controller.signal);
    await ready;
    controller.abort();
    await first;
    expect(f.calls().stopCalls).toBe(0);
    f.advance(121);
    const replica = createOrchestratorLifecycle(
      f.sql,
      {
        ...f.runtime,
        async observe(machine) {
          return {
            ...machine,
            physicalGeneration: "synthetic-native-physical-1",
            state: "quiescent",
            evidence: "current-native-observation",
          };
        },
      },
      () => new Date("2030-01-01T02:02:02Z"),
    );
    await replica.reconcileOne();
    release();
    await f.worker.drain();
    expect(f.calls().stopCalls).toBe(1);
    expect((await f.state())?.state).toBe("stopped");
  } finally {
    release();
    await f.db.close();
  }
});

test("native journal receipts deduplicate polling and owner policy changes are fenced and idempotent", async () => {
  const f = await fixture();
  try {
    const machine = {
      orchestratorId: f.id,
      sandboxId: f.parent.id,
      providerSandboxId: f.parent.providerSandboxId,
      generation: String(f.parent.lifecycleGeneration ?? 1),
    };
    const event = {
      id: "native-event-1",
      at: 1,
      promptId: "native-prompt-1",
      conversationId: "native-conversation-1",
      kind: "prompt" as const,
      text: "",
      status: "finished" as const,
    };
    const at = new Date("2030-01-01T00:00:10Z");
    expect(await recordOrchestratorActivity(f.sql, machine, event, () => at)).toBe(true);
    expect(await recordOrchestratorActivity(f.sql, machine, event, () => new Date("2030-01-01T01:00:00Z"))).toBe(false);
    expect((await f.state())?.last_activity_at).toEqual(at);
    expect(
      await recordOrchestratorActivity(
        f.sql,
        { ...machine, generation: "99" },
        { ...event, id: "stale-event" },
        () => at,
      ),
    ).toBe(false);
    const policy = {
      key: "owner-policy",
      orchestratorId: f.id,
      ownerId: f.people.owner,
      expectedRevision: 0,
      idleSeconds: 900,
      maxActiveChildren: null,
    };
    await configureOrchestratorLifecycle(f.sql, policy);
    await configureOrchestratorLifecycle(f.sql, policy);
    expect(
      (await f.db.query<{ revision: number }>("select revision from orchestrators where id=$1", [f.id])).rows[0]
        ?.revision,
    ).toBe(1);
    await expect(configureOrchestratorLifecycle(f.sql, { ...policy, idleSeconds: 901 })).rejects.toThrow(
      "Idempotency conflict",
    );
    await expect(
      configureOrchestratorLifecycle(f.sql, {
        ...policy,
        key: "admin-policy",
        ownerId: f.people.admin,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("unavailable");
    const row = (
      await f.db.query<{ idle_seconds: number; max_active_children: number | null }>(
        "select idle_seconds,max_active_children from orchestrator_lifecycle where orchestrator_id=$1",
        [f.id],
      )
    ).rows[0];
    expect(row).toEqual({ idle_seconds: 900, max_active_children: null });
    const effective = await new LifecycleRuntimeStore(f.sql, reserveOrchestratorOperation).read(
      f.people.owner,
      f.people.org,
      f.id,
    );
    expect(effective.configuration.idleSeconds).toBe(900);
    expect(effective.configuration.maxActiveChildren).toBeUndefined();
  } finally {
    await f.db.close();
  }
});

test("successful actual runtime-store resume retires the old stop slot without losing its durable receipt", async () => {
  const f = await fixture();
  try {
    await f.worker.reconcileOne();
    f.advance(7201);
    await f.worker.reconcileOne();
    const store = new LifecycleRuntimeStore(f.sql, reserveOrchestratorOperation);
    const revision = (await f.db.query<{ revision: number }>("select revision from orchestrators where id=$1", [f.id]))
      .rows[0]?.revision;
    if (revision === undefined) throw Error("missing parent revision");
    const resumed = await store.reserve({
      ownerId: f.people.owner,
      orgId: f.people.org,
      id: f.id,
      action: "resume",
      key: "verified-native-resume",
      expectedRevision: revision,
      payload: { expectedRevision: revision },
    });
    resumed.identity = await store.preparing(resumed);
    expect(await store.complete(resumed, { state: "succeeded", parentState: "ready" })).toBe(true);
    // The native backend proof belongs to662/operator conformance; this tests its actual fenced publication caller.
    f.advance(61);
    await f.worker.reconcileOne();
    f.advance(7201);
    await f.worker.reconcileOne();
    expect(f.calls().stopCalls).toBe(2);
    expect((await f.state())?.state).toBe("stopped");
    expect(
      (await f.db.query("select id from orchestrator_operations where orchestrator_id=$1 and action='stop'", [f.id]))
        .rows,
    ).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

test("hard TTL interruption is unverified on the actual owner detail API, never a native-success identity", async () => {
  const f = await fixture();
  try {
    await f.db.query("update sandboxes set expires_at='2030-01-01T00:01:00Z' where id=$1", [f.parent.id]);
    f.observe("active");
    f.advance(61);
    await f.worker.reconcileOne();
    const { runtime } = createLifecycleAwareOrchestratorRuntime(f.sql, {
      reserveOperation: reserveOrchestratorOperation,
      authority: {
        async installEpoch() {
          throw Error("no grant in this lifecycle publication test");
        },
        async revoke() {},
        async scrubBeforeCheckpoint() {},
      },
      skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
      async resolveBackend() {
        throw Error("no backend on detail read");
      },
    });
    const detail = await runtime.detail(
      { userId: f.people.owner, orgs: [{ orgId: f.people.org, role: "member" }], via: "supabase" },
      f.people.org,
      f.id,
    );
    expect(detail.orchestrator.continuity).toBe("unverified");
    expect(detail.orchestrator.state).toBe("blocked");
  } finally {
    await f.db.close();
  }
});

test("exhausted wait cap blocks visibly without stopping active work and still admits evidenced completion", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      `insert into orchestrator_waits(orchestrator_id,parent_generation,kind,reference,reason,evidence,evidence_at,expires_at,deadline,created_at)
      values($1,1,'ci','run:cap','build','event:initial','2029-12-31','2029-12-31T00:15:00Z','2030-01-01','2029-12-31')`,
      [f.id],
    );
    f.observe("active");
    f.advance(7201);
    await f.worker.reconcileOne();
    expect((await f.state())?.state).toBe("blocked");
    expect((await f.state())?.reason).toBe("wait_cap_exhausted");
    expect(f.calls().stopCalls).toBe(0);
    const { createOrchestratorWaits } = await import("../src/orchestrator-waits.ts");
    const waits = createOrchestratorWaits(
      f.sql,
      {
        async inspect(input) {
          return { ...input, state: "complete", identity: "event:completed", at: f.now() };
        },
      },
      f.now,
    );
    const revision = (await f.db.query<{ revision: number }>("select revision from orchestrators where id=$1", [f.id]))
      .rows[0]?.revision;
    if (revision === undefined) throw Error("missing parent revision");
    expect(
      (
        await waits.record({
          key: "complete",
          orchestratorId: f.id,
          ownerId: f.people.owner,
          expectedRevision: revision,
          generation: "1",
          kind: "ci",
          reference: "run:cap",
          reason: "build finished",
        })
      ).released,
    ).toBe(true);
    f.advance(61);
    await f.worker.reconcileOne();
    expect(f.calls().stopCalls).toBe(0); // No expiry-as-quiescence shortcut after completion.
  } finally {
    await f.db.close();
  }
});

test("ordinary TTL lane excludes managed parents but still reconciles an unrelated ordinary worker", async () => {
  const f = await fixture();
  try {
    const golden = (await f.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const ordinary = await createSqlSandboxStore(f.sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "ordinary-worker",
      goldenId: golden.id,
      orgId: f.people.org,
      ownerId: f.people.owner,
      harness: "claude",
      status: "running",
      model: "m",
      reasoningEffort: "medium",
      visibility: "private",
    });
    await f.db.query(
      "update sandboxes set expires_at=now()-interval '1 second',reconcile_after=now()-interval '2 minutes' where id=$1",
      [f.parent.id],
    );
    await f.db.query(
      "update sandboxes set expires_at=now()-interval '1 second',reconcile_after=now()-interval '1 minute' where id=$1",
      [ordinary.id],
    );
    const stopped: string[] = [];
    const provider = {
      ...fakeBoat().provider,
      async get(id: string) {
        return {
          id,
          name: id,
          state: stopped.includes(id) ? ("stopped" as const) : ("running" as const),
          providerState: "synthetic",
          labels: {},
        };
      },
      async stop(request: { sandboxId: string }) {
        stopped.push(request.sandboxId);
      },
    };
    expect(await createSandboxLifecycle(f.sql, async () => provider).reconcileOne()).toBe(true);
    expect(stopped).toEqual([ordinary.providerSandboxId]);
    expect(
      (await f.db.query<{ status: string }>("select status from sandboxes where id=$1", [f.parent.id])).rows[0]?.status,
    ).toBe("running");
  } finally {
    await f.db.close();
  }
});

for (const proof of ["missing-observation-physical", "mismatched-stop-physical"] as const) {
  test(`${proof} never proves idle/native continuity from the SQL activity counter`, async () => {
    const f = await fixture();
    try {
      if (proof === "missing-observation-physical")
        f.runtime.observe = async (machine) => ({
          ...machine,
          physicalGeneration: null,
          state: "quiescent",
          evidence: "native-state-without-identity",
        });
      else
        f.runtime.stop = async (machine, _reason, operationId) => ({
          ...machine,
          operationId,
          physicalGeneration: "synthetic-native-physical-2",
          state: "stopped",
          continuity: "native",
        });
      await f.worker.reconcileOne();
      f.advance(7201);
      await f.worker.reconcileOne();
      expect((await f.state())?.state).toBe(proof === "missing-observation-physical" ? "ready" : "blocked");
      if (proof === "missing-observation-physical") expect(f.calls().stopCalls).toBe(0);
    } finally {
      await f.db.close();
    }
  });
}

test("proven lost native state remains lost and blocked across unavailable or contradictory stop discovery", async () => {
  const f = await fixture();
  try {
    f.runtime.stop = async (machine, _reason, operationId) => ({
      ...machine,
      physicalGeneration: machine.physicalGeneration ?? null,
      operationId,
      state: "interrupted",
      continuity: "lost",
    });
    let nativeClaim = false;
    f.runtime.reconcileStop = async (machine, operationId) => {
      if (!nativeClaim) throw Error("temporary read-only discovery unavailable");
      return {
        ...machine,
        physicalGeneration: machine.physicalGeneration ?? null,
        operationId,
        state: "stopped",
        continuity: "native",
      };
    };
    await f.worker.reconcileOne();
    f.advance(7201);
    await f.worker.reconcileOne();
    const continuity = async () =>
      (
        await f.db.query<{ continuity: string }>(
          "select continuity from orchestrator_runtime where orchestrator_id=$1",
          [f.id],
        )
      ).rows[0]?.continuity;
    expect(await continuity()).toBe("lost");
    f.advance(61);
    await f.worker.reconcileOne();
    expect(await continuity()).toBe("lost");
    nativeClaim = true;
    f.advance(61);
    await f.worker.reconcileOne();
    expect(await continuity()).toBe("lost");
    expect((await f.state())?.state).toBe("blocked");
    expect(
      (
        await f.db.query<{ state: string }>(
          "select state from orchestrator_operations where orchestrator_id=$1 and action='stop'",
          [f.id],
        )
      ).rows[0]?.state,
    ).toBe("uncertain");
  } finally {
    await f.db.close();
  }
});

// An owner operation failure must not abandon retained compute or hide its failure reason.
for (const cleanup of ["hard_ttl", "owner_removed"] as const) {
  test(`blocked owner failure retains its reason and receives ${cleanup} cleanup`, async () => {
    const f = await fixture();
    try {
      await f.db.query("update orchestrators set state='blocked' where id=$1", [f.id]);
      await f.db.query("update orchestrator_runtime set blocked_reason='runtime_uncertain' where orchestrator_id=$1", [
        f.id,
      ]);
      const detail = await new LifecycleRuntimeStore(f.sql, reserveOrchestratorOperation).read(
        f.people.owner,
        f.people.org,
        f.id,
      );
      expect(detail.blockedReason).toBe("runtime_uncertain");
      if (cleanup === "hard_ttl")
        await f.db.query("update sandboxes set expires_at='2030-01-01T00:05:00Z' where id=$1", [f.parent.id]);
      else await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
      expect(await f.worker.reconcileOne()).toBe(true);
      expect(f.calls().stopCalls).toBe(1);
      expect((await f.state())?.reason).toBe(`${cleanup}_stopped_native`);
    } finally {
      await f.db.close();
    }
  });
}
