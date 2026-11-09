import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, type GoldenActor } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { type Scope, scopeKey } from "@armada/provider-modal";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { call, ENCRYPTION_KEY, fakeBoat, harness } from "./support.ts";

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
    const resolver = launchCredentials(createSqlVaultStore(db), KEY, undefined, auth);
    const credentials = await resolver.resolve(actor, "codex", account.id, 1);
    expect(credentials).toMatchObject({ binding: { credentialId: account.id, credentialVersion: 1 } });
    await resolver.admit!(actor, credentials, SANDBOX); // Actual resolver-to-ownership pipeline before allocation.
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
    let eventRevision = 2;
    const publicProvider = createBoatProvider({
      apiKey: "synthetic-boat-key",
      fetch: (async () =>
        Response.json({
          events: [
            {
              id: "native-output",
              timestamp: 7,
              type: "response",
              data: {
                content: `synthetic-refresh-${eventRevision}`,
                tools: [
                  {
                    use: { id: "t", name: "read", input: { old: "synthetic-refresh-1" } },
                    result: { content: [{ text: "synthetic-access-2" }] },
                  },
                ],
              },
            },
          ],
          pageInfo: { hasMore: false },
        })) as unknown as typeof fetch,
      sanitizeEvents: (_provider, id, events) => auth.redactEvents(provider, id, actor, events),
    });
    const safeEvents = await publicProvider.events({ sandboxId: "native" });
    expect(JSON.stringify(safeEvents)).not.toContain("synthetic-refresh-");
    expect(JSON.stringify(safeEvents)).not.toContain("synthetic-access-");
    expect(safeEvents.events[0]).toMatchObject({ id: "native-output", kind: "message", text: "***" });
    // The activity lease is an independent storage contract shared with stop:
    // event bodies cannot escape while a native-file-mutating command is in flight.
    await db.query(
      "update sandboxes set activity_lease_id=$2::uuid,activity_until=now()+interval '2 minutes' where id=$1",
      [SANDBOX, OTHER],
    );
    await expect(publicProvider.events({ sandboxId: "native" })).rejects.toMatchObject({ code: "unavailable" });
    await db.query("update sandboxes set activity_lease_id=null,activity_until=null where id=$1", [SANDBOX]);
    // Auto-archive after a rotation may leave only a stale encrypted sample.
    // It is not a durable quiescence receipt and must not release unseen output.
    eventRevision = 3;
    provider.get = async (id) => ({ id, name: id, state: "stopped", providerState: "archived", labels: {} });
    await expect(publicProvider.events({ sandboxId: "native" })).rejects.toMatchObject({ code: "unavailable" });
    eventRevision = 2;
    provider.get = async (id) => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
    // Storage policy accepts only the server's quiesced-capture purpose. The
    // real SSH lock/process receipt is independently exercised by native-cwd.
    await auth.capture(provider, "native", actor, true);
    provider.get = async (id) => ({ id, name: id, state: "stopped", providerState: "archived", labels: {} });
    expect(JSON.stringify(await publicProvider.events({ sandboxId: "native" }))).not.toContain("synthetic-refresh-");
    // Pre-exec may resume for inspection using the known registry, but invalidates
    // that old stop proof before any command could mutate the native file.
    expect(await resolver.nativeSecrets!(actor, SANDBOX, provider, "native", "before")).toContain(
      "synthetic-refresh-2",
    );
    await expect(publicProvider.events({ sandboxId: "native" })).rejects.toMatchObject({ code: "unavailable" });
    provider.get = async (id) => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
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
    // Explicit replacement fences model billing, not safe shell inspection of
    // the prior workspace. Its rotated leaves remain redaction-only.
    await auth.assertSandbox(actor, SANDBOX, false, true);
    await expect(auth.assertSandbox(actor, SANDBOX, true)).rejects.toMatchObject({ code: "not_found" });
    expect(await auth.capture(provider, "native", actor)).toContain("synthetic-refresh-3");
    await expect(auth.state.read(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "not_found" });
    expect(await auth.state.read(actor, account.id, 2, OTHER)).toMatchObject({ authJson: native(9), revision: 0 });
    provider.get = async (id) => ({ id, name: id, state: "stopped", providerState: "archived", labels: {} });
    // Retired tokens still protect historical provider events, without resuming
    // old compute or authorizing that old binding to hydrate a new writer.
    await expect(publicProvider.events({ sandboxId: "native" })).rejects.toMatchObject({ code: "unavailable" });
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

