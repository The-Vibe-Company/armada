import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { catalogLock, catalogReceipt, catalogReference } from "../../core/test/support/skillpack-catalog.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { launchOrchestratorParent } from "../src/orchestrator-launch.ts";
import { LifecycleRuntimeStore, lifecycleDetail } from "../src/orchestrator-lifecycle-integration.ts";
import { OrchestratorRuntime } from "../src/orchestrator-runtime.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(skillpackKey?: () => Promise<string | null>) {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (await core.createSqlGoldenStore(sql).list(p.org)).find((g) => g.name === "shared")!;
  const account = (await core.createSqlVaultStore(sql).credentials("user", p.owner)).find(
    (c) => c.kind === "claude_oauth",
  )!;
  const configuration: core.OrchestratorCreate = {
    version: 1,
    orgId: p.org,
    name: "queued parent",
    goldenId: golden.id,
    provider: "boat",
    harness: "claude",
    model: "claude-opus-5-5",
    modelAccountId: account.id!,
  };
  const store = new LifecycleRuntimeStore(sql, core.reserveOrchestratorOperation);
  const provider = fakeBoat();
  const originalExec = provider.provider.exec;
  let replaceGeneration = false;
  provider.provider.exec = async (request) => {
    if (replaceGeneration) {
      replaceGeneration = false;
      await sql.query(
        "update sandboxes set lifecycle_generation=lifecycle_generation+1,status='ready' where provider_sandbox_id=$1",
        [request.sandboxId],
      );
      await sql.query(
        "update orchestrators set state='ready' where sandbox_id=(select id from sandboxes where provider_sandbox_id=$1)",
        [request.sandboxId],
      );
    }
    const result = await originalExec(request);
    return { ...result, exitCode: 1, stderr: "synthetic initialization failure" };
  };
  const gate = deferred<void>(),
    entered = deferred<void>();
  const credentials = launchCredentials(core.createSqlVaultStore(sql), ENCRYPTION_KEY);
  const authority = new core.OrchestratorAuthority(sql, async () => {
    throw Error("No delegated admission in create initialization test.");
  });
  const diagnostics: string[] = [];
  const runtime = new OrchestratorRuntime({
    diagnosticLog: (line) => diagnostics.push(line),
    lifecycleDetail: lifecycleDetail(sql),
    ...(skillpackKey ? { skillpackKey } : {}),
    store,
    authority,
    skillRevision: "a".repeat(40),
    managed: {
      sql,
      resolveManaged: async () => {
        throw Error("No managed stop expected.");
      },
    },
    resolveBackend: async () => {
      entered.resolve();
      await gate.promise;
      return {
        provider: provider.provider,
        projectDir: core.GOLDEN_ROOT,
        mcpUrl: "https://fixture.invalid/api/v1/orchestrator-tools/mcp",
        consent: { scopes: [], goldenIds: [], credentialIds: [] },
        assertNativeProof: async () => {},
        revalidate: async () => {},
        launch: (reservation, diagnostics, hooks) =>
          launchOrchestratorParent({
            sql,
            provider: provider.provider,
            actor: { userId: p.owner, orgId: p.org, role: "member" },
            request: { golden: golden.name, provider: "boat", harness: "claude", model: configuration.model },
            stores: {
              goldens: core.createSqlGoldenStore(sql),
              sandboxes: core.createSqlSandboxStore(sql),
              credentials,
            },
            reservation,
            ...(diagnostics ? { diagnostics } : {}),
            ...(hooks ? { hooks } : {}),
            account: {
              credentialId: account.id!,
              credentialVersion: 1,
              resolve: (a, h, id, v) => credentials.resolve(a, h, id, v),
            },
          }),
      };
    },
  });
  const caller = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" as const }], via: "supabase" as const };
  return {
    db,
    sql,
    p,
    store,
    runtime,
    configuration,
    caller,
    provider,
    gate,
    entered,
    diagnostics,
    credentials,
    replace: () => {
      replaceGeneration = true;
    },
  };
}

