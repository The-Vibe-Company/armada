import { expect, test } from "bun:test";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  decryptSecret,
  encryptSecret,
  type GoldenActor,
  type Sql,
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
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createNativeStateStore, nativeState } from "../src/model-auth-state.ts";
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

// Retained pre-broker publication fixtures protect sealed legacy output, not admission policy.
async function legacyFixture(db: Sql, key: string, account: string, version: number) {
  const row = (await db.query<{ value_enc: Uint8Array }>("select value_enc from credentials where id=$1", [account]))
    .rows[0]!;
  const initial = nativeState(await decryptSecret(new Uint8Array(row.value_enc), key));
  await db.query(
    `insert into model_auth_state(account_id,account_version,auth_revision,state_enc,source_generation)
    values($1,$2,0,$3,'launch:unallocated') on conflict do nothing`,
    [account, version, await encryptSecret(JSON.stringify(initial), key)],
  );
}

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
    );
    const actor: GoldenActor = { userId: OWNER, orgId: ORG, role: "admin" };
    const resolver = launchCredentials(createSqlVaultStore(db), KEY, undefined, auth);
    const credentials = await resolver.resolve(actor, "codex", account.id, 1);
    expect(credentials).toMatchObject({ binding: { credentialId: account.id, credentialVersion: 1 } });
    await legacyFixture(db, KEY, account.id, 1);
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
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [SANDBOX]);
    physicalStopped = true; // independent provider observation, not the SQL label
    await legacyFixture(db, KEY, account.id, 2);
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,
      visibility,credential_id,credential_version) values($1,$2,$3,$4,'codex','ready','new-native','new-native','org',$5,2)`,
      [OTHER, ORG, OWNER, GOLDEN, account.id],
    );
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
    await legacyFixture(db, KEY, account.id, 1);
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
    const shared = createModelAuthOwnership(db, KEY, undefined, () => time, { origin: "https://armada.example" });
    let resume!: () => void, entering!: () => void;
    const paused = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delayed = createNativeStateStore(
      {
        query: (query, params) => db.query(query, params),
        transaction: async (work) => {
          entering();
          await gate;
          return db.transaction(work);
        },
      },
      KEY,
    );
    // A legacy publication was admitted before adoption but obtains its locks after it.
    const late = delayed.publish({
      actor,
      accountId: account.id,
      version: 1,
      sandboxId: SANDBOX,
      generation: "modal:2",
      expectedRevision: 2,
      authJson: native(3),
      verifySource: async () => {},
    });
    await paused;
    await shared.broker!.enroll(actor, account.id, 1);
    resume();
    expect(await late).toBe(2);
    expect(await shared.broker!.secrets(account.id, 1)).toContain("synthetic-refresh-3");
    // A stale legacy exec preflight cannot relabel the shared renewal state either.
    await auth.state.invalidateRedaction(actor, SANDBOX);

    // Adoption preserves the latest sealed rotation, not the stale vault import.
    expect(await shared.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "synthetic-access-2",
      revision: 2,
    });
    expect(await shared.publishFromModal(scope, current, native(4), 2)).toEqual({
      authRevision: 2,
      committed: true,
      discarded: true,
    });
    expect(await shared.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "synthetic-access-2",
      revision: 2,
    });
    expect(await shared.broker!.secrets(account.id, 1)).toContain("synthetic-refresh-4");
    await expect(shared.publishFromModal(scope, claims, native(5), 2)).rejects.toMatchObject({ code: "forbidden" });
    expect(await shared.broker!.secrets(account.id, 1)).not.toContain("synthetic-refresh-5");
    const observed = {
      ...fakeBoat().provider,
      id: "modal" as const,
      get: async (id: string) => ({ id, name: id, state: "running" as const, providerState: "active", labels: {} }),
    };
    expect(
      await shared.redactEvents(observed, "native", actor, [
        {
          id: "late-native-output",
          at: 1,
          kind: "message",
          partial: false,
          tools: [],
          text: "synthetic-access-3 synthetic-refresh-3 synthetic-access-4 synthetic-refresh-4",
        },
      ]),
    ).toMatchObject([{ text: "*** *** *** ***" }]);
    await db.query("update credentials set value_enc=$2 where id=$1", [
      account.id,
      await encryptSecret(native(9), KEY),
    ]);
    expect(await auth.publishFromModal(scope, current, native(6), 2)).toEqual({
      authRevision: 2,
      committed: true,
      discarded: true,
    });
    expect((await db.query("select auth_revision from model_auth_state")).rows).toEqual([{ auth_revision: 2 }]);
    expect(await shared.broker!.secrets(account.id, 1)).toContain("synthetic-refresh-6");
    const lateCapture = createModelAuthOwnership(
      db,
      KEY,
      async () => native(7),
      () => time,
    );
    expect(await lateCapture.capture(observed, "native", actor)).toContain("synthetic-refresh-7");
    const preserved = (
      await db.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
        "select state_enc,auth_revision,source_generation from model_auth_state where account_id=$1 and account_version=1",
        [account.id],
      )
    ).rows[0]!;
    expect(preserved).toMatchObject({ auth_revision: 2, source_generation: "server:ready" });
    expect(JSON.parse(await decryptSecret(new Uint8Array(preserved.state_enc), KEY)).authJson).toBe(native(2));

    expect(
      await shared.redactEvents(observed, "native", actor, [
        {
          id: "retired-native-output",
          at: 2,
          kind: "message",
          partial: false,
          tools: [],
          text: "synthetic-refresh-6 synthetic-refresh-7",
        },
      ]),
    ).toMatchObject([{ text: "*** ***" }]);
  } finally {
    await db.close();
  }
});

test("shared Boat output samples late native disk secrets and refuses uncertain or stopped observations", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [people.owner, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const boat = fakeBoat();
    const physical = await boat.provider.fork({ from: "shared", noEnv: true, env: {}, labels: {}, ttlSeconds: 3600 });
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
       select $1,$2,$3,g.id,'codex','ready',$4,$4,'org',$5,1 from goldens g where g.org_id=$2 and g.name='shared'`,
      [id, actor.orgId, actor.userId, physical.id, account.id],
    );
    let sample = native(2),
      samples = 0,
      unavailable = false,
      expectedCapability = "";
    let duringSample: (() => Promise<void>) | undefined;
    const shared = createModelAuthOwnership(
      db,
      ENCRYPTION_KEY,
      async (_provider, target, _deps, _quiesced, capability) => {
        samples++;
        expect(target).toBe(physical.id);
        expect(capability).toBe(expectedCapability);
        await duringSample?.();
        if (unavailable) throw Error("Synthetic private sample failure");
        return sample;
      },
      undefined,
      { origin: "https://armada.example" },
    );
    const broker = shared.broker!;
    expectedCapability = broker.configuration(actor, account.id, 1, id).capability;
    await broker.enroll(actor, account.id, 1);
    const events = (text: string) =>
      shared.redactEvents(boat.provider, physical.id, actor, [
        {
          id: "disk-token-output",
          at: 1,
          kind: "message",
          partial: false,
          tools: [],
          text,
        },
      ]);
    expect(await events("synthetic-access-2 synthetic-refresh-2")).toMatchObject([{ text: "*** ***" }]);
    expect(await broker.secrets(account.id, 1)).toContain("synthetic-refresh-2");
    expect(await broker.access(actor, account.id, 1)).toMatchObject({ accessToken: "synthetic-access-0", revision: 0 });
    await db.query("update credentials set value_enc=$2 where id=$1", [
      account.id,
      await encryptSecret(native(9), ENCRYPTION_KEY),
    ]);
    sample = native(3);
    expect(await events("synthetic-refresh-3")).toMatchObject([{ text: "***" }]);
    sample = native(4);
    duringSample = async () => {
      await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
    };
    await expect(events("synthetic-refresh-4")).rejects.toMatchObject({ code: "conflict" });
    expect(await broker.secrets(account.id, 1)).not.toContain("synthetic-refresh-4");
    duringSample = undefined;
    unavailable = true;
    await expect(events("unobserved-disk-output")).rejects.toThrow();
    unavailable = false;
    sample = "null"; // Private transport verified this is an access-only broker home.
    expect(await events("synthetic-refresh-3")).toMatchObject([{ text: "***" }]);
    await boat.provider.stop({ sandboxId: physical.id });
    const beforeStoppedRead = samples;
    await expect(events("unobserved-stopped-output")).rejects.toMatchObject({ code: "unavailable" });
    expect(samples).toBe(beforeStoppedRead);
    const preserved = (
      await db.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
        "select state_enc,auth_revision,source_generation from model_auth_state where account_id=$1 and account_version=1",
        [account.id],
      )
    ).rows[0]!;
    expect(preserved).toMatchObject({ auth_revision: 0, source_generation: "server:ready" });
    expect(JSON.parse(await decryptSecret(new Uint8Array(preserved.state_enc), ENCRYPTION_KEY)).authJson).toBe(
      native(0),
    );
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
      await legacyFixture(server.db, ENCRYPTION_KEY, account.id, 1);
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
      await legacyFixture(db, KEY, account.id, 1);
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