// Actual MCP exec/controller + shared SQL lease. SSH is a private transport peer;
// encryption, publication, lifecycle admission and redaction remain real owners.
test("managed exec holds stop admission through secret publication while independent accounts stay parallel", async () => {
  let ownership!: ReturnType<typeof createModelAuthOwnership>;
  const nativeBySandbox = new Map<string, string>();
  const server = await harness({
    modelAuth: (db) => {
      ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, async (_provider, id) => {
        const value = nativeBySandbox.get(id);
        if (!value) throw Error("Missing private transport fixture");
        return value;
      });
      return ownership;
    },
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let pending: ReturnType<typeof call> | undefined;
  try {
    const actor: GoldenActor = { userId: server.people.owner, orgId: server.people.org, role: "member" };
    const create = async (identity: string) => {
      const id = crypto.randomUUID();
      const account = (
        await server.db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [actor.userId, await encryptSecret(native(0, identity), ENCRYPTION_KEY)],
        )
      ).rows[0]!;
      await ownership.claim(actor, account.id, 1, id);
      const machine = await server.boat.provider.fork({
        from: "fixture-snapshot",
        noEnv: true,
        env: {},
        labels: {},
        ttlSeconds: 3600,
      });
      nativeBySandbox.set(machine.id, native(0, identity));
      await server.db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
         select $1,$2,$3,g.id,'codex','ready',$4,$4,'org',$5,1 from goldens g where g.org_id=$2 and g.name='shared'`,
        [id, actor.orgId, actor.userId, machine.id, account.id],
      );
      return { id, physical: machine.id, accountId: account.id };
    };
    const first = await create("held-native-account");
    const second = await create("independent-native-account");
    const originalExec = server.boat.provider.exec;
    server.boat.provider.exec = async (request) => {
      if (request.command !== "held-native-inspection") return originalExec(request);
      started();
      await gate;
      nativeBySandbox.set(first.physical, native(1, "held-native-account"));
      return {
        detached: false,
        exitCode: 0,
        stdout: "synthetic-refresh-1",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    };
    const client = await server.client(await server.token(actor.userId));
    pending = call(client, "exec", { id: first.id, command: "held-native-inspection" });
    await admitted;
    expect(
      (
        await server.db.query<{ active: boolean }>(
          "select activity_lease_id is not null as active from sandboxes where id=$1",
          [first.id],
        )
      ).rows[0]?.active,
    ).toBe(true);
    const stopped = await call(client, "stop", { id: first.id });
    expect(stopped.isError).toBe(true);
    expect(server.boat.stops).toHaveLength(0);
    server.boat.setExecOutput({ stdout: "independent-account-ok" });
    expect((await call(client, "exec", { id: second.id, command: "independent-inspection" })).data.stdout).toBe(
      "independent-account-ok",
    );
    release();
    const response = await pending;
    expect(response.isError).toBe(false);
    expect(response.data.stdout).toBe("***");
    expect(await ownership.state.read(actor, first.accountId, 1, first.id)).toMatchObject({
      authJson: native(1, "held-native-account"),
      revision: 1,
    });
    expect(
      (await server.db.query<{ version: number }>("select version from credentials where id=$1", [first.accountId]))
        .rows[0]?.version,
    ).toBe(1);
  } finally {
    release();
    await pending?.catch(() => {});
    await server.close();
  }
});
