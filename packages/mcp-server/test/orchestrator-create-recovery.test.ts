import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as core from "@armada/core/server";
import {
  createModalProvider,
  createSqlModalStore,
  type Machine,
  type RunnerDistribution,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";
import type { ModalClient, Sandbox } from "modal";
import { orchestratorHttp } from "../src/orchestrator-api.ts";
import { createOrchestratorCreateRecovery } from "../src/orchestrator-create-recovery.ts";
import { createProductionOrchestrators } from "../src/orchestrator-production.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const scope: Scope = {
    orgId: p.org,
    userId: p.owner,
    visibility: "private",
    binding: { workspace: "fixture", environment: "main", appId: "ap_recovery" },
  };
  const goldens = core.createSqlGoldenStore(sql);
  const golden = await goldens.insert({
    orgId: p.org,
    ownerId: p.owner,
    visibility: "private",
    name: "boot-recovery",
    provider: "modal",
    modal: scope.binding,
    config: { repos: [{ url: "https://github.com/example/recovery.git", branch: "main", dir: "recovery" }], init: [] },
  });
  await goldens.setSnapshot(golden.id, "snapshot-recovery");
  const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
  const create = await store.create({
    ownerId: p.owner,
    key: "original-create",
    skillRevision: "a".repeat(40),
    configuration: {
      version: 1,
      orgId: p.org,
      name: "uncertain-create",
      goldenId: golden.id,
      provider: "modal",
      harness: "codex",
      model: "gpt-6.1-sol",
      modelAccountId: crypto.randomUUID(),
    },
  });
  await store.complete(create, { state: "uncertain", parentState: "blocked", errorCode: "runtime_uncertain" });
  let loseFenceAck = false;
  const actualNative = createSqlModalStore(sql, scope);
  const native: import("@armada/provider-modal").ModalStore = {
    ...actualNative,
    async lease(id, work) {
      return actualNative.lease(id, (row, save) =>
        work(row, async (current) => {
          await save(current);
          if (loseFenceAck && current.orchestratorCreateRecovery?.state === "dispatched") {
            loseFenceAck = false;
            throw Error("synthetic lost native fence acknowledgement");
          }
        }),
      );
    },
  };
  const id = `modal_${crypto.randomUUID()}`;
  const row: Machine = {
    info: {
      id,
      name: id,
      state: "starting",
      providerState: "booting",
      labels: {
        sandbox: crypto.randomUUID(),
        operation: create.operation.id,
        orchestrator: create.identity.id,
        owner: p.owner,
        org: p.org,
        visibility: "private",
        harness: "codex",
      },
    },
    generation: 1,
    phase: "booting",
    golden: false,
    launchUserId: p.owner,
    physicalId: "sb_boot_original",
    physicalName: `armada-${createHash("sha256").update(id).digest("hex").slice(0, 32)}-1`,
    ttlSeconds: 86400,
    runtimePolicy: "explicit-vm-v1",
    runtimeEvidence: { version: 1, runtime: "vm", physicalId: "sb_boot_original", generation: 1 },
    imageId: "im_source",
    sourceImage: { scopeKey: scopeKey(scope), name: "snapshot-recovery", imageId: "im_source" },
    managementAuthority: { credentialScope: "user", credentialOwnerId: p.owner },
  };
  await native.reserve(create.operation.id, row);
  let exit: number | null = null;
  let terminations = 0;
  let loseResponse = false;
  let absent = false;
  let wrongApp = false;
  let wrongPhysical = false;
  let failResolution = false;
  let failTags = false;
  let pendingTermination = false;
  let tags = { armada_sandbox: id, armada_scope: scopeKey(scope), armada_generation: "1" };
  const sb = {
    get sandboxId() {
      return wrongPhysical ? "sb_foreign" : row.physicalId;
    },
    getTags: async () => {
      if (failTags) {
        failTags = false;
        throw Error("synthetic tag lookup failure");
      }
      return tags;
    },
    poll: async () => exit,
    terminate: async () => {
      terminations++;
      if (!pendingTermination) exit = 0;
      if (loseResponse) throw Error("synthetic-private-provider-failure");
    },
  } as unknown as Sandbox;
  let allocations = 0;
  const provider = createModalProvider({
    scope,
    store: native,
    appName: "bound-recovery",
    tokenId: "synthetic",
    tokenSecret: "synthetic",
    client: {
      apps: { fromName: async () => ({ appId: wrongApp ? "ap_foreign" : scope.binding.appId }) },
      sandboxes: {
        create: async () => {
          allocations++;
          throw Error("recovery must not allocate");
        },
        fromName: async (_app: string, name: string) => {
          expect(name).toBe(row.physicalName);
          if (absent) throw Object.assign(Error("synthetic absent"), { name: "NotFoundError" });
          return sb;
        },
      },
    } as unknown as ModalClient,
    runner: {
      call: async () => {
        throw Error("recovery must not contact Runner");
      },
    },
    distribution: { capabilities: {} } as RunnerDistribution,
  });
  let providerReads = 0;
  const providers: core.ProviderRegistry = {
    resolve: async (target, caller) => {
      providerReads++;
      if (failResolution) {
        failResolution = false;
        throw Error("synthetic credential lookup failure");
      }
      expect(caller.userId).toBe(p.owner);
      expect(target.modal).toEqual(scope.binding);
      return provider;
    },
  };
  const recover = createOrchestratorCreateRecovery(sql, providers);
  let modelLookups = 0;
  const bundle = createProductionOrchestrators({
    sql,
    providers,
    credentials: {
      resolve: async () => {
        modelLookups++;
        throw Error("no account resolution during recovery");
      },
    },
    connections: undefined,
    encryptionKey: ENCRYPTION_KEY,
    scopedMcpUrl: "https://armada.invalid/api/v1/orchestrator-tools/mcp",
    requestedPairs: ["modal:codex"],
    skillRevision: "a".repeat(40),
  });
  if (!bundle) throw Error("fixture runtime absent");
  const input = {
    id: create.identity.id,
    ownerId: p.owner,
    orgId: p.org,
    expectedRevision: create.operation.revision,
    key: "recover-original",
  };
  return {
    db,
    sql,
    p,
    store,
    native,
    row,
    create,
    recover,
    input,
    provider,
    scope,
    runtime: bundle.runtime,
    modelLookups: () => modelLookups,
    providerReads: () => providerReads,
    wrongApp: () => {
      wrongApp = true;
    },
    wrongPhysical: () => {
      wrongPhysical = true;
    },
    async register(phase: "active" | "stopped", pending: boolean) {
      const saved = await core.createSqlSandboxStore(sql).insert({
        id: row.info.labels.sandbox!,
        provider: "modal",
        providerSandboxId: row.info.id,
        goldenId: golden.id,
        orgId: p.org,
        ownerId: p.owner,
        harness: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        status: "failed",
        visibility: "private",
      });
      if (phase === "stopped")
        await core
          .createSqlSandboxStore(sql)
          .update(saved.id, { status: "stopped", stoppedAt: new Date().toISOString() });
      await sql.query("update orchestrators set sandbox_id=$2,state=$3 where id=$1", [
        create.identity.id,
        saved.id,
        pending ? "creating" : "blocked",
      ]);
      await sql.query("update orchestrator_operations set state=$2 where id=$1", [
        create.operation.id,
        pending ? "pending" : "uncertain",
      ]);
      await sql.query("update sandboxes set orchestrator_native_generation='1' where id=$1", [saved.id]);
      await native.lease(row.info.id, async (current, save) => {
        current.phase = phase;
        if (phase === "stopped") current.recoveryImageId = "im_retained_cleanup";
        await save(current);
      });
      if (phase === "stopped") exit = 0;
      return saved;
    },
    configuration: create.identity.configuration,
    stats: () => ({ terminations, allocations }),
    loseFenceAck: () => {
      loseFenceAck = true;
    },
    failResolution: () => {
      failResolution = true;
    },
    failTags: () => {
      failTags = true;
    },
    pendingTermination: (value: boolean) => {
      pendingTermination = value;
    },
    confirmTerminated: () => {
      exit = 0;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    absent: () => {
      absent = true;
    },
    wrongTags: () => {
      tags = { ...tags, armada_generation: "2" };
    },
  };
}

