import { expect, test } from "bun:test";
import { createSqlVaultStore, decryptSecret, encryptSecret, type GoldenActor, type Sql } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { nativeState } from "../src/model-auth-state.ts";
import { seedPersistedBoat } from "./persisted-boat.fixture.ts";
import { rowOnlyConnection } from "./row-only-database.ts";
import { call, ENCRYPTION_KEY, fakeBoat, harness, SECRETS, seedDatabase } from "./support.ts";

const sharedConnection = rowOnlyConnection();
const sharedDatabase = async () => seedDatabase(await sharedConnection());

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
  const db = await sharedConnection();

  await db.query("insert into auth.users(id) values($1),($2)", [OWNER, PEER]);
  await db.query("insert into orgs(id,name) values($1,'Native state')", [ORG]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [ORG, OWNER, PEER]);
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
  expect((await db.query("select version from credentials where id=$1", [account.id])).rows).toEqual([{ version: 1 }]);
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
  expect(reads - before).toBe(1); // A new sample cannot publish under the old incarnation.
  expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toHaveProperty("authJson", native(1));
  await auth.capture(provider, "native", actor);
  expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(2), revision: 2 });
  await expect(auth.state.read({ ...actor, userId: PEER }, account.id, 1, SANDBOX)).rejects.toMatchObject({
    code: "not_found",
  });
  const promptStatus = { promptId: "finished-turn", status: "finished", done: true } as const;
  const promptProvider = createBoatProvider({
    apiKey: "fixture",
    fetch: (async () => Response.json({ ok: true, promptRun: promptStatus })) as unknown as typeof fetch,
    afterPrompt: (_provider, target) => auth.captureAfterBoatPrompt(provider, target, actor),
  });
  authJson = native(6);
  let winningRevision = 2;
  onRead = async () => {
    winningRevision = await auth.state.publish({
      actor,
      accountId: account.id,
      version: 1,
      sandboxId: SANDBOX,
      generation: "boat:1",
      expectedRevision: winningRevision,
      authJson: native(10 + winningRevision),
      verifySource: async () => {},
    });
  };
  expect(await promptProvider.getPrompt({ sandboxId: "native", promptId: promptStatus.promptId })).toEqual(
    promptStatus,
  );
  onRead = undefined;
  expect(await auth.state.read(actor, account.id, 1, SANDBOX)).toMatchObject({ authJson: native(14), revision: 5 });
  await db.query("delete from members where org_id=$1 and user_id=$2", [ORG, OWNER]);
  await expect(auth.state.read(actor, account.id, 1, SANDBOX)).rejects.toMatchObject({ code: "not_found" });
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [ORG, OWNER]);
  await db.query("update credentials set value_enc=$2 where id=$1", [account.id, await encryptSecret(native(9), KEY)]);
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
});
// Actual MCP exec/controller + shared SQL lease. SSH is a private transport peer;
// encryption, publication, lifecycle admission and redaction remain real owners.
test("managed exec holds stop admission through secret publication while independent accounts stay parallel", async () => {
  let ownership!: ReturnType<typeof createModelAuthOwnership>;
  const nativeBySandbox = new Map<string, string>();
  const server = await harness(
    {
      modelAuth: (db) => {
        ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, async (_provider, id) => {
          const value = nativeBySandbox.get(id);
          if (!value) throw Error("Missing private transport fixture");
          return value;
        });
        return ownership;
      },
    },
    await sharedDatabase(),
  );
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
    const claude = await seedPersistedBoat(server, { ownerId: actor.userId });
    const peerClient = await server.client(await server.token(server.people.member));
    server.boat.setExecOutput({ stdout: SECRETS.ownerClaude });
    const peerOutput = await call(peerClient, "exec", {
      id: claude,
      command: "inspect-static-native-token",
    });
    expect(peerOutput.isError).toBe(true); // Current sandbox access is owner/admin, not org-peer.
    const adminClient = await server.client(await server.token(server.people.admin));
    const adminOutput = await call(adminClient, "exec", {
      id: claude,
      command: "inspect-static-native-token",
    });
    expect(adminOutput.isError).toBe(false);
    expect(adminOutput.data.stdout).toBe("***");

    const ownerOutput = await call(ownerClient, "exec", {
      id: claude,
      command: "inspect-static-native-token",
    });
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
