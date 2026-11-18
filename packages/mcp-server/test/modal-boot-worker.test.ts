import { expect, test } from "bun:test";
import { type GoldenRecord, modalLaunchSandboxId, type Provider, ProviderError, type Sql } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { createModalBootWorker } from "../src/modal-boot-worker.ts";
import { createOrdinaryLaunchReceipts } from "../src/ordinary-launch-receipts.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

test.each([
  "restart after an uncertain fork",
  "stop before dispatch",
  "fence an expired stop without contacting Modal",
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
      if (++attempts === 1)
        throw new ProviderError({ provider: "modal", code: "unknown", message: "Lost reply.", retryable: true });
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

  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect(await persisted()).toMatchObject({ phase: "booting", fenced: true, lease_epoch: "1" });
  first.stopAdmission();
  if (scenario === "fence an expired stop without contacting Modal") {
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    expect(await createSqlData(sql)(caller).sandboxes.requestPendingModalStop!(id)).toBe(true);
    await db.query(
      "update provider_launch_requests set next_attempt_at=now(),dispatch_deadline=now()-interval '1 second' where sandbox_id=$1",
      [id],
    );
    let attemptedResolution = false;
    const unavailable = createModalBootWorker(sql, ENCRYPTION_KEY, async () => {
      attemptedResolution = true;
      throw Error("Original authority unavailable.");
    });
    expect(await unavailable.reconcileOne(signal)).toBe(true);
    await unavailable.drain();
    expect(attemptedResolution).toBe(false);
    expect(attempts).toBe(1);
    expect(await persisted()).toMatchObject({ phase: "failed", status: "stopping", fenced: true, sealed: true });
    return;
  }

  await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
  const successor = createWorker();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(await successor.waitForBoot(admitted)).toMatchObject({
    id: providerSandboxId,
    sandbox: { id, status: "starting" },
  });
  expect(attempts).toBe(2);
  expect(await persisted()).toMatchObject({
    status: "starting",
    phase: "succeeded",
    lease_epoch: "2",
    fenced: false,
    sealed: false,
  });
});