test.each([false, true])(
  "create admission never waits for provider and exact registered initialization failure settles (replacement=%s)",
  async (replace) => {
    const f = await fixture();
    try {
      if (replace) f.replace();
      const response = f.runtime.create(f.caller, f.configuration, "queued-create");
      const admitted = await Promise.race([
        response,
        f.entered.promise.then(() => {
          throw Error("Create waited for provider selection before admission.");
        }),
      ]);
      expect(admitted.state).toBe("pending");
      await f.entered.promise;
      expect((await f.runtime.create(f.caller, f.configuration, "queued-create")).id).toBe(admitted.id);
      expect(f.provider.forks).toHaveLength(0);
      f.gate.resolve();
      await f.runtime.createWorker.drain();
      expect(f.provider.forks).toHaveLength(1);
      // A logical stop after losing the old generation could kill a replacement.
      // Managed failures retain compute for exact owner recovery instead.
      expect(f.provider.stops).toHaveLength(0);
      expect(f.provider.sandbox("bx_1").info.state).toBe("ready");
      const operation = (await f.store.operations(f.p.owner, f.p.org, admitted.orchestratorId)).find(
        (p) => p.id === admitted.id,
      )!;
      expect(operation.state).toBe("uncertain");
      const current = await f.store.read(f.p.owner, f.p.org, admitted.orchestratorId);
      expect(current.generation).toBe(replace ? 2 : 1);
      expect(current.state).toBe(replace ? "ready" : "blocked");
      expect(
        (await f.sql.query<{ status: string }>("select status from sandboxes where id=$1", [current.sandboxId])).rows[0]
          ?.status,
      ).toBe(replace ? "ready" : "failed");
      expect(current.sandboxId).not.toBeNull();
      expect(
        (
          await f.sql.query<{ runtime_result: { binding: { generation: number } } }>(
            "select runtime_result from orchestrator_operations where id=$1",
            [admitted.id],
          )
        ).rows[0]?.runtime_result.binding.generation,
      ).toBe(1);
    } finally {
      f.gate.resolve();
      await f.runtime.createWorker.drain();
      await f.db.close();
    }
  },
  20_000,
);

test("only queued tagged work dispatches; expired dispatched work becomes uncertain and legacy pending stays recovery-only", async () => {
  const f = await fixture();
  try {
    const queued = await f.store.create({
      ownerId: f.p.owner,
      configuration: f.configuration,
      key: "crash-queued",
      skillRevision: "a".repeat(40),
      queued: true,
    });
    const legacy = await f.store.create({
      ownerId: f.p.owner,
      configuration: { ...f.configuration, name: "legacy" },
      key: "legacy-pending",
      skillRevision: "a".repeat(40),
    });
    const claimed = await f.store.claimCreateJob();
    expect(claimed?.operation.id).toBe(queued.operation.id);
    await f.store.dispatchCreateFork(claimed!, crypto.randomUUID());
    await f.sql.query(
      "update orchestrator_operations set runtime_result=jsonb_set(runtime_result,'{leaseUntil}','\"2000-01-01T00:00:00Z\"') where id=$1",
      [queued.operation.id],
    );
    expect(await f.runtime.createWorker.reconcileOne()).toBe(true);
    expect((await f.store.operations(f.p.owner, f.p.org, queued.identity.id))[0]?.state).toBe("uncertain");
    expect((await f.store.operations(f.p.owner, f.p.org, legacy.identity.id))[0]?.state).toBe("pending");
    expect(
      (await f.sql.query("select state,sandbox_id from orchestrators where id=$1", [queued.identity.id])).rows,
    ).toEqual([{ state: "stopped", sandbox_id: null }]);
    expect(f.diagnostics.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        stage: "create_reconciliation",
        reason: "create_worker_interrupted",
        operationId: queued.operation.id,
        orchestratorId: queued.identity.id,
        outcome: "uncertain",
      }),
    );
    expect(await f.runtime.createWorker.reconcileOne()).toBe(false);
    expect(f.provider.forks).toHaveLength(0);
  } finally {
    f.gate.resolve();
    await f.runtime.createWorker.drain();
    await f.db.close();
  }
}, 20_000);

