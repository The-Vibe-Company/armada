import { expect, spyOn, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import {
  createSqlVaultStore,
  createUsagePricingContext,
  encryptSecret,
  type ProviderTarget,
} from "@armada/core/server";
import {
  createGenerationGrants,
  createSqlModalStore,
  type Machine,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";
import { AppService } from "modal";
import { createSqlData } from "../src/data.ts";
import { createModalIntegration, MODAL_INGEST_PATH } from "../src/modal-integration.ts";
import { createModalReaper } from "../src/modal-reaper.ts";
import { observeRequest } from "../src/request-observability.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

test.each(["claude", "codex"] as const)(
  "server ingest persists %s usage before ACK, replays once and fences old generations",
  async (harness) => {
    const { db, people } = await sharedDatabase();

    const sql = db;
    const scope: Scope = {
      orgId: people.org,
      userId: people.owner,
      visibility: "private",
      binding: { workspace: "ws", appId: "ap-immutable", environment: "main" },
    };
    const machine: Machine = {
      info: { id: "logical", name: "test", state: "ready", providerState: "active", labels: {} },
      phase: "active",
      generation: 1,
      golden: false,
      ttlSeconds: 60,
      physicalName: "physical",
      grantExpiresAt: Date.now() + 60_000,
    };
    await createSqlModalStore(sql, scope).reserve("request", machine);
    await sql.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
      scopeKey(scope),
      JSON.stringify(scope),
    ]);
    const key = new Uint8Array(
      hkdfSync("sha256", Buffer.from(ENCRYPTION_KEY, "base64"), "armada/modal/v1", "runner-generation-grants", 32),
    );
    const grant = createGenerationGrants(key, scope).issue(machine);
    const options = {
      sql,
      vault: createSqlVaultStore(sql),
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
    };
    await sql.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'usage-modal','private','modal','master','image',$3,$4,$5,'{"repos":[],"init":[]}')`,
      [people.org, people.owner, scope.binding.workspace, scope.binding.environment, scope.binding.appId],
    );
    const sessionId = crypto.randomUUID();
    const registerSession = () =>
      sql.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
    select $1,id,$2,$3,'modal',$4,$5,'ready' from goldens where name='usage-modal'`,
        [sessionId, people.org, people.owner, machine.info.id, harness],
      );
    const model = "compatible_model";
    const events = [
      {
        sequence: 1,
        event: { id: "prompt", at: 1, kind: "prompt", promptId: "turn", text: "hello", status: "running" },
      },
      {
        sequence: 2,
        event: {
          id: "usage",
          at: 2,
          kind: "other",
          promptId: "turn",
          type: harness === "claude" ? "result" : "armada/turnUsage",
          data:
            harness === "claude"
              ? { modelUsage: { [model]: { inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 3 } } }
              : { model, inputTokens: 42, outputTokens: 7, cachedTokens: 3 },
        },
      },
      {
        sequence: 3,
        event: { id: "finished", at: 3, kind: "prompt", promptId: "turn", text: "hello", status: "finished" },
      },
    ];
    const readUsage = async () =>
      (
        await createSqlData(sql)({
          userId: people.owner,
          orgs: [{ orgId: people.org, role: "member" }],
          via: "service",
        }).sandboxes.get(sessionId)
      )?.usage;
    const request = () =>
      new Request(`https://armada.test${MODAL_INGEST_PATH}`, {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify({
          sandboxId: machine.info.id,
          generation: "1",
          events,
        }),
      });
    const first = await createModalIntegration(options);
    expect((await first.route(request()))?.status).toBe(403);
    expect((await sql.query("select * from modal_events")).rows).toHaveLength(0);
    await registerSession();
    const account = crypto.randomUUID();
    await createSqlData(sql)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes.recordUsagePricingContext!(
      sessionId,
      createUsagePricingContext({
        harness,
        credentialKind: harness === "claude" ? "claude_oauth" : "openai",
        credentialId: account,
        credentialVersion: 1,
        customEndpoint: true,
      }),
    );
    expect((await first.route(request()))?.status).toBe(200);
    expect((await readUsage())?.tokenTotals).toMatchObject({ inputTokens: 42, outputTokens: 7, cachedTokens: 3 });
    expect((await readUsage())?.turns).toMatchObject([{ model, inputTokens: 42 }]);
    const restarted = await createModalIntegration(options);
    const replay = await restarted.route(request());
    expect(await replay?.json()).toEqual({ acknowledgedSequence: 3 });
    expect((await readUsage())?.tokenTotals?.inputTokens).toBe(42);
    expect(
      (
        await sql.query("select trim_scale(usd)::text as usd, unpriced_turns from account_spend where account_id=$1", [
          account,
        ])
      ).rows,
    ).toEqual(harness === "claude" ? [] : [{ usd: "0", unpriced_turns: 1 }]);
    expect((await sql.query("select * from modal_events")).rows).toHaveLength(3);
    await sql.query("update modal_machines set record=jsonb_set(record,'{generation}','2') where id='logical'");
    expect((await restarted.route(request()))?.status).toBe(403);
    expect(await restarted.route(new Request("https://armada.test/api/internal/modal/events-extra"))).toBeNull();
  },
);

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
    await createSqlModalStore(db, scope).reserve("stored-private", machine);
    // A stored read reaches only Armada's database: the request records itself, never a Modal call.
    const records: { event: string }[] = [];
    let reader!: Awaited<ReturnType<typeof integration.storedProviderFor>>;
    await observeRequest(
      async () => {
        reader = await integration.storedProviderFor(target, caller);
        expect(await reader.get(machine.info.id)).toMatchObject({ id: machine.info.id, state: "ready" });
        return Response.json({});
      },
      (line) => records.push(JSON.parse(line)),
    );
    expect(records.map((record) => record.event)).toEqual(["http_request"]);
    expect(() => reader.stop({ sandboxId: machine.info.id })).toThrow(
      "Stored observations cannot perform live operations",
    );
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