test.each(["live", "lost-response", "already-terminated"] as const)(
  "exact boot recovery settles old create and replays read-only (initial condition=%s)",
  async (mode) => {
    const f = await fixture();
    try {
      if (mode === "lost-response") f.loseResponse();
      if (mode === "already-terminated") f.confirmTerminated();
      const terminations = mode === "already-terminated" ? 0 : 1;
      const first = await f.recover(f.input);
      expect(first.state).toBe(mode === "lost-response" ? "uncertain" : "succeeded");
      expect(f.stats()).toEqual({ terminations, allocations: 0 });
      const recovered = await f.recover(f.input);
      expect(recovered.id).toBe(first.id);
      expect(recovered.state).toBe("succeeded");
      expect(f.stats()).toEqual({ terminations, allocations: 0 });
      expect((await f.native.get(f.row.info.id)).phase).toBe("deleted");
      expect(await f.store.read(f.p.owner, f.p.org, f.input.id)).toMatchObject({
        state: "stopped",
        sandboxId: null,
        continuity: "unverified",
      });
      expect(
        (await f.sql.query("select state,error_code from orchestrator_operations where id=$1", [f.create.operation.id]))
          .rows,
      ).toEqual([{ state: "failed", error_code: "create_recovered_terminated" }]);
      await expect(f.recover({ ...f.input, expectedRevision: f.input.expectedRevision + 1 })).rejects.toThrow(
        "conflict",
      );
    } finally {
      await f.db.close();
    }
  },
  20_000,
);

