import { expect, spyOn, test } from "bun:test";
import {
  CREDENTIAL_BUSY_MESSAGE,
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  launchSandbox,
  ProviderError,
  VaultError,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import {
  createGenerationGrants,
  createModalIngestHandler,
  type Machine,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createHistoricalSandboxProviderResolver } from "../src/mcp-sandbox-provider.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { call, database, ENCRYPTION_KEY, fakeBoat, harness, SECRETS } from "./support.ts";

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
      access_token: `synthetic-access-${revision}${accountId === "native-account" ? "" : "-" + accountId}`,
      refresh_token: `synthetic-refresh-${revision}${accountId === "native-account" ? "" : "-" + accountId}`,
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
    let physicalStopped = false;
    const observationProvider = fakeBoat().provider;
    observationProvider.get = async (id) => ({
      id,
      name: id,
      state: physicalStopped ? "stopped" : "running",
      providerState: "fixture",
      labels: {},
    });
    const auth = createModelAuthOwnership(
      db,
      KEY,
      async () => {
        reads++;
        await onRead?.();
        return authJson;
      },
      undefined,
      createHistoricalSandboxProviderResolver({ resolve: async () => observationProvider }),
    );
    const actor: GoldenActor = { userId: OWNER, orgId: ORG, role: "admin" };
    const resolver = launchCredentials(createSqlVaultStore(db), KEY, undefined, auth);
    const credentials = await resolver.resolve(actor, "codex", account.id, 1);
    expect(credentials).toMatchObject({ binding: { credentialId: account.id, credentialVersion: 1 } });
    await resolver.admit!(actor, credentials, SANDBOX); // Actual resolver-to-ownership pipeline before allocation.
    await auth.releaseUnallocated(account.id, 1, SANDBOX);
    expect(await auth.managed(SANDBOX)).toBe(false);
    await auth.claim(actor, account.id, 1, SANDBOX);
    await expect(auth.claim(actor, account.id, 1, OTHER)).rejects.toMatchObject({ code: "credential_busy" });
    const duplicate = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'codex_auth','Same native file',$2) returning id",
        [OWNER, await encryptSecret(native(0), KEY)],
      )
    ).rows[0]!;
    await expect(auth.claim(actor, duplicate.id, 1, crypto.randomUUID())).rejects.toMatchObject({
      code: "credential_busy",
    });

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
    // Never-started failures carry an explicit server-owned marker: a missing
    // conversation alone must not release an ambiguously dispatched prompt.
    await expect(auth.releaseFailed(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "conflict" });
    await db.query("update sandboxes set status='failed' where id=$1", [SANDBOX]);
    await expect(auth.releaseFailed(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "conflict" });
    await auth.markNeverStarted(actor, account.id, 1, SANDBOX);
    expect(await auth.holder(actor, account.id, 1)).toMatchObject({ sandboxId: SANDBOX, releasable: true });
    await expect(auth.releaseFailed({ ...actor, userId: PEER }, account.id, 1, SANDBOX)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      auth.releaseFailed(actor, account.id, 1, SANDBOX, async () => {
        throw Error("delete pending");
      }),
    ).rejects.toThrow("delete pending");
    expect(await auth.managed(SANDBOX)).toBe(true);
    await auth.releaseFailed(actor, account.id, 1, SANDBOX);
    expect(await auth.holder(actor, account.id, 1)).toBeNull();
    await auth.claim(actor, account.id, 1, OTHER);
    await auth.releaseUnallocated(account.id, 1, OTHER);
    await auth.claim(actor, account.id, 1, SANDBOX);
    await db.query("update sandboxes set status='ready',credential_id=$2,credential_version=1 where id=$1", [
      SANDBOX,
      account.id,
    ]);
    const provider = fakeBoat().provider;
    provider.get = async (id) => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
    const admission = spyOn(auth, "assertSandbox").mockRejectedValueOnce(
      new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE),
    );
    await expect(auth.beforeResume(provider, "native", actor)).rejects.toMatchObject({
      code: "conflict",
      retryable: false,
    });
    admission.mockRestore();
    await expect(auth.assertOwned(actor, account.id, 1, OTHER)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("launch a new sandbox"),
    });
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
    const claudeAccount = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'claude_oauth','Claude subscription',$2) returning id",
        [OWNER, await encryptSecret("synthetic-claude-setup-token", KEY)],
      )
    ).rows[0]!;
    await db.query(
      "insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version) values($1,$2,$3,$4,'claude','ready','claude-native','claude-native','org',$5,1)",
      [crypto.randomUUID(), ORG, OWNER, GOLDEN, claudeAccount.id],
    );
    // Org viewers must redact the launching owner's token, not their own vault.
    expect(
      await auth.redactEvents(provider, "claude-native", { userId: PEER, orgId: ORG }, [
        {
          id: "claude-output",
          at: 1,
          kind: "message",
          partial: false,
          tools: [],
          text: "synthetic-claude-setup-token",
        },
      ]),
    ).toMatchObject([{ text: "***" }]);
    // A user-supplied upstream label cannot reserve another owner's identity;
    // only an exact shared refresh secret is a cross-owner collision.
    const peerAccount = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [PEER, await encryptSecret(native(80), KEY)],
      )
    ).rows[0]!;
    await auth.claim({ userId: PEER, orgId: ORG, role: "admin" }, peerAccount.id, 1, crypto.randomUUID());
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
    await expect(auth.claim(actor, account.id, 2, OTHER)).rejects.toMatchObject({ code: "credential_busy" });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [SANDBOX]);
    physicalStopped = true; // independent provider observation, not the SQL label
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
    const ownerClient = await server.client(await server.token(actor.userId));
    const claude = await call(ownerClient, "launch", { golden: "shared", harness: "claude" });
    expect(claude.isError).toBe(false);
    const peerClient = await server.client(await server.token(server.people.member));
    server.boat.setExecOutput({ stdout: SECRETS.ownerClaude });
    const peerOutput = await call(peerClient, "exec", { id: claude.data.id, command: "inspect-static-native-token" });
    expect(peerOutput.isError).toBe(true); // Current sandbox access is owner/admin, not org-peer.
    const adminClient = await server.client(await server.token(server.people.admin));
    const adminOutput = await call(adminClient, "exec", { id: claude.data.id, command: "inspect-static-native-token" });
    expect(adminOutput.isError).toBe(false);
    expect(adminOutput.data.stdout).toBe("***");

    const ownerOutput = await call(ownerClient, "exec", { id: claude.data.id, command: "inspect-static-native-token" });
    expect(ownerOutput.isError).toBe(false);
    expect(ownerOutput.data.stdout).toBe("***");
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
        stdout: JSON.parse(native(1, "held-native-account")).tokens.refresh_token,
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