test("revoked membership fails only tagged queued intent, emits a correlated failure, and never allocates", async () => {
  const f = await fixture();
  try {
    const queued = await f.store.create({
      ownerId: f.p.owner,
      configuration: f.configuration,
      key: "revoked-queued",
      skillRevision: "a".repeat(40),
      queued: true,
    });
    await f.sql.query("delete from members where org_id=$1 and user_id=$2", [f.p.org, f.p.owner]);
    expect(await f.runtime.createWorker.reconcileOne()).toBe(true);
    expect(
      (await f.sql.query("select state,error_code from orchestrator_operations where id=$1", [queued.operation.id]))
        .rows,
    ).toEqual([{ state: "failed", error_code: "create_authority_revoked" }]);
    expect(f.diagnostics.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        stage: "create_reconciliation",
        reason: "create_authority_revoked",
        operationId: queued.operation.id,
        orchestratorId: queued.identity.id,
        outcome: "failed",
      }),
    );
    expect(f.provider.forks).toHaveLength(0);
  } finally {
    f.gate.resolve();
    await f.runtime.createWorker.drain();
    await f.db.close();
  }
}, 20_000);

test.each([false, true])(
  "a parent billing refusal is terminal only without retained resource evidence (keepSource=%s)",
  async (keepSource) => {
    const f = await fixture();
    try {
      f.provider.provider.fork = async () => {
        throw new core.ProviderError({
          provider: "boat",
          code: "payment_required",
          retryable: false,
          message: "opaque upstream",
          ...(keepSource ? { details: { keepSource: true } } : {}),
        });
      };
      const admitted = await f.runtime.create(f.caller, f.configuration, "billing-refusal");
      f.gate.resolve();
      await f.runtime.createWorker.drain();
      expect(
        (
          await f.db.query(
            "select state,error_code,runtime_result->>'noFork' as no_fork from orchestrator_operations where id=$1",
            [admitted.id],
          )
        ).rows,
      ).toEqual([
        {
          state: keepSource ? "uncertain" : "failed",
          error_code: keepSource ? "runtime_uncertain" : "provider_payment_required",
          no_fork: keepSource ? null : "true",
        },
      ]);
      expect(
        (await f.db.query("select sandbox_id from orchestrators where id=$1", [admitted.orchestratorId])).rows,
      ).toEqual([{ sandbox_id: null }]);
      expect(f.provider.forks).toHaveLength(0);
    } finally {
      f.gate.resolve();
      await f.runtime.createWorker.drain();
      await f.db.close();
    }
  },
);