test.each([
  "wrong-tags",
  "absent",
  "newer-generation",
  "foreign-owner",
  "removed-member",
  "stale-revision",
  "wrong-app",
  "wrong-physical",
  "wrong-label",
  "preexisting-deleted",
  "missing-reservation",
] as const)(
  "boot recovery refuses unsafe identity or authority (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      if (mode === "wrong-tags") f.wrongTags();
      if (mode === "absent") f.absent();
      if (mode === "wrong-app") f.wrongApp();
      if (mode === "wrong-physical") f.wrongPhysical();
      if (mode === "wrong-label")
        await f.native.lease(f.row.info.id, async (row, save) => {
          row.info.labels = { ...row.info.labels, operation: crypto.randomUUID() };
          await save(row);
        });
      if (mode === "preexisting-deleted")
        await f.native.lease(f.row.info.id, async (row, save) => {
          row.phase = "deleted";
          await save(row);
        });
      if (mode === "missing-reservation") await f.sql.query("delete from modal_machines where id=$1", [f.row.info.id]);
      if (mode === "newer-generation")
        await f.native.lease(f.row.info.id, async (row, save) => {
          row.generation = 2;
          await save(row);
        });
      if (mode === "removed-member")
        await f.sql.query("delete from members where org_id=$1 and user_id=$2", [f.p.org, f.p.owner]);
      if (mode === "foreign-owner" || mode === "removed-member" || mode === "stale-revision")
        await expect(
          f.recover({
            ...f.input,
            ...(mode === "foreign-owner" ? { ownerId: f.p.admin } : {}),
            ...(mode === "stale-revision" ? { expectedRevision: 0 } : {}),
          }),
        ).rejects.toThrow();
      else expect((await f.recover(f.input)).state).toBe("uncertain");
      expect(f.stats()).toEqual({ terminations: 0, allocations: 0 });
      expect(
        (await f.sql.query("select state from orchestrator_operations where id=$1", [f.create.operation.id])).rows,
      ).toEqual([{ state: "uncertain" }]);
    } finally {
      await f.db.close();
    }
  },
  20_000,
);