test("automatic native cleanup holds lifecycle admission through deletion and fences a queued send", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const sandboxId = crypto.randomUUID();
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'codex_auth',$2) returning id",
        [actor.orgId, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY);
    const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
    const credentials = await resolver.resolve(actor, "codex", account.id, 1);
    await resolver.admit?.(actor, credentials, sandboxId);
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
      select $1,$2,$3,g.id,'codex','failed','cleanup','cleanup','org',$4,1 from goldens g where g.org_id=$2 and g.name='shared'`,
      [sandboxId, actor.orgId, actor.userId, account.id],
    );
    expect(await resolver.markNeverStarted?.(actor, credentials, sandboxId)).toBe(true);
    const store = createSqlData(db)({
      userId: actor.userId,
      orgs: [{ orgId: actor.orgId, role: "member" }],
      via: "supabase",
    }).sandboxes;
    const initial = (await store.get(sandboxId))!;
    const token = crypto.randomUUID();
    await store.update(sandboxId, {
      advanceGeneration: true,
      activityToken: token,
      expectedGeneration: initial.lifecycleGeneration!,
      status: "running",
    });
    let deletions = 0;
    await expect(
      resolver.releaseNeverStarted?.(actor, credentials, sandboxId, async () => {
        deletions++;
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(deletions).toBe(0);
    await store.update(sandboxId, {
      finishActivity: true,
      activityToken: token,
      expectedGeneration: initial.lifecycleGeneration! + 1,
      status: "failed",
    });
    await expect(
      ownership.releaseFailed(actor, account.id, 1, sandboxId, async () => {
        deletions++;
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const before = (await store.get(sandboxId))!;
    let queued: Promise<unknown> | undefined;
    let settled = false;
    await resolver.releaseNeverStarted?.(actor, credentials, sandboxId, async () => {
      deletions++;
      queued = store
        .update(sandboxId, {
          advanceGeneration: true,
          activityToken: crypto.randomUUID(),
          expectedGeneration: before.lifecycleGeneration!,
          status: "running",
        })
        .then(
          () => ({ accepted: true }),
          (error) => error,
        )
        .finally(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
    });
    expect(await queued).toMatchObject({ code: "sandbox_not_ready" });
    expect(deletions).toBe(1);
    expect(await ownership.managed(sandboxId)).toBe(false);
    expect((await store.get(sandboxId))?.lifecycleGeneration).toBe(before.lifecycleGeneration! + 1);
  } finally {
    await db.close();
  }
});

test.each([false, true])(
  "later native admission prevents initial cleanup after an ambiguous send (markedBeforeAdmission=%s)",
  async (markedBeforeAdmission) => {
    const { db, people } = await database();
    try {
      const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
      const sandboxId = crypto.randomUUID();
      const account = (
        await db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [actor.userId, await encryptSecret(native(0), ENCRYPTION_KEY)],
        )
      ).rows[0]!;
      const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY);
      const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
      const credentials = await resolver.resolve(actor, "codex", account.id, 1);
      await resolver.admit?.(actor, credentials, sandboxId);
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
        select $1,$2,$3,g.id,'codex','failed','admission','admission','org',$4,1 from goldens g where g.org_id=$2 and g.name='shared'`,
        [sandboxId, actor.orgId, actor.userId, account.id],
      );
      // Initial hydration alone must leave automatic init-failure cleanup possible.
      await ownership.bootstrap(actor, account.id, 1, sandboxId);
      if (markedBeforeAdmission) expect(await resolver.markNeverStarted?.(actor, credentials, sandboxId)).toBe(true);
      const store = createSqlData(db)({
        userId: actor.userId,
        orgs: [{ orgId: actor.orgId, role: "member" }],
        via: "supabase",
      }).sandboxes;
      const initial = (await store.get(sandboxId))!;
      const token = crypto.randomUUID();
      await store.update(sandboxId, {
        advanceGeneration: true,
        activityToken: token,
        expectedGeneration: initial.lifecycleGeneration!,
        status: "running",
      });
      await ownership.assertSandbox(actor, sandboxId, true);
      // Model acceptance is ambiguous: the activity lease is gone and no
      // conversation/turn receipt was published, but native work may still run.
      await store.update(sandboxId, {
        finishActivity: true,
        activityToken: token,
        expectedGeneration: initial.lifecycleGeneration! + 1,
        status: "failed",
      });
      // This selects owned cleanup instead of an unsafe fallback stop; the
      // transaction must still refuse deletion once turn admission occurred.
      expect(await resolver.markNeverStarted?.(actor, credentials, sandboxId)).toBe(true);
      let deletions = 0;
      await expect(
        resolver.releaseNeverStarted?.(actor, credentials, sandboxId, async () => {
          deletions++;
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(deletions).toBe(0);
      expect(await ownership.managed(sandboxId)).toBe(true);
    } finally {
      await db.close();
    }
  },
);

