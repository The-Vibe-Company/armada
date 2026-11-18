import { expect, test } from "bun:test";
import { type GoldenRecord, modalLaunchSandboxId, type Provider, ProviderError, type Sql } from "@armada/core";
import { createSqlMcpRegistry } from "@armada/core/server";
import { createModalProvider, createSqlModalStore, type RunnerDistribution } from "@armada/provider-modal";
import type { ModalClient } from "modal";
import { controlFailureResponse } from "../src/control-errors.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { createModalBootWorker } from "../src/modal-boot-worker.ts";
import { createOrdinaryLaunchReceipts } from "../src/ordinary-launch-receipts.ts";
import { readStatus } from "../src/turns.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

test.each([
  "restart after an uncertain fork",
  "clean up after membership is revoked before handoff",
  "clean up after the initialization activity lease expires",
  "cancel after stop during initialization",
  "stop before dispatch",
  "publish a terminal failure when admission expires before dispatch",
  "keep an expired boot failed during cleanup",
  "release a fence after a crash before reservation",
  "cancel after boot intent before reservation",
  "fence an expired stop without contacting Modal",
  "fence a stop that expires during authority resolution",
  "fence a stop that expires inside the adapter",
] as const)("Modal boot from committed storage can %s", async (scenario) => {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, args) => db.query(q, args),
    transaction: (work) => db.transaction((tx) => work({ query: (q, args) => tx.query(q, args) })),
  };
  const golden: GoldenRecord = {
    id: crypto.randomUUID(),
    name: "modal",
    orgId: people.org,
    ownerId: people.owner,
    visibility: "private",
    provider: "modal",
    providerSnapshotId: "im-fixture",
    providerSandboxId: "modal-builder",
    modal: { workspace: "ws", environment: "main", appId: "ap-fixture" },
    config: { repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] },
    createdAt: new Date().toISOString(),
  };
  await db.query(
    `insert into goldens (id,org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
      modal_workspace,modal_environment,modal_app_id,config)
      values ($1,$2,$3,$4,'private','modal',$5,$6,'ws','main','ap-fixture',$7::jsonb)`,
    [
      golden.id,
      people.org,
      people.owner,
      golden.name,
      golden.providerSandboxId,
      golden.providerSnapshotId,
      golden.config,
    ],
  );
  const id = crypto.randomUUID();
  const providerSandboxId = modalLaunchSandboxId(id);
  async function persisted() {
    return (
      await db.query(
        `select s.status,s.provider_sandbox_id,r.phase,r.lease_epoch::text,r.fence_id is not null as fenced,
        r.request_enc is not null as sealed
       from sandboxes s join provider_launch_requests r on r.sandbox_id=s.id where s.id=$1`,
        [id],
      )
    ).rows[0];
  }

  let attempts = 0;
  const provider = {
    id: "modal",
    backendIdentity: async () => ({ id: "fixture_backend" }),
    managementIdentity: async () => ({ scope: "user", ownerId: people.owner }),
    async fork(request) {
      expect(request).toMatchObject({ idempotencyKey: id, modalLaunchId: id, env: { EXAMPLE: "fixture_value" } });
      expect(await persisted()).toMatchObject({
        status: "starting",
        provider_sandbox_id: providerSandboxId,
        phase: "booting",
        fenced: true,
        sealed: true,
      });
      if (++attempts === 1) {
        // The real adapter commits an exact-key row before it can lose a
        // create reply. Keep that evidence while this worker fixture stubs Modal.
        await db.query(
          `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
           values('fixture',$1,$2,'private',$3,$4,'{}')`,
          [people.org, people.owner, providerSandboxId, id],
        );
        throw new ProviderError({ provider: "modal", code: "unknown", message: "Lost reply.", retryable: true });
      }
      return { id: providerSandboxId, name: "fixture", labels: {}, state: "ready", providerState: "active" };
    },
  } satisfies Pick<Provider, "id" | "backendIdentity" | "managementIdentity" | "fork"> as Provider;
  const createWorker = () => createModalBootWorker(sql, ENCRYPTION_KEY, async () => provider);
  const first = createWorker();
  const admitted = await first.admit({
    golden,
    provider,
    actor: { orgId: people.org, userId: people.owner, role: "member" },
    runtime: false,
    request: { from: golden.providerSnapshotId!, labels: { sandbox: id }, env: { EXAMPLE: "fixture_value" } },
    sandbox: {
      id,
      provider: "modal",
      providerSandboxId,
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "starting",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      activityLeaseId: crypto.randomUUID(),
    },
  });
  expect(attempts).toBe(0);
  const signal = new AbortController().signal;
  if (scenario === "stop before dispatch") {
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    expect(await createSqlData(sql)(caller).sandboxes.requestPendingModalStop!(id)).toBe(true);
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect(attempts).toBe(0);
    expect(await persisted()).toMatchObject({ phase: "cancelled", status: "stopped", fenced: false, sealed: false });
    expect(
      await createOrdinaryLaunchReceipts(sql).inspect({ orgId: people.org, userId: people.owner }, id, async () => {
        throw Error("A cancelled pre-dispatch launch has no allocations to inspect.");
      }),
    ).toMatchObject({ phase: "cancelled", status: "stopped", outcome: "cancelled", reason: "cancelled_before_boot" });
    return;
  }

  if (scenario === "publish a terminal failure when admission expires before dispatch") {
    await db.query(
      "update provider_launch_requests set dispatch_deadline=now()-interval '1 second' where sandbox_id=$1",
      [id],
    );
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect(attempts).toBe(0);
    expect(await persisted()).toMatchObject({ phase: "failed", status: "failed", fenced: false, sealed: false });
    const store = createSqlData(sql)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    expect(await readStatus(provider, store, (await store.get(id))!, { now: new Date() })).toMatchObject({
      status: "failed",
      providerState: null,
      settled: true,
    });
    return;
  }

  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect(await persisted()).toMatchObject({ phase: "booting", fenced: true, lease_epoch: "1" });
  first.stopAdmission();
  if (
    scenario === "release a fence after a crash before reservation" ||
    scenario === "cancel after boot intent before reservation"
  ) {
    // The first claim persisted boot intent but exited without a Modal reservation.
    const cancelled = scenario === "cancel after boot intent before reservation";
    if (cancelled) {
      const caller = {
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" as const }],
        via: "service" as const,
      };
      expect(await createSqlData(sql)(caller).sandboxes.requestPendingModalStop!(id)).toBe(true);
    } else {
      await db.query(
        "update provider_launch_requests set dispatch_deadline=now()-interval '1 second' where sandbox_id=$1",
        [id],
      );
    }
    await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
    const scope = { orgId: people.org, userId: people.owner, visibility: "private" as const, binding: golden.modal! };
    const adapter = createModalProvider({
      scope,
      store: createSqlModalStore(sql, scope),
      appName: "fixture",
      client: { apps: { fromName: async () => ({ appId: scope.binding.appId }) } } as unknown as ModalClient,
      distribution: {} as RunnerDistribution,
      runner: {
        call: async () => {
          throw new Error("No runner exists.");
        },
      },
    });
    const recovery = createModalBootWorker(sql, ENCRYPTION_KEY, async () => ({
      ...adapter,
      backendIdentity: provider.backendIdentity!,
    }));
    for (const phase of cancelled ? ["cancelled"] : ["cleanup_pending", "failed"]) {
      expect(await recovery.reconcileOne(signal)).toBe(true);
      await recovery.drain();
      expect(await persisted()).toMatchObject({ phase });
    }
    expect(await persisted()).toMatchObject({ status: cancelled ? "stopped" : "failed", fenced: false, sealed: false });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [people.owner]);
    expect((await db.query("select remove_golden($1) as removed_at", [golden.id])).rows[0]).toMatchObject({
      removed_at: expect.any(Date),
    });
    return;
  }
  if (scenario === "keep an expired boot failed during cleanup") {
    await db.query(
      "update provider_launch_requests set dispatch_deadline=now()-interval '1 second',next_attempt_at=now() where sandbox_id=$1",
      [id],
    );
    const successor = createWorker();
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    const store = createSqlData(sql)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const sandbox = (await store.get(id))!;
    const status = await readStatus(
      {
        ...provider,
        async get() {
          return { id: providerSandboxId, name: "fixture", labels: {}, state: "starting", providerState: "creating" };
        },
      },
      store,
      sandbox,
      { now: new Date() },
    );
    expect(status).toMatchObject({ status: "failed", providerState: null });
    return;
  }
  if (scenario.startsWith("fence ")) {
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    expect(await createSqlData(sql)(caller).sandboxes.requestPendingModalStop!(id)).toBe(true);
    const expire = () =>
      db.query("update provider_launch_requests set dispatch_deadline=now()-interval '1 second' where sandbox_id=$1", [
        id,
      ]);
    await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
    const expiredBeforeClaim = scenario === "fence an expired stop without contacting Modal";
    const expiredInsideAdapter = scenario === "fence a stop that expires inside the adapter";
    if (expiredBeforeClaim) await expire();
    let resolutions = 0;
    let deletes = 0;
    let allowRemoval = false;
    const cancelling = createModalBootWorker(sql, ENCRYPTION_KEY, async () => {
      resolutions++;
      if (!expiredInsideAdapter) await expire();
      return {
        ...provider,
        async delete(request, guard) {
          expect(request.sandboxId).toBe(providerSandboxId);
          await expire();
          await guard?.();
          deletes++;
          if (!allowRemoval) throw new Error("Modal removal is uncertain.");
          return { status: "deleted" };
        },
      };
    });
    expect(await cancelling.reconcileOne(signal)).toBe(true);
    await cancelling.drain();
    if (expiredInsideAdapter) {
      // The first claim rejected adapter dispatch. Let the successor observe
      // persisted expiry and publish the fenced outcome.
      await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
      expect(await cancelling.reconcileOne(signal)).toBe(true);
      await cancelling.drain();
    }
    expect(resolutions).toBe(expiredBeforeClaim ? 0 : 1);
    expect(deletes).toBe(0);
    expect(attempts).toBe(1);
    expect(await persisted()).toMatchObject({
      phase: "cleanup_pending",
      status: "stopping",
      fenced: true,
      sealed: true,
    });
    // A role change invalidates admission while the pinned Modal owner still has cleanup access.
    if (expiredBeforeClaim)
      await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.owner]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [people.owner]);
    await expect(db.query("select remove_golden($1)", [golden.id])).rejects.toThrow("unresolved");
    await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
    expect(await cancelling.reconcileOne(signal)).toBe(true);
    await cancelling.drain();
    expect(await persisted()).toMatchObject({ phase: "cleanup_pending", fenced: true, sealed: true });
    allowRemoval = true;
    await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
    expect(await cancelling.reconcileOne(signal)).toBe(true);
    await cancelling.drain();
    expect(deletes).toBe(2);
    expect(attempts).toBe(1);
    expect(await persisted()).toMatchObject({ phase: "cancelled", status: "stopped", fenced: false, sealed: false });
    expect((await db.query("select remove_golden($1) as removed_at", [golden.id])).rows[0]).toMatchObject({
      removed_at: expect.any(Date),
    });
    return;
  }

  await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
  const successor = createWorker();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  let assertInitializing: (() => Promise<void>) | undefined;
  if (scenario === "clean up after membership is revoked before handoff") {
    await db.query("delete from public.members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    const response = await successor.waitForBoot(admitted).catch((error: unknown) => controlFailureResponse(error));
    expect(response).toBeInstanceOf(Response);
    expect(await (response as Response).json()).toMatchObject({
      error: { code: "outcome_unknown", message: expect.stringContaining(id) },
    });
  } else {
    const booted = await successor.waitForBoot(admitted);
    expect(booted).toMatchObject({ id: providerSandboxId, sandbox: { id, status: "starting" } });
    assertInitializing = booted.assertInitializing;
    await assertInitializing!();
  }
  expect(attempts).toBe(2);
  expect(await persisted()).toMatchObject({ status: "starting", phase: "preparing_harness", sealed: true });
  const store = createSqlData(sql)(caller).sandboxes;
  const activity = {
    activityToken: admitted.activityLeaseId,
    expectedGeneration: admitted.record.lifecycleGeneration!,
  };
  if (scenario === "restart after an uncertain fork") {
    expect(await successor.reconcileOne(signal)).toBe(false);
    await db.query(
      `with connection as (
        insert into mcp_connections(org_id,owner_id,scope,name,transport,url,auth_type)
        values($1,$2,'personal','fixture','http','https://upstream.invalid','none') returning id
      ), active_grant as (
        insert into mcp_grants(connection_id,status)
        select id,'connected' from connection returning id,connection_id
      )
      insert into mcp_bindings(sandbox_id,connection_id,grant_id) select $3,connection_id,id from active_grant`,
      [people.org, people.owner, id],
    );
    let installations = 0;
    const mcp = createMcpLifecycle({
      sql,
      registry: createSqlMcpRegistry(sql, ENCRYPTION_KEY),
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://gateway.invalid",
    });
    await mcp.connections.prepare!(
      {
        ...provider,
        async get() {
          return {
            id: providerSandboxId,
            name: "fixture",
            labels: {},
            providerState: "active",
            state: "ready",
            physicalGeneration: "1",
            expiresAt: new Date(Date.now() + 60_000),
          };
        },
        async configureMcp() {
          installations++;
        },
      },
      admitted.record,
      { userId: people.owner, orgId: people.org, role: "member" },
    );
    expect(installations).toBe(1);
    expect(await store.controlState!(id)).toMatchObject({ status: "starting", pendingModalLaunch: true });
    expect(await persisted()).toMatchObject({ phase: "preparing_harness" });
    await store.update(id, { ...activity, finishActivity: true, status: "ready" });
    expect(await successor.reconcileOne(signal)).toBe(false);
    expect(await persisted()).toMatchObject({ status: "ready", phase: "succeeded", fenced: false, sealed: false });
    return;
  }
  const stopped = scenario === "cancel after stop during initialization";
  if (stopped) expect(await store.requestPendingModalStop!(id)).toBe(true);
  if (scenario === "clean up after the initialization activity lease expires")
    await db.query("update public.sandboxes set activity_until=now()-interval '1 second' where id=$1", [id]);
  if (stopped || scenario === "clean up after the initialization activity lease expires") {
    await expect(assertInitializing!()).rejects.toMatchObject({ code: "start_failed" });
    await expect(store.update(id, { ...activity, finishActivity: true, status: "ready" })).rejects.toThrow();
  }
  let deletes = 0;
  const recovery = createModalBootWorker(sql, ENCRYPTION_KEY, async (_target, recoveryCaller) => ({
    ...provider,
    async delete(request, guard) {
      await guard?.();
      expect(request).toEqual({ sandboxId: providerSandboxId, modalLaunchId: id });
      if (scenario === "clean up after membership is revoked before handoff") expect(recoveryCaller.orgs).toEqual([]);
      deletes++;
      return { status: "deleted" };
    },
  }));
  for (const phase of ["cleanup_pending", stopped ? "cancelled" : "failed"]) {
    expect(await recovery.reconcileOne(signal)).toBe(true);
    await recovery.drain();
    expect(await persisted()).toMatchObject({ phase });
  }
  expect(deletes).toBe(1);
  expect(await persisted()).toMatchObject({ status: stopped ? "stopped" : "failed", fenced: false, sealed: false });
});