test("owner HTTP recovery is strict, requires no model account, and replays after a later stop", async () => {
  const f = await fixture();
  try {
    const caller = { userId: f.p.owner, orgs: [{ orgId: f.p.org, role: "member" as const }], via: "supabase" as const };
    const call = (body: unknown) =>
      orchestratorHttp(
        new Request(`https://armada.invalid/api/v1/orchestrators/${f.input.id}/recover`, {
          method: "POST",
          headers: { "idempotency-key": f.input.key, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        caller,
        f.runtime,
      );
    const body = { orgId: f.p.org, expectedRevision: f.input.expectedRevision };
    expect((await call({ ...body, providerSandboxId: f.row.info.id })).status).toBe(400);
    expect(f.stats()).toEqual({ terminations: 0, allocations: 0 });
    const response = await call(body);
    expect(response.status).toBe(202);
    const recovered = (await response.json()) as core.OrchestratorOperation;
    expect(recovered.state).toBe("succeeded");
    expect(f.modelLookups()).toBe(0);
    const stopped = await f.runtime.mutate(caller, {
      orgId: f.p.org,
      id: f.input.id,
      action: "stop",
      key: "stop-after-recovery",
      expectedRevision: recovered.revision,
    });
    expect(stopped.state).toBe("succeeded");
    const reads = f.providerReads();
    expect(await (await call(body)).json()).toEqual(recovered);
    expect(f.providerReads()).toBe(reads);
    expect(f.modelLookups()).toBe(0);
    expect(f.stats()).toEqual({ terminations: 1, allocations: 0 });
  } finally {
    await f.db.close();
  }
}, 20_000);

test.each(["provider-resolution", "native-tags", "native-fence-ack", "unconfirmed-termination"] as const)(
  "manual same-key recovery progresses after %s without a fork or different physical target",
  async (fault) => {
    const f = await fixture();
    try {
      if (fault === "provider-resolution") f.failResolution();
      if (fault === "native-tags") f.failTags();
      if (fault === "native-fence-ack") f.loseFenceAck();
      if (fault === "unconfirmed-termination") f.pendingTermination(true);
      const first = await f.recover(f.input);
      expect(first.state).toBe("uncertain");
      expect(f.stats()).toEqual({ terminations: fault === "unconfirmed-termination" ? 1 : 0, allocations: 0 });
      if (fault === "native-fence-ack") {
        const request = (
          await f.sql.query<{ runtime_result: { request: core.OrchestratorCreateRecoveryRequest } }>(
            "select runtime_result from orchestrator_operations where id=$1",
            [first.id],
          )
        ).rows[0]!.runtime_result.request;
        expect(await f.provider.readOrchestratorCreateRecovery!(request)).toBeNull();
        expect(f.stats().terminations).toBe(0); // The separate observation port never terminates.
      }
      f.pendingTermination(false);
      const result = await f.recover(f.input);
      expect(result).toMatchObject({ id: first.id, state: "succeeded" });
      expect(f.stats()).toEqual({ terminations: fault === "unconfirmed-termination" ? 2 : 1, allocations: 0 });
      expect((await f.native.get(f.row.info.id)).orchestratorCreateRecovery).toMatchObject({
        state: "terminated",
        binding: { physicalId: "sb_boot_original", generation: 1 },
      });
    } finally {
      await f.db.close();
    }
  },
  20_000,
);

test("a lost SQL recovery publication never settles the create until proof publishes, then reuses native proof", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`create function recovery_publication_fault() returns trigger language plpgsql as $$ begin raise exception using errcode='40001',message='synthetic-private-sql'; end $$;
      create trigger recovery_publication_fault before update on orchestrator_operations for each row when (new.action='stop' and new.state='succeeded') execute function recovery_publication_fault()`);
    await expect(f.recover(f.input)).rejects.toMatchObject({ code: "40001" });
    expect(f.stats()).toEqual({ terminations: 1, allocations: 0 });
    expect(
      (await f.sql.query("select state from orchestrator_operations where id=$1", [f.create.operation.id])).rows,
    ).toEqual([{ state: "uncertain" }]);
    await f.db.exec(
      "drop trigger recovery_publication_fault on orchestrator_operations; drop function recovery_publication_fault()",
    );
    expect((await f.recover(f.input)).state).toBe("succeeded");
    expect(f.stats()).toEqual({ terminations: 1, allocations: 0 });
  } finally {
    await f.db.close();
  }
}, 20_000);