test.each(["orphan", "failed", "stopped", "deleted", "historical"])(
  "explicit reconnect recovers a trapped %s holder and permits the next real claim",
  async (status) => {
    const { db, people } = await database();
    try {
      const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "admin" };
      const old = crypto.randomUUID();
      const provider = fakeBoat().provider;
      let deletions = 0;
      provider.delete = async () => {
        deletions++;
        return { status: "deleted" };
      };
      provider.get = async () => {
        throw new ProviderError({ provider: "boat", code: "not_found", message: "Deleted", retryable: false });
      };
      const ownership = createModelAuthOwnership(
        db,
        ENCRYPTION_KEY,
        undefined,
        undefined,
        createHistoricalSandboxProviderResolver({ resolve: async () => provider }),
      );
      const account = (
        await db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [actor.userId, await encryptSecret(native(0), ENCRYPTION_KEY)],
        )
      ).rows[0]!;
      await ownership.claim(actor, account.id, 1, old);
      if (status === "historical") await ownership.releaseUnallocated(account.id, 1, old);
      if (status !== "orphan")
        await db.query(
          `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version,stopped_at,deleted_at)
       select $1,$2,$3,g.id,'codex',$4::public.sandbox_status,'trapped','trapped','org',$5,1,
       case when $4='stopped' then now() else null end,case when $4='deleted' then now() else null end
       from goldens g where g.org_id=$2 and g.name='shared'`,
          [old, actor.orgId, actor.userId, status === "historical" ? "failed" : status, account.id],
        );
      expect(await ownership.holder(actor, account.id, 1)).toMatchObject({
        sandboxId: old,
        storedVersion: 1,
        currentVersion: 1,
        requiresReconnect: true,
        releasable: false,
      });
      await expect(ownership.releaseFailed(actor, account.id, 1, old)).rejects.toMatchObject({ code: "conflict" });
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret(native(2), ENCRYPTION_KEY),
      ]);
      expect(await ownership.holder(actor, account.id, 2)).toMatchObject({
        sandboxId: old,
        storedVersion: 1,
        currentVersion: 2,
        requiresReconnect: false,
        releasable: true,
      });
      if (status !== "orphan") {
        await db.query("update sandboxes set activity_until=now()+interval '1 hour' where id=$1", [old]);
        await expect(ownership.releaseFailed(actor, account.id, 2, old)).rejects.toMatchObject({ code: "conflict" });
        expect(deletions).toBe(0);
        await db.query("update sandboxes set activity_until=null where id=$1", [old]);
      }
      await ownership.releaseFailed(actor, account.id, 2, old);
      expect(await ownership.holder(actor, account.id, 2)).toBeNull();
      expect(deletions).toBe(status === "orphan" ? 0 : 1);
      expect(
        (await db.query("select 1 from model_auth_state where account_id=$1 and account_version=1", [account.id])).rows,
      ).toHaveLength(status === "historical" ? 0 : 1);
      if (status !== "orphan")
        expect(
          (await db.query<{ status: string }>("select status from sandboxes where id=$1", [old])).rows[0]?.status,
        ).toBe("deleted");
      const next = crypto.randomUUID();
      await ownership.claim(actor, account.id, 2, next);
      await expect(ownership.assertOwned(actor, account.id, 2, next)).resolves.toBeUndefined();
      await expect(ownership.bootstrap(actor, account.id, 1, old)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await db.close();
    }
  },
);

