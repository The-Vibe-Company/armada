import { expect, spyOn, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import { createSqlVaultStore, encryptSecret, type ProviderTarget } from "@armada/core/server";
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
import { database, ENCRYPTION_KEY } from "./support.ts";

test("server ingest survives restart, commits once in SQL, and fences the previous generation", async () => {
  const { db, people } = await database();
  try {
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
    const request = () =>
      new Request(`https://armada.test${MODAL_INGEST_PATH}`, {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify({
          sandboxId: machine.info.id,
          generation: "1",
          events: [{ sequence: 1, event: { id: "e1", at: 1, kind: "text", text: "hello" } }],
        }),
      });
    const first = await createModalIntegration(options);
    expect((await first.route(request()))?.status).toBe(200);
    const restarted = await createModalIntegration(options);
    const replay = await restarted.route(request());
    expect(await replay?.json()).toEqual({ acknowledgedSequence: 1 });
    expect((await sql.query("select * from modal_events")).rows).toHaveLength(1);
    await sql.query("update modal_machines set record=jsonb_set(record,'{generation}','2') where id='logical'");
    expect((await restarted.route(request()))?.status).toBe(403);
    expect(await restarted.route(new Request("https://armada.test/api/internal/modal/events-extra"))).toBeNull();
  } finally {
    await db.close();
  }
});

test("private image org-fallback provenance survives adding a personal key, rotation and removal", async () => {
  const { db, people } = await database();
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
      info: { id: "stored-private", name: "private", state: "ready", labels: {} },
      phase: "active",
      generation: 1,
      golden: false,
      ttlSeconds: 60,
      physicalName: "private",
      managementAuthority: { credentialScope: "org", credentialOwnerId: people.org },
      sourceImage: { scopeKey: scopeKey(scope), name: "source", imageId: "im-source" },
    };
    await createSqlModalStore(db, scope).reserve("stored-private", machine);
    const reader = await integration.storedProviderFor(target, caller);
    expect(await reader.get(machine.info.id)).toMatchObject({ id: machine.info.id, state: "ready" });
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
    await db.close();
  }
});

test("org ingest uses each machine owner, not the first scope registrant, across membership revocation", async () => {
  const { db, people } = await database();
  try {
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
  } finally {
    await db.close();
  }
});

test("scoped golden CAS supports NULL masters without broadening private-owner or live membership authority", async () => {
  const { db, people } = await database();
  try {
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
  } finally {
    await db.close();
  }
});
