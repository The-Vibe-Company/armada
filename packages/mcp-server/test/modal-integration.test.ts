import { expect, spyOn, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, type ProviderTarget } from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { AppService } from "modal";
import { createSqlData } from "../src/data.ts";
import { createModalIntegration } from "../src/modal-integration.ts";
import { createModalReaper } from "../src/modal-reaper.ts";
import { observeRequest } from "../src/request-observability.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

test("private image org-fallback provenance survives adding a personal key, rotation and removal", async () => {
  const { db, people } = await sharedDatabase();
  const apps = spyOn(AppService.prototype, "fromName").mockImplementation(async () => {
    throw new Error("Stored observations must not perform SDK App lookups");
  });
  try {
    const binding = { workspace: "app:ap-org", appId: "ap-org", environment: "main" };
    await db.query(
      "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'org',$1,'org-app',$3,'main')",
      [people.org, `org:${people.org}`, binding.appId],
    );
    const pair = (suffix: string) => ({
      token_id: `ak-organization${suffix}`,
      token_secret: `as-organization${suffix}`,
    });
    async function orgCredential(suffix: string) {
      await db.query(
        "insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'modal',$2) on conflict(scope,owner_id,kind) where kind in ('boat','modal') do update set value_enc=excluded.value_enc",
        [people.org, await encryptSecret(JSON.stringify(pair(suffix)), ENCRYPTION_KEY)],
      );
    }
    await orgCredential("original");
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'modal',$2)", [
      people.owner,
      await encryptSecret(JSON.stringify({ token_id: "ak-personal", token_secret: "as-personal" }), ENCRYPTION_KEY),
    ]);
    const integration = await createModalIntegration({
      sql: db,
      vault: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
    });
    const target: ProviderTarget = {
      provider: "modal",
      orgId: people.org,
      visibility: "private",
      sourceGoldenVisibility: "private",
      modal: binding,
    };
    const caller = { userId: people.owner };
    const scope: Scope = { orgId: people.org, userId: people.owner, visibility: "private", binding };
    const machine: Machine = {
      info: { id: "stored-private", name: "private", state: "ready", providerState: "active", labels: {} },
      phase: "active",
      generation: 1,
      golden: false,
      ttlSeconds: 60,
      physicalName: "private",
      managementAuthority: { credentialScope: "org", credentialOwnerId: people.org },
      sourceImage: { scopeKey: scopeKey(scope), name: "source", imageId: "im-source" },
    };
    await db.query(
      "insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record) values($1,$2,$3,'private',$4,$5,$6::jsonb)",
      [scopeKey(scope), scope.orgId, scope.userId, machine.info.id, "stored-private", JSON.stringify(machine)],
    );
    // A stored read reaches only Armada's database: the request records itself, never a Modal call.
    const records: { event: string }[] = [];
    await observeRequest(
      async () => {
        const tokens = await integration.modalTokensFor(target, caller);
        const { provider } = await integration.modalProviderFor(
          { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
          binding,
          { target, caller, credentialScope: tokens.scope },
          true,
        );
        expect(await provider.get(machine.info.id)).toMatchObject({ id: machine.info.id, state: "ready" });
        return Response.json({});
      },
      (line) => records.push(JSON.parse(line)),
    );
    expect(records.map((record) => record.event)).toEqual(["http_request"]);
    expect(apps).not.toHaveBeenCalled();
    expect(await integration.modalTokensFor(target, caller)).toEqual({
      tokenId: pair("original").token_id,
      tokenSecret: pair("original").token_secret,
      scope: "org",
    });
    await orgCredential("rotated");
    expect((await integration.modalTokensFor(target, caller)).tokenId).toBe(pair("rotated").token_id);
    await db.query("delete from credentials where scope='org' and owner_id=$1 and kind='modal'", [people.org]);
    await expect(integration.modalTokensFor(target, caller)).rejects.toMatchObject({ code: "missing_credential" });
  } finally {
    apps.mockRestore();
  }
});

test("scoped golden CAS supports NULL masters without broadening private-owner or live membership authority", async () => {
  const { db, people } = await sharedDatabase();

  await db.query(
    `insert into goldens(org_id,name,visibility,owner_id,provider,provider_snapshot_id,
      modal_workspace,modal_environment,modal_app_id,config)
      select org_id,'private-modal','private',owner_id,'modal','last-good','ws','main','ap-bound',config
      from goldens where name='mine' and owner_id=$1`,
    [people.owner],
  );
  const source = createSqlData(db);
  const scoped = (userId: string) =>
    source({ userId, orgs: [{ orgId: people.org, role: "admin" }], via: "supabase" }).goldens;
  const owner = scoped(people.owner);
  const [golden] = await owner.findByName(people.org, "private-modal");
  expect(golden?.providerSandboxId).toBeNull();
  expect(await scoped(people.admin).replaceSandbox!(golden!.id, null, golden!.providerSnapshotId!, "stolen")).toBe(
    false,
  );
  expect(await owner.replaceSandbox!(golden!.id, null, golden!.providerSnapshotId!, "restored-private")).toBe(true);
  expect(await owner.replaceSandbox!(golden!.id, null, golden!.providerSnapshotId!, "late-loser")).toBe(false);
  expect(await owner.recordSnapshot!(golden!.id, "wrong-master", "invalid-publication")).toBe(false);
  expect(
    await scoped(people.admin).compareAndSetSnapshot!(
      golden!.id,
      golden!.providerSnapshotId!,
      "stolen-image",
      "restored-private",
    ),
  ).toBe(false);
  expect(
    await owner.compareAndSetSnapshot!(golden!.id, golden!.providerSnapshotId!, "new-image", "restored-private"),
  ).toBe(true);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
  expect(await owner.replaceSandbox!(golden!.id, null, "new-image", "revoked")).toBe(false);
  const row = (
    await db.query<{ provider_sandbox_id: string | null; provider_snapshot_id: string }>(
      "select provider_sandbox_id,provider_snapshot_id from goldens where id=$1",
      [golden!.id],
    )
  ).rows[0];
  expect(row).toEqual({ provider_sandbox_id: null, provider_snapshot_id: "new-image" });
});