test.each(["active", "stopped"] as const)(
  "owner abort recovers a registered legacy pending first create (%s)",
  async (phase) => {
    const f = await fixture();
    try {
      const saved = await f.register(phase, true);
      const result = await f.recover(f.input);
      expect(result.state).toBe("succeeded");
      expect(f.stats()).toEqual({ allocations: 0, terminations: phase === "active" ? 1 : 0 });
      expect(await f.store.read(f.p.owner, f.p.org, f.input.id)).toMatchObject({
        state: "stopped",
        sandboxId: saved.id,
        generation: 1,
        continuity: "unverified",
      });
      expect(
        (await f.sql.query("select state from orchestrator_operations where id=$1", [f.create.operation.id])).rows,
      ).toEqual([{ state: "failed" }]);
      const native = await f.native.get(f.row.info.id);
      expect(native.orchestratorCreateRecovery?.binding.originalSandbox).toEqual({
        sandboxId: saved.id,
        providerSandboxId: f.row.info.id,
        sqlGeneration: "1",
        nativeGeneration: "1",
      });
      expect((await f.sql.query("select status from sandboxes where id=$1", [saved.id])).rows).toEqual([
        { status: "stopped" },
      ]);
      expect(f.modelLookups()).toBe(0);
    } finally {
      await f.db.close();
    }
  },
  20_000,
);

test.each([false, true])(
  "a durable pre-fork owner abort cannot later dispatch a fork (claimed=%s)",
  async (claimed) => {
    const f = await fixture();
    try {
      const queued = await f.store.create({
        ownerId: f.p.owner,
        configuration: { ...f.configuration, name: "cancel queued" },
        key: "cancel-queued-create",
        skillRevision: "a".repeat(40),
        queued: true,
      });
      const job = claimed ? await f.store.claimCreateJob() : null;
      const result = await f.recover({ ...f.input, id: queued.identity.id, key: "abort-queued" });
      expect(result.state).toBe("succeeded");
      const events = (
        await f.sql.query<{ event: { kind: string; operation?: { id: string; state: string }; state?: string } }>(
          "select event from orchestrator_runtime_events where orchestrator_id=$1",
          [queued.identity.id],
        )
      ).rows.map((row) => row.event);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "operation",
          operation: expect.objectContaining({ id: queued.operation.id, state: "failed" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "operation",
          operation: expect.objectContaining({ id: result.id, state: "succeeded" }),
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ kind: "state", state: "stopped" }));
      expect(f.stats()).toEqual({ allocations: 0, terminations: 0 });
      expect(
        (await f.store.operations(f.p.owner, f.p.org, queued.identity.id)).find((p) => p.id === queued.operation.id)
          ?.state,
      ).toBe("failed");
      if (job) await expect(f.store.dispatchCreateFork(job, crypto.randomUUID())).rejects.toThrow("conflict");
      expect((await f.native.get(f.row.info.id)).phase).toBe("booting"); // Unrelated original resource untouched.
    } finally {
      await f.db.close();
    }
  },
  20_000,
);