test("org ingest uses each machine owner, not the first scope registrant, across membership revocation", async () => {
  const { db, people } = await sharedDatabase();

  const binding = { workspace: "ws", appId: "ap-org", environment: "main" };
  const first: Scope = { orgId: people.org, userId: people.admin, visibility: "org", binding };
  const owner: Scope = { ...first, userId: people.owner };
  const machine: Machine = {
    info: { id: "member-machine", name: "member", state: "ready", providerState: "active", labels: {} },
    launchUserId: people.owner,
    phase: "active",
    generation: 1,
    golden: false,
    ttlSeconds: 60,
    physicalName: "physical",
    grantExpiresAt: Date.now() + 60_000,
  };
  await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
    scopeKey(first),
    JSON.stringify(first),
  ]);
  await createSqlModalStore(db, owner).reserve("member-launch", machine);
  const key = new Uint8Array(
    hkdfSync("sha256", Buffer.from(ENCRYPTION_KEY, "base64"), "armada/modal/v1", "runner-generation-grants", 32),
  );
  const token = createGenerationGrants(key, owner).issue(machine).token;
  const server = await createModalIntegration({
    sql: db,
    vault: createSqlVaultStore(db),
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: "https://armada.test",
  });
  const send = (sequence: number) =>
    server.route(
      new Request(`https://armada.test${MODAL_INGEST_PATH}`, {
        method: "POST",
        headers: { "x-armada-runner-grant": token },
        body: JSON.stringify({
          sandboxId: machine.info.id,
          generation: "1",
          events: [{ sequence, event: { id: `e${sequence}`, at: sequence, kind: "text", text: "event" } }],
        }),
      }),
    );
  await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.owner]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.admin]);
  expect((await send(1))?.status).toBe(200);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [people.org, people.admin]);
  await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
  expect((await send(2))?.status).toBe(403);
  expect((await db.query("select producer_sequence from modal_events")).rows).toEqual([{ producer_sequence: 1 }]);
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