// Owner detail/list must expose the logical preparation phase, not the already
// running physical worker. Hold the actual async skill boundary without sleeps.
test.each(["refused", "succeeded"])("requested skill readiness stays creating until %s", async (outcome) => {
  const installing = deferred<void>(),
    release = deferred<void>();
  const f = await fixture(async () => {
    installing.resolve();
    await release.promise;
    throw new core.PrivateSkillError("skillpack_scope_refused", "auth");
  });
  const originalGet = f.provider.provider.get;
  f.provider.provider.get = async (id) => ({ ...(await originalGet(id)), physicalGeneration: "1" });
  f.provider.provider.installOrchestratorEpoch = async () => ({ acknowledged: true });
  f.provider.provider.scrubOrchestratorEpoch = async () => ({ acknowledged: true });
  f.provider.provider.exec = async (request) => {
    if (request.command.includes("skillpack install")) {
      installing.resolve();
      await release.promise;
    }
    return {
      detached: false,
      exitCode: 0,
      stdout: request.command.includes("skillpack install") ? catalogLock("claude-code") : "",
      stderr: "",
      timedOut: false,
      truncated: false,
    };
  };
  try {
    const operation = await f.runtime.create(
      f.caller,
      { ...f.configuration, skill: outcome === "refused" ? "notes@1.0.0" : catalogReference },
      "skill-readiness",
    );
    f.gate.resolve();
    await installing.promise;
    const detail = await f.runtime.detail(f.caller, f.p.org, operation.orchestratorId);
    expect(detail.orchestrator.state).toBe("creating");
    expect(detail.orchestrator.skillReceipt).toBeNull();
    expect(detail.operations.find((item) => item.id === operation.id)?.state).toBe("pending");
    expect(
      (await f.runtime.list(f.caller, f.p.org)).items.find((item) => item.id === operation.orchestratorId)?.state,
    ).toBe("creating");
    expect(f.provider.sandbox("bx_1").info.state).toBe("ready");
    await expect(
      f.runtime.mutate(f.caller, {
        orgId: f.p.org,
        id: operation.orchestratorId,
        action: "message",
        key: "early-message",
        expectedRevision: detail.orchestrator.revision,
        text: "Do not run before skill readiness",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    release.resolve();
    await f.runtime.createWorker.drain();
    const final = await f.runtime.detail(f.caller, f.p.org, operation.orchestratorId);
    expect(final.operations.find((item) => item.id === operation.id)?.state).toBe(
      outcome === "refused" ? "failed" : "succeeded",
    );
    expect(final.orchestrator.state).toBe(outcome === "refused" ? "stopped" : "ready");
    expect(final.orchestrator.skillReceipt).toEqual(outcome === "refused" ? null : catalogReceipt);
    if (outcome === "refused") expect(final.orchestrator.blockedReason).toBe("skillpack_scope_refused");
  } finally {
    f.gate.resolve();
    release.resolve();
    await f.runtime.createWorker.drain();
    await f.db.close();
  }
});

test("busy account refusal is terminal before allocation and retains the reason in detail, replay and events", async () => {
  const f = await fixture();
  try {
    f.credentials.admit = async () => {
      throw new core.VaultError("credential_busy", core.CREDENTIAL_BUSY_MESSAGE);
    };
    const admitted = await f.runtime.create(f.caller, f.configuration, "busy-account");
    f.gate.resolve();
    await f.runtime.createWorker.drain();
    const detail = await f.runtime.detail(f.caller, f.p.org, admitted.orchestratorId);
    expect(detail.orchestrator).toMatchObject({
      state: "stopped",
      continuity: "not_started",
      sandboxId: null,
      blockedReason: "credential_busy",
      failureMessage: core.CREDENTIAL_BUSY_MESSAGE,
    });
    // Build 5 synthesizes Codable for precisely these six parent state values.
    const build5States = ["creating", "ready", "stopping", "stopped", "resuming", "blocked"];
    const listed = await f.runtime.list(f.caller, f.p.org);
    expect(listed.items.some((row) => row.id === admitted.orchestratorId)).toBe(true);
    for (const row of [...listed.items, detail.orchestrator])
      expect(build5States).toContain(JSON.parse(JSON.stringify(row)).state);
    expect(detail.operations[0]).toMatchObject({
      state: "failed",
      errorCode: "credential_busy",
      errorMessage: core.CREDENTIAL_BUSY_MESSAGE,
    });
    expect(await f.runtime.create(f.caller, f.configuration, "busy-account")).toMatchObject({
      state: "failed",
      errorCode: "credential_busy",
      errorMessage: core.CREDENTIAL_BUSY_MESSAGE,
    });
    const events = await f.db.query<{ event: unknown }>(
      "select event from orchestrator_runtime_events where orchestrator_id=$1",
      [admitted.orchestratorId],
    );
    expect(events.rows.map((r) => r.event)).toContainEqual({
      kind: "operation",
      operation: {
        ...admitted,
        state: "failed",
        errorCode: "credential_busy",
        errorMessage: core.CREDENTIAL_BUSY_MESSAGE,
      },
    });
    await expect(
      f.runtime.mutate(f.caller, {
        orgId: f.p.org,
        id: admitted.orchestratorId,
        action: "stop",
        key: "stop-failed",
        expectedRevision: detail.orchestrator.revision,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const afterStop = await f.runtime.detail(f.caller, f.p.org, admitted.orchestratorId);
    expect(afterStop.orchestrator).toMatchObject({
      state: "stopped",
      blockedReason: "credential_busy",
      revision: detail.orchestrator.revision,
    });
    expect(afterStop.operations).toHaveLength(1);
    expect(f.provider.forks).toHaveLength(0);
  } finally {
    f.gate.resolve();
    await f.runtime.createWorker.drain();
    await f.db.close();
  }
});