// Native destructive recovery is distinct from continuity recovery: a failed
// checkpoint must not leave an owned VM running forever, nor invent a session.
test.each([false, true])(
  "owner abort fences the exact uncertain stop (replacement=%s)",
  async (replacement) => {
    const f = await fixture();
    try {
      const registered = await f.register("active", false);
      const conversation = crypto.randomUUID();
      await f.sql.query("update orchestrator_operations set state='succeeded',error_code=null where id=$1", [
        f.create.operation.id,
      ]);
      await f.sql.query("update orchestrators set state='ready' where id=$1", [f.input.id]);
      await f.sql.query("update orchestrator_runtime set conversation_id=$2 where orchestrator_id=$1", [
        f.input.id,
        conversation,
      ]);
      await f.sql.query("update sandboxes set conversation_ids=array[$2] where id=$1", [registered.id, conversation]);
      const stop = await core.reserveOrchestratorOperation(f.sql, {
        orchestratorId: f.input.id,
        actorId: f.p.owner,
        action: "stop",
        key: "failed-stop",
        digest: "a".repeat(64),
        expectedRevision: f.input.expectedRevision,
      });
      await f.sql.query(
        "update orchestrator_operations set state='uncertain',error_code='runtime_uncertain',runtime_result=$2::jsonb where id=$1",
        [stop.id, JSON.stringify({ state: "uncertain" })],
      );
      await f.sql.query("update orchestrators set state='blocked' where id=$1", [f.input.id]);
      await f.native.lease(f.row.info.id, async (row, save) => {
        row.phase = "checkpoint";
        row.orchestratorCheckpoint = {
          receipt: {
            version: 1,
            operationId: stop.id,
            sandboxId: row.info.id,
            physicalGeneration: "1",
            conversationId: conversation,
            nativeSessionId: "native-original",
            harness: "codex",
            model: "gpt-6.1-sol",
            eventWatermark: 1,
            acknowledgedSequence: 1,
            checkpointId: null,
            state: "pending",
          },
        };
        if (replacement) row.generation = 2;
        await save(row);
      });
      const input = { ...f.input, expectedRevision: stop.revision, key: "abort-uncertain-stop" };
      if (replacement) {
        expect((await f.recover(input)).state).toBe("uncertain");
        expect(f.stats()).toEqual({ allocations: 0, terminations: 0 });
        expect((await f.native.get(f.row.info.id)).generation).toBe(2);
        return;
      }
      const recovered = await f.recover(input);
      expect(recovered.state).toBe("succeeded");
      expect(f.stats()).toEqual({ allocations: 0, terminations: 1 });
      expect(f.modelLookups()).toBe(0);
      expect(await f.store.read(f.p.owner, f.p.org, f.input.id)).toMatchObject({
        state: "stopped",
        continuity: "unverified",
      });
      expect(
        (await f.sql.query("select state,error_code from orchestrator_operations where id=$1", [stop.id])).rows,
      ).toEqual([{ state: "failed", error_code: "stop_recovered_terminated" }]);
      expect(
        (await f.sql.query("select state from orchestrator_operations where id=$1", [f.create.operation.id])).rows,
      ).toEqual([{ state: "succeeded" }]);
      expect(await f.recover(input)).toEqual(recovered);
      expect(f.stats().terminations).toBe(1);
      const request = (await f.native.get(f.row.info.id)).orchestratorCreateRecovery!.request;
      const { originalSandbox, ...unregistered } = request;
      await expect(f.provider.readOrchestratorCreateRecovery!(unregistered)).rejects.toMatchObject({
        code: "conflict",
        providerCode: "modal_recovery_binding",
      });
      await expect(
        f.provider.readOrchestratorCreateRecovery!({
          ...request,
          originalSandbox: { ...originalSandbox!, nativeGeneration: "2" },
        }),
      ).rejects.toMatchObject({ code: "conflict", providerCode: "modal_recovery_binding" });
      expect(f.stats().terminations).toBe(1);
    } finally {
      await f.db.close();
    }
  },
  20_000,
);