test("unknown-version history requires atomic fresh import and confirmed deletion before reuse", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "admin" };
    const old = crypto.randomUUID();
    const provider = fakeBoat().provider;
    let confirmed = false,
      deletions = 0;
    provider.delete = async () => {
      deletions++;
      return { status: confirmed ? "deleted" : "pending" };
    };
    provider.get = async (id) => ({ id, name: id, state: "running", providerState: "running", labels: {} });
    const ownership = createModelAuthOwnership(
      db,
      ENCRYPTION_KEY,
      undefined,
      undefined,
      createHistoricalSandboxProviderResolver({ resolve: async () => provider }),
    );
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [actor.userId, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id)
      select $1,$2,$3,g.id,'codex','failed','unknown','unknown','org',$4 from goldens g where g.org_id=$2 and g.name='shared'`,
      [old, actor.orgId, actor.userId, account.id],
    );
    expect(await ownership.holder(actor, account.id, 1)).toMatchObject({
      sandboxId: old,
      storedVersion: null,
      unknownVersion: true,
      requiresReconnect: true,
      releasable: false,
    });
    await expect(ownership.releaseFailed(actor, account.id, 1, old)).rejects.toMatchObject({ code: "conflict" });
    await expect(ownership.releaseFailed(actor, account.id, 1, old, undefined, "invalid")).rejects.toMatchObject({
      code: "invalid",
    });
    expect(deletions).toBe(0);
    await expect(ownership.releaseFailed(actor, account.id, 1, old, undefined, native(2))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (await db.query<{ version: number }>("select version from credentials where id=$1", [account.id])).rows[0]
        ?.version,
    ).toBe(1);
    expect(await ownership.holder(actor, account.id, 1)).toMatchObject({ sandboxId: old });
    confirmed = true;
    await ownership.releaseFailed(actor, account.id, 1, old, undefined, native(2));
    expect(
      (await db.query<{ version: number }>("select version from credentials where id=$1", [account.id])).rows[0]
        ?.version,
    ).toBe(2);
    expect(await ownership.holder(actor, account.id, 2)).toBeNull();
    const next = crypto.randomUUID();
    await ownership.claim(actor, account.id, 2, next);
    expect(await ownership.bootstrap(actor, account.id, 2, next)).toMatchObject({ authJson: native(2) });
  } finally {
    await db.close();
  }
});

// Rollout boundary: a612-bound native home may predate203 and already contain a
// rotated token. Empty ownership is not proof that its credential is unused.
test.each([
  { name: "ready legacy collision", status: "ready", replace: false },
  { name: "running legacy collision", status: "running", replace: false },
  { name: "stopped stale same-version legacy", status: "stopped", replace: false },
  { name: "same logical legacy ID is not adoption", status: "ready", replace: false, sameId: true },
  { name: "fresh import does not silently adopt a stopped legacy ID", status: "stopped", replace: true, sameId: true },
  { name: "fresh replacement still fences running old writer", status: "running", replace: true },
  { name: "fresh replacement after confirmed idle stop", status: "stopped", replace: true, allowed: true },
  {
    name: "fresh replacement after deleted history is physically absent",
    status: "deleted",
    replace: true,
    allowed: true,
    absent: true,
  },
  {
    name: "fresh replacement after failed history is physically absent",
    status: "failed",
    replace: true,
    allowed: true,
    absent: true,
  },
  {
    name: "authenticated forged stopped receipt cannot hide a live writer",
    status: "running",
    replace: true,
    forged: true,
  },
  { name: "missing trusted observation is not quiescence", status: "stopped", replace: true, missingObserver: true },
  { name: "expired activity lease is not quiescence", status: "stopped", replace: true, leased: true },
  {
    name: "managed stopped owner cannot hide another legacy writer",
    status: "stopped",
    replace: true,
    enrolled: true,
    otherLive: true,
  },
])("first native enrollment: $name", async (scenario) => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    let captures = 0,
      observations = 0;
    const observationProvider = fakeBoat().provider;
    observationProvider.get = async (id) => {
      observations++;
      if (scenario.absent)
        throw new ProviderError({ provider: "boat", code: "not_found", message: "Deleted", retryable: false });
      return {
        id,
        name: id,
        state: scenario.status === "stopped" ? "stopped" : "running",
        providerState: "private-provider-observation",
        labels: {},
      };
    };
    const observe = createHistoricalSandboxProviderResolver({
      resolve: async (target, caller) => {
        expect(target.provider).toBe("boat");
        expect(target.orgId).toBe(actor.orgId);
        expect(caller.userId).toBe(actor.userId);
        return observationProvider;
      },
    });
    const ownership = createModelAuthOwnership(
      db,
      ENCRYPTION_KEY,
      async () => {
        captures++;
        return native(1);
      },
      undefined,
      scenario.missingObserver ? undefined : observe,
    );
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [actor.userId, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const legacy = crypto.randomUUID();
    if (scenario.enrolled) await ownership.claim(actor, account.id, 1, legacy);
    const insertLegacy = async (id: string, status: string) =>
      db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version,stopped_at,deleted_at)
       select $1,$2,$3,g.id,'codex',$4::public.sandbox_status,$5,$5,'org',$6,1,
       case when $4='stopped' then now() else null end,case when $4='deleted' then now() else null end
       from goldens g where g.org_id=$2 and g.name='shared'`,
        [id, actor.orgId, actor.userId, status, `legacy-${id}`, account.id],
      );
    await insertLegacy(legacy, scenario.status);
    if (scenario.forged) {
      await db.exec("begin");
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actor.userId]);
        await db.exec("set local role authenticated");
        await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [legacy]);
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    }
    if (scenario.otherLive) await insertLegacy(crypto.randomUUID(), "running");
    if (scenario.leased)
      await db.query("update sandboxes set activity_lease_id=$2,activity_until=now()-interval '1 hour' where id=$1", [
        legacy,
        crypto.randomUUID(),
      ]);
    if (scenario.replace)
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret(native(9), ENCRYPTION_KEY),
      ]);
    const currentVersion = scenario.replace ? 2 : 1;
    const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
    const provider = fakeBoat().provider;
    let forks = 0,
      target = "";
    provider.fork = async (request) => {
      forks++;
      target = request.labels!.sandbox!;
      expect(await ownership.state.read(actor, account.id, currentVersion, target)).toMatchObject({
        authJson: native(scenario.replace ? 9 : 0),
        revision: 0,
      });
      throw new ProviderError({
        provider: "boat",
        code: "invalid_request",
        message: "fixture admission probe: no allocation",
        retryable: false,
      });
    };
    const launch = launchSandbox(
      provider,
      { goldens: createSqlGoldenStore(db), sandboxes: createSqlSandboxStore(db), credentials: resolver },
      actor,
      { golden: "shared", harness: "codex", credentialId: account.id },
      scenario.sameId ? { newId: () => legacy } : {},
    );
    if (scenario.allowed) {
      await expect(launch).rejects.toMatchObject({ code: "invalid_request" });
      expect(forks).toBe(1);
      expect(await ownership.managed(target)).toBe(false); // confirmed no-allocation cleanup
      const freshOwner = crypto.randomUUID();
      await ownership.claim(actor, account.id, 2, freshOwner);
      // The old workspace remains unmanaged; a different generation's lease is
      // not permission to rebind it or disable its ordinary shell inspection.
      if (scenario.status === "deleted")
        await expect(ownership.assertSandbox(actor, legacy, false, true)).rejects.toMatchObject({ code: "not_found" });
      else await ownership.assertSandbox(actor, legacy, false, true);
    } else {
      await expect(launch).rejects.toMatchObject({ code: "credential_busy" });
      expect(forks).toBe(0);
      if (!scenario.enrolled) {
        expect(
          (await db.query("select 1 from model_auth_ownership where account_id=$1", [account.id])).rows,
        ).toHaveLength(0);
        expect((await db.query("select 1 from model_auth_state where account_id=$1", [account.id])).rows).toHaveLength(
          0,
        );
        await ownership.assertSandbox(actor, legacy, false, true);
        if (!scenario.replace) {
          await expect(ownership.assertSandbox(actor, legacy, true)).rejects.toMatchObject({
            code: "credential_binding_required",
          });
          await expect(ownership.bootstrap(actor, account.id, 1, legacy)).rejects.toMatchObject({
            code: "credential_binding_required",
          });
          if (scenario.name === "ready legacy collision") {
            const caller = { userId: actor.userId, orgId: actor.orgId };
            const duplicate = (
              await db.query<{ id: string }>(
                "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'codex_auth','Duplicate legacy identity',$2) returning id",
                [actor.userId, await encryptSecret(native(9), ENCRYPTION_KEY)],
              )
            ).rows[0]!;
            await expect(ownership.claim(actor, duplicate.id, 1, crypto.randomUUID())).rejects.toMatchObject({
              code: "credential_busy",
            });
            // A rotated token is not in the original imported credential. No
            // event/exec output may escape without a trustworthy registry.
            await expect(
              ownership.redactEvents(observationProvider, `legacy-${legacy}`, caller, [
                { id: "legacy-output", at: 1, kind: "message", partial: false, tools: [], text: "synthetic-refresh-1" },
              ]),
            ).rejects.toMatchObject({ code: "credential_binding_required" });
            await expect(
              resolver.nativeSecrets!(actor, legacy, observationProvider, `legacy-${legacy}`, "before"),
            ).rejects.toMatchObject({ code: "credential_binding_required" });
            await ownership.beforeStop(observationProvider, `legacy-${legacy}`, caller);
            await db.query("update sandboxes set credential_id=null,credential_version=null where id=$1", [legacy]);
            await expect(
              ownership.redactEvents(observationProvider, `legacy-${legacy}`, caller, []),
            ).rejects.toMatchObject({ code: "credential_binding_required" });
            await expect(ownership.assertSandbox(actor, legacy, false)).rejects.toMatchObject({
              code: "credential_binding_required",
            });
            await ownership.beforeStop(observationProvider, `legacy-${legacy}`, caller);
            await db.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [
              legacy,
              account.id,
            ]);
            await db.query("update credentials set value_enc=$2 where id=$1", [
              account.id,
              await encryptSecret(native(70, "different-replacement"), ENCRYPTION_KEY),
            ]);
            await expect(ownership.claim(actor, duplicate.id, 1, crypto.randomUUID())).rejects.toMatchObject({
              code: "credential_busy",
            });
            // Restoring the fixture advances version again; the old home remains
            // unowned and is still fenced below, never implicitly adopted.
            await db.query("update credentials set value_enc=$2 where id=$1", [
              account.id,
              await encryptSecret(native(0), ENCRYPTION_KEY),
            ]);
          }
        }
      } else {
        expect(
          (
            await db.query<{ account_version: number }>(
              "select account_version from model_auth_ownership where account_id=$1",
              [account.id],
            )
          ).rows[0]?.account_version,
        ).toBe(1);
      }
    }
    if (scenario.allowed || scenario.forged) expect(observations).toBeGreaterThan(0);
    expect(captures).toBe(0); // no hidden capture/resume/adoption of the old home
    expect(
      (
        await db.query<{ credential_id: string; credential_version: number }>(
          "select credential_id,credential_version from sandboxes where id=$1",
          [legacy],
        )
      ).rows[0],
    ).toEqual({ credential_id: account.id, credential_version: 1 });
  } finally {
    await db.close();
  }
});

