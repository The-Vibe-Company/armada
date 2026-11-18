import { expect, test } from "bun:test";
import { type GoldenRecord, modalLaunchSandboxId, type Provider, ProviderError, type Sql } from "@armada/core";
import { createModalBootWorker } from "../src/modal-boot-worker.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

test("a successor boots the committed Modal sandbox with the same key after an uncertain fork", async () => {
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
      if (++attempts === 1) throw new ProviderError({ provider: "modal", code: "unknown", message: "Lost reply." });
      return { id: providerSandboxId, name: "fixture", labels: {}, state: "ready", providerState: "active" };
    },
  } satisfies Pick<Provider, "id" | "backendIdentity" | "managementIdentity" | "fork"> as Provider;
  const createWorker = () => createModalBootWorker(sql, ENCRYPTION_KEY, async () => provider);
  const first = createWorker();
  await first.admit({
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
  expect(await first.reconcileOne(signal)).toBe(true);
  expect(await persisted()).toMatchObject({ phase: "booting", fenced: true, lease_epoch: "1" });
  first.stopAdmission();
  await db.query("update provider_launch_requests set next_attempt_at=now() where sandbox_id=$1", [id]);
  expect(await createWorker().reconcileOne(signal)).toBe(true);
  expect(attempts).toBe(2);
  expect(await persisted()).toMatchObject({
    status: "starting",
    phase: "succeeded",
    lease_epoch: "2",
    fenced: false,
    sealed: false,
  });
});