test("the Modal reaper only terminates unreferenced VMs and retries a failed termination on the next sweep", async () => {
  const { db, people } = await sharedDatabase();
  const binding = { workspace: "app:ap-inventory", appId: "ap-inventory", environment: "main" };
  await db.query(
    `insert into public.modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment)
     values ($1,'org:inventory','org',$1,'inventory',$2,$3)`,
    [people.org, binding.appId, binding.environment],
  );
  await db.query(
    `insert into public.goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
                               modal_workspace,modal_environment,modal_app_id,config)
     values ($1,$2,'inventory','org','modal','builder','image',$3,$4,$5,'{"repos":[],"init":[]}')`,
    [people.org, people.owner, binding.workspace, binding.environment, binding.appId],
  );
  await db.query(
    `insert into public.sandboxes(golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
     select id,org_id,owner_id,'modal','admitted','claude','ready' from public.goldens where name='inventory'`,
  );
  const scope: Scope = { orgId: people.org, userId: people.owner, visibility: "org", binding };
  await createSqlModalStore(db, scope).reserve("inventory-reservation", {
    info: { id: "admitted", name: "inventory", state: "ready", providerState: "active", labels: {} },
    phase: "active",
    generation: 1,
    golden: false,
    ttlSeconds: 60,
    physicalId: "physical-admitted",
    physicalName: "test",
    grantExpiresAt: 0,
  });

  await db.query("insert into public.modal_server_scopes(scope,context) values($1,$2::jsonb)", [
    scopeKey(scope),
    JSON.stringify({ binding }),
  ]);
  const receiptId = crypto.randomUUID();
  await db.query(
    `insert into public.ordinary_launch_receipts(id,org_id,owner_id,request_key,fingerprint)
     values ($1,$2,$3,'pending-inventory-receipt','fingerprint')`,
    [receiptId, people.org, people.owner],
  );
  for (const [logicalId, physicalId, key] of [
    ["pending-admission", "physical-pending", receiptId],
    ["leased-admission", "physical-leased", "leased-inventory-request"],
  ] as const) {
    await createSqlModalStore(db, scope).reserve(key, {
      info: { id: logicalId, name: "inventory", state: "starting", providerState: "booting", labels: {} },
      phase: "booting",
      generation: 1,
      golden: false,
      ttlSeconds: 3600,
      physicalId,
      physicalName: logicalId,
      grantExpiresAt: 0,
    });
  }
  await db.query("update public.modal_machines set lease_until='infinity' where id='leased-admission'");
  const logs: unknown[] = [];
  const terminated: string[] = [];
  let now = 16 * 60_000;
  let retry = false;
  let lateAdmission = false;
  const lane = createModalReaper(
    {
      async query<T>(statement: string, params?: unknown[]) {
        const result = await db.query<T>(statement, params);
        if (!lateAdmission && params?.[0] === "late-admission") {
          lateAdmission = true;
          await db.query(
            `insert into public.sandboxes(golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
             select id,org_id,owner_id,'modal','late-admission','claude','ready' from public.goldens where name='inventory'`,
          );
        }
        return result;
      },
    },
    "https://armada.test",
    async (registration, target, deploymentId) => {
      expect(registration.authority_owner_id).toBe(people.org);
      expect(target).toEqual(binding);
      const base = { deploymentId, generation: "1", createdAt: new Date(0) };
      return {
        async openSandbox(machineId) {
          return {
            async terminate() {
              terminated.push(machineId);
              if (retry) throw Object.assign(new Error("gone"), { name: "ClientError", code: 5 });
            },
            async waitForTermination() {
              throw new Error("termination observation timed out");
            },
          };
        },
        async *listInventory() {
          if (!retry) yield { ...base, sandboxId: "late-admission", machineId: "physical-late" };
          yield { ...base, sandboxId: "pending-admission", machineId: "physical-pending" };
          yield { ...base, sandboxId: "leased-admission", machineId: "physical-leased" };
          yield { ...base, sandboxId: "conflicting-tag", machineId: "physical-admitted" };
          yield { ...base, sandboxId: "admitted", machineId: "physical-current" };
          yield { ...base, sandboxId: "lost-admission", machineId: "physical-orphan" };
        },
      };
    },
    { log: (line) => logs.push(JSON.parse(line)), now: () => now },
  );

  const signal = new AbortController().signal;
  await lane.reconcileOne(signal);
  expect(terminated).toEqual(["physical-orphan"]);
  expect(logs).toContainEqual(expect.objectContaining({ event: "provider_reaper_retry", errors: 1 }));
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "provider_reaper_delete",
      outcome: "submitted",
      machineId: "physical-orphan",
    }),
  );
  retry = true;
  now += 60_000;
  await lane.reconcileOne(signal);
  expect(terminated).toEqual(["physical-orphan", "physical-orphan"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "provider_reaper_delete",
      outcome: "confirmed",
      machineId: "physical-orphan",
      ageMs: now,
    }),
  );
  expect(logs).toContainEqual({
    metric: "reaper_unknown_machines",
    provider: "modal",
    source: binding.appId,
    count: 3,
    overdue: 3,
    complete: true,
  });
});