test.each(["active", "revoked", "replaced"])(
  "removed-owner nativeAuth checkpoint ingestion requires the exact stop fence (%s)",
  async (status) => {
    const { db, people: p } = await database();
    try {
      const time = Date.now(),
        sandboxId = crypto.randomUUID(),
        orchestratorId = crypto.randomUUID(),
        operationId = crypto.randomUUID();
      const account = (
        await db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [p.owner, await encryptSecret(native(0), KEY)],
        )
      ).rows[0];
      if (!account) throw Error("Missing account fixture.");
      const auth = createModelAuthOwnership(db, KEY, undefined, () => time);
      const actor: GoldenActor = { userId: p.owner, orgId: p.org, role: "member" };
      await auth.claim(actor, account.id, 1, sandboxId);
      const scope: Scope = {
        orgId: p.org,
        userId: p.owner,
        visibility: "private",
        binding: { workspace: "native", environment: "test", appId: "ap_checkpoint" },
      };
      const golden = await createSqlGoldenStore(db).insert({
        orgId: p.org,
        ownerId: p.owner,
        name: "checkpoint",
        provider: "modal",
        modal: scope.binding,
        visibility: "private",
        config: { repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] },
      });
      await createSqlSandboxStore(db).insert({
        id: sandboxId,
        provider: "modal",
        providerSandboxId: "native-checkpoint",
        goldenId: golden.id,
        orgId: p.org,
        ownerId: p.owner,
        harness: "codex",
        status: "ready",
        visibility: "private",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        credentialId: account.id,
        credentialVersion: 1,
      });
      await db.query("update sandboxes set orchestrator_native_generation='7' where id=$1", [sandboxId]);
      await db.query(
        "insert into orchestrators(id,org_id,owner_id,sandbox_id,state,revision) values($1,$2,$3,$4,'stopping',1)",
        [orchestratorId, p.org, p.owner, sandboxId],
      );
      const machine = {
        orchestratorId,
        sandboxId,
        providerSandboxId: "native-checkpoint",
        generation: "1",
        physicalGeneration: "7",
        operationId,
        state: "uncertain",
        continuity: "unverified",
      };
      await db.query(
        "insert into orchestrator_operations(id,orchestrator_id,actor_id,action,idempotency_key,request_digest,revision,runtime_result) values($1,$2,$3,'stop','checkpoint',$4,1,$5::jsonb)",
        [operationId, orchestratorId, p.owner, "a".repeat(64), JSON.stringify(machine)],
      );
      await db.query(
        "insert into modal_machines(scope,id,org_id,owner_id,visibility,request_key,record) values($1,'native-checkpoint',$2,$3,'private','checkpoint',$4::jsonb)",
        [scopeKey(scope), p.org, p.owner, JSON.stringify({ generation: 7, launchUserId: p.owner })],
      );
      if (status === "revoked") await db.query("update credentials set status='revoked' where id=$1", [account.id]);
      if (status === "replaced")
        await db.query("update credentials set value_enc=$2 where id=$1", [
          account.id,
          await encryptSecret(native(9), KEY),
        ]);
      await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
      const grants = createGenerationGrants(Buffer.alloc(32, 31), scope);
      const grant = (generation = 7, expiresAt = time + 60000) =>
        grants.issue({ info: { id: "native-checkpoint" }, generation, grantExpiresAt: expiresAt } as Machine).token;
      const ingest = createModalIngestHandler({
        sql: db,
        verifyGrant: grants.verifyGrant,
        publishNativeAuth: auth.publishFromModal,
      });
      const request = (token = grant(), bodyGeneration = "7") =>
        ingest(
          new Request("https://armada.invalid/api/internal/modal/events", {
            method: "POST",
            headers: { "content-type": "application/json", "x-armada-runner-grant": token },
            body: JSON.stringify({
              sandboxId: "native-checkpoint",
              generation: bodyGeneration,
              events: [],
              nativeAuth: { authJson: native(1), expectedRevision: 0 },
            }),
          }),
        );
      await expect(auth.state.read(actor, account.id, 1, sandboxId)).rejects.toMatchObject({ code: "not_found" });
      const foreign = createGenerationGrants(Buffer.alloc(32, 31), { ...scope, userId: p.member }).issue({
        info: { id: "native-checkpoint" },
        generation: 7,
        grantExpiresAt: time + 60000,
      } as Machine).token;
      expect((await request(foreign)).status).toBe(403);
      await expect(
        auth.publishFromModal(
          scope,
          { sandboxId: "native-checkpoint", generation: "7", expiresAt: time },
          native(1),
          0,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await request(grant(8), "8")).status).toBe(403);
      await db.query("update orchestrator_operations set state='succeeded' where id=$1", [operationId]);
      expect((await request()).status).toBe(403);
      await db.query("update orchestrator_operations set state='pending' where id=$1", [operationId]);
      await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [sandboxId]);
      expect((await request()).status).toBe(403);
      await db.query("update sandboxes set lifecycle_generation=1 where id=$1", [sandboxId]);
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        status === "active"
          ? { authRevision: 1, committed: true }
          : { authRevision: 0, committed: true, discarded: true },
      );
      expect((await request()).status).toBe(200); // ACK retry must never rotate again.
      expect(
        (
          await db.query<{ auth_revision: number }>("select auth_revision from model_auth_state where account_id=$1", [
            account.id,
          ])
        ).rows[0]?.auth_revision,
      ).toBe(status === "active" ? 1 : 0);
      await expect(auth.state.read(actor, account.id, 1, sandboxId)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await db.close();
    }
  },
);
