import { expect, test } from "bun:test";
import { encryptSecret, type GoldenActor } from "@armada/core/server";
import { type Scope, scopeKey } from "@armada/provider-modal";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { fakeBoat } from "./support.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const GOLDEN = "44444444-4444-4444-8444-444444444444";
const SANDBOX = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const KEY = Buffer.alloc(32, 8).toString("base64");
const native = (revision: number, accountId = "native-account") =>
  JSON.stringify({
    tokens: {
      access_token: `synthetic-access-${revision}`,
      refresh_token: `synthetic-refresh-${revision}`,
      account_id: accountId,
    },
  });

test("real native state publication seals rotation without replacing binding, fences source changes and rejects other owners", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values($1),($2)", [OWNER, PEER]);
    await db.query("insert into orgs(id,name) values($1,'Native state')", [ORG]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
      ORG,
      OWNER,
      PEER,
    ]);
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [OWNER, await encryptSecret(native(0), KEY)],
      )
    ).rows[0];
    if (!account) throw Error("No account fixture");
    let authJson = native(1),
      reads = 0;
    let onRead: (() => Promise<void>) | undefined;
    const auth = createModelAuthOwnership(db, KEY, async () => {
      reads++;
      await onRead?.();
      return authJson;
    });
    const actor: GoldenActor = { userId: OWNER, orgId: ORG, role: "admin" };
    await auth.claim(actor, account.id, 1, SANDBOX); // Before public sandbox INSERT/fork.
    await auth.releaseUnallocated(account.id, 1, SANDBOX);
    expect(await auth.managed(SANDBOX)).toBe(false);
    await auth.claim(actor, account.id, 1, SANDBOX);
    await expect(auth.claim(actor, account.id, 1, OTHER)).rejects.toMatchObject({ code: "conflict" });
    await db.query(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'native','org',$4::jsonb)",
      [
        GOLDEN,
        ORG,
        OWNER,
        JSON.stringify({ repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] }),
      ],
    );
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,
      visibility,credential_id,credential_version) values($1,$2,$3,$4,'codex','ready','native','native','org',$5,1)`,
      [SANDBOX, ORG, OWNER, GOLDEN, account.id],
    );
    const provider = fakeBoat().provider;
    provider.get = async (id) => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
    await auth.capture(provider, "native", actor);
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(1), revision: 1 });
    expect((await db.query("select version from credentials where id=$1", [account.id])).rows).toEqual([
      { version: 1 },
    ]);
    const stored = (await db.query<{ state_enc: Uint8Array }>("select state_enc from model_auth_state")).rows[0];
    expect(Buffer.from(stored?.state_enc ?? []).toString()).not.toContain("synthetic-refresh");
    await auth.capture(provider, "native", actor); // ACK/retry of identical state is idempotent.
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toHaveProperty("revision", 1);
    await expect(
      auth.state.publish({
        actor,
        accountId: account.id,
        version: 1,
        sandboxId: SANDBOX,
        generation: "boat:1",
        expectedRevision: 0,
        authJson: native(2),
        verifySource: async () => {},
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(1), revision: 1 });
    authJson = native(2);
    onRead = async () => {
      onRead = undefined;
      await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [SANDBOX]);
    };
    const before = reads;
    await expect(auth.capture(provider, "native", actor)).rejects.toMatchObject({ code: "conflict" });
    expect(reads - before).toBe(3); // Bound retries; never publish the old incarnation.
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toHaveProperty("authJson", native(1));
    await auth.capture(provider, "native", actor);
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(2), revision: 2 });
    await expect(auth.state.read({ ...actor, userId: PEER }, account.id, 1, SANDBOX)).rejects.toMatchObject({
      code: "not_found",
    });
    await db.query("delete from members where org_id=$1 and user_id=$2", [ORG, OWNER]);
    await expect(auth.state.read(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "not_found" });
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [ORG, OWNER]);
    await db.query("update credentials set value_enc=$2 where id=$1", [
      account.id,
      await encryptSecret(native(9), KEY),
    ]);
    await expect(auth.state.read(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "not_found" });
    await auth.assertSandbox(actor, SANDBOX, false, true);
    authJson = native(3);
    expect(await auth.capture(provider, "native", actor)).toContain("synthetic-refresh-3");
    await expect(auth.state.read(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "not_found" });
    await expect(auth.claim(actor, account.id, 2, OTHER)).rejects.toMatchObject({ code: "conflict" });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [SANDBOX]);
    await auth.claim(actor, account.id, 2, OTHER);
    expect(await auth.state.read(actor, account.id, 2, OTHER)).toMatchObject({ authJson: native(9), revision: 0 });
  } finally {
    await db.close();
  }
});

test("Modal private publication binds current app, native generation and account revision; ACK retries are safe", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values($1)", [OWNER]);
    await db.query("insert into orgs(id,name) values($1,'Native modal')", [ORG]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [ORG, OWNER]);
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [OWNER, await encryptSecret(native(0), KEY)],
      )
    ).rows[0];
    if (!account) throw Error("No account fixture");
    const time = 1_800_000_000_000;
    const auth = createModelAuthOwnership(db, KEY, undefined, () => time);
    const actor: GoldenActor = { userId: OWNER, orgId: ORG, role: "admin" };
    await auth.claim(actor, account.id, 1, SANDBOX);
    const scope: Scope = {
      orgId: ORG,
      userId: OWNER,
      visibility: "org",
      binding: { workspace: "workspace", environment: "main", appId: "ap_native" },
    };
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,config,provider,
      modal_workspace,modal_environment,modal_app_id)
      values($1,$2,$3,'native','org',$4::jsonb,'modal','workspace','main','ap_native')`,
      [
        GOLDEN,
        ORG,
        OWNER,
        JSON.stringify({ repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] }),
      ],
    );
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider,
      provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
      values($1,$2,$3,$4,'codex','ready','modal','native',null,'org',$5,1)`,
      [SANDBOX, ORG, OWNER, GOLDEN, account.id],
    );
    await db.query(
      `insert into modal_machines(scope,id,org_id,owner_id,visibility,request_key,record)
      values($1,'native',$2,$3,'org','native-state-fixture',$4::jsonb)`,
      [scopeKey(scope), ORG, OWNER, JSON.stringify({ generation: 1, launchUserId: OWNER })],
    );
    const claims = { sandboxId: "native", generation: "1", expiresAt: time + 1000 };
    expect(await auth.publishFromModal(scope, claims, native(1), 0)).toEqual({ authRevision: 1, committed: true });
    await db.query("update modal_machines set record=jsonb_set(record,'{generation}','2') where id='native'");
    await expect(auth.publishFromModal(scope, claims, native(2), 1)).rejects.toMatchObject({ code: "forbidden" });
    const current = { ...claims, generation: "2" };
    expect(await auth.publishFromModal(scope, current, native(2), 1)).toEqual({ authRevision: 2, committed: true });
    expect(await auth.publishFromModal(scope, current, native(2), 1)).toEqual({ authRevision: 2, committed: true });
    await expect(
      auth.publishFromModal({ ...scope, binding: { ...scope.binding, appId: "ap_wrong" } }, current, native(3), 2),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(auth.publishFromModal(scope, { ...current, expiresAt: time }, native(2), 2)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(2), revision: 2 });
    await db.query("update credentials set value_enc=$2 where id=$1", [
      account.id,
      await encryptSecret(native(9), KEY),
    ]);
    expect(await auth.publishFromModal(scope, current, native(3), 2)).toEqual({
      authRevision: 2,
      committed: true,
      discarded: true,
    });
    expect((await db.query("select auth_revision from model_auth_state")).rows).toEqual([{ auth_revision: 2 }]);
  } finally {
    await db.close();
  }
});
