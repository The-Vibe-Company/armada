import { expect, test } from "bun:test";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  launchSandbox,
  ProviderError,
} from "@armada/core/server";
import { type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { launchCredentials } from "../src/launch-credentials.ts";
import { modalLaunchEnvironment } from "../src/modal-launch-environment.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createSubscriptionMigration, type SubscriptionMigrationTransports } from "../src/subscription-migration.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const native = (revision: number) =>
  JSON.stringify({
    tokens: {
      access_token: `migration-access-${revision}`,
      refresh_token: `migration-refresh-${revision}`,
      account_id: "migration-account",
    },
  });

test("first shared launch drains known writers, keeps their latest auth and upgrades an old next prompt without historical cleanup", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [people.owner, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const boat = fakeBoat(),
      modal = fakeBoat();
    const oldBoat = await boat.provider.fork({ from: "legacy", noEnv: true, env: {}, labels: {}, ttlSeconds: 3600 });
    const oldModal = await modal.provider.fork({ from: "legacy", noEnv: true, env: {}, labels: {}, ttlSeconds: 3600 });
    const unknownPin = await boat.provider.fork({ from: "legacy", noEnv: true, env: {}, labels: {}, ttlSeconds: 3600 });
    const boatId = "11111111-1111-4111-8111-111111111111",
      modalId = "22222222-2222-4222-8222-222222222222";
    const scope: Scope = {
      orgId: people.org,
      userId: people.owner,
      visibility: "org",
      binding: { workspace: "ws", environment: "main", appId: "app" },
    };
    const goldens = createSqlGoldenStore(db);
    const modalGolden = await goldens.insert({
      orgId: people.org,
      ownerId: people.owner,
      name: "legacy-modal",
      visibility: "org",
      provider: "modal",
      modal: scope.binding,
      config: { repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] },
    });
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
      select $1,$2,$3,id,'codex','ready','boat',$4,$4,'org',$5,1 from goldens where org_id=$2 and name='shared'`,
      [boatId, people.org, people.owner, oldBoat.id, account.id],
    );
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider,provider_sandbox_id,visibility,credential_id,credential_version)
      values($1,$2,$3,$4,'codex','ready','modal',$5,'org',$6,1)`,
      [modalId, people.org, people.owner, modalGolden.id, oldModal.id, account.id],
    );
    await db.query(
      `insert into modal_machines(scope,id,org_id,owner_id,visibility,request_key,record) values($1,$2,$3,$4,'org','migration',$5::jsonb)`,
      [
        scopeKey(scope),
        oldModal.id,
        people.org,
        people.owner,
        JSON.stringify({ generation: 1, launchUserId: people.owner }),
      ],
    );
    for (const [id, physical, version] of [
      ["33333333-3333-4333-8333-333333333333", unknownPin.id, null],
      ["44444444-4444-4444-8444-444444444444", "absent", 1],
      ["55555555-5555-4555-8555-555555555555", "unavailable", 1],
    ] as const)
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version)
      select $1,$2,$3,g.id,'codex','running',$4,$4,'org',$5,$6 from goldens g where g.org_id=$2 and g.name='shared'`,
        [id, people.org, people.owner, physical, account.id, version],
      );
    for (const [status, id] of [
      ["failed", "66666666-6666-4666-8666-666666666666"],
      ["deleted", "77777777-7777-4777-8777-777777777777"],
    ] as const)
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,credential_id,credential_version,deleted_at)
        select $1,$2,$3,g.id,'codex',$4::sandbox_status,$6,$6,$5,1,case when $4='deleted' then now() else null end from goldens g where g.org_id=$2 and g.name='shared'`,
        [id, people.org, people.owner, status, account.id, id],
      );
    const resolved: string[] = [];
    await db.query("insert into model_auth_ownership(account_id,account_version,sandbox_id) values($1,1,$2)", [
      account.id,
      crypto.randomUUID(),
    ]);
    let writer = true,
      disk: string | undefined = native(0),
      drained = 0,
      renewals = 0;
    const grants = new Map<string, { url: string; capability: string }>();
    const submitted: string[] = [];
    const pendingHomes = new Set<string>();
    let afterDrain = native(1);
    let vendorUnavailable = true;
    const transports: SubscriptionMigrationTransports = {
      admission: async (_provider, id, active) => {
        expect(id).toBe(oldBoat.id);
        expect(active).toBe(false);
        if (writer) disk = afterDrain;
        writer = false;
        drained++;
      },
      read: async (_provider, id, _deps, quiesced, capability) => {
        if (id === oldBoat.id && disk) {
          if (quiesced) expect(writer).toBe(false);
          return disk;
        }
        if (grants.has(id)) {
          expect(capability).toBe(grants.get(id)!.capability);
          return pendingHomes.has(id) ? "pending" : "null";
        }
        throw Error("No private native source");
      },
      configure: async (_provider, id, grant) => {
        if (id === oldBoat.id) {
          expect(writer).toBe(false);
          disk = undefined;
        }
        grants.set(id, grant);
        pendingHomes.delete(id);
      },
    };
    let migration!: ReturnType<typeof createSubscriptionMigration>;
    const auth = createModelAuthOwnership(db, ENCRYPTION_KEY, transports.read, undefined, {
      origin: "https://armada.example",
      fetch: (async (_url, init) => {
        const token = JSON.parse(String(init?.body)).refresh_token;
        submitted.push(token);
        renewals++;
        if (token === "migration-refresh-2")
          return Response.json({ access_token: "migration-access-3", refresh_token: "migration-refresh-3" });
        if (token === "migration-refresh-3")
          return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
        if (token === "migration-refresh-4")
          return Response.json({ access_token: "migration-access-5", refresh_token: "migration-refresh-5" });
        if (token === "migration-refresh-0") throw Error("Retired imported refresh token must never be posted");
        if (token === "migration-refresh--1")
          return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
        if (token === "migration-refresh-5")
          return Response.json({ access_token: "migration-access-6", refresh_token: "migration-refresh-6" });
        if (token === "migration-refresh-6")
          return Response.json({ access_token: "migration-access-6", refresh_token: "migration-refresh-6" });
        if (token === "migration-refresh-8") {
          if (vendorUnavailable) {
            vendorUnavailable = false;
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          }
          return Response.json({ access_token: "migration-access-9", refresh_token: "migration-refresh-9" });
        }
        if (token === "migration-refresh-7") throw Error("Synthetic lost upstream renewal reply");
        throw Error("Unexpected synthetic renewal");
      }) as typeof fetch,
      prepareAccount: (...args) => migration.prepareAccount(...args),
      prepareTurn: (...args) => migration.prepareTurn(...args),
    });
    const modalProvider = {
      ...modal.provider,
      id: "modal" as const,
      stop: async ({ sandboxId }: { sandboxId: string }) => {
        const current = await auth.state.read(actor, account.id, 1, modalId);
        expect(
          await auth.publishFromModal(
            scope,
            { sandboxId, generation: "1", expiresAt: Date.now() + 60000 },
            native(2),
            current?.revision ?? 0,
          ),
        ).toMatchObject({ committed: true });
        await modal.provider.stop({ sandboxId });
      },
    };
    migration = createSubscriptionMigration(
      db,
      async (_sql, id) => {
        resolved.push(id);
        if (id === boatId) return { provider: boat.provider, providerSandboxId: oldBoat.id };
        if (id === modalId) return { provider: modalProvider, providerSandboxId: oldModal.id };
        if (id === "33333333-3333-4333-8333-333333333333")
          return { provider: boat.provider, providerSandboxId: unknownPin.id };
        throw new ProviderError({
          provider: "boat",
          code: id.startsWith("4444") ? "not_found" : "unavailable",
          message: "Synthetic unavailable history",
          retryable: false,
        });
      },
      (provider, id, caller, quiesced) => auth.capture(provider, id, caller, quiesced),
      auth.broker!,
      transports,
    );
    const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, auth);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await launchSandbox(
        boat.provider,
        {
          goldens,
          sandboxes: createSqlSandboxStore(db),
          credentials: {
            ...resolver,
            hydrateNative: async (owner, credentials, id, provider, physical) => {
              const pin = credentials.binding!;
              await transports.configure(
                provider,
                physical,
                auth.broker!.configuration(owner, pin.credentialId, pin.credentialVersion, id),
              );
              return true;
            },
          },
        },
        actor,
        { golden: "shared", harness: "codex", credentialId: account.id, prompt: `shared-${index}` },
      );
      ids.push(result.sandbox.id);
      expect(result.sandbox.status).toBe("running");
    }
    expect(drained).toBe(1);
    expect(writer).toBe(false);
    expect(disk).toBeUndefined();
    expect(modal.stops).toEqual([oldModal.id]);
    expect(resolved).not.toContain("66666666-6666-4666-8666-666666666666");
    expect(resolved).not.toContain("77777777-7777-4777-8777-777777777777");
    await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
      scopeKey(scope),
      JSON.stringify(scope),
    ]);
    const restored: Machine = {
      info: { ...oldModal, labels: { sandbox: modalId, credentialId: account.id, credentialVersion: "1" } },
      launchUserId: actor.userId,
      golden: false,
      phase: "active",
      generation: 2,
      ttlSeconds: 3600,
      physicalName: "restored-modal",
    };
    const restoredEnv = await modalLaunchEnvironment({
      sql: db,
      vault: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      scope,
      scopeKey: scopeKey(scope),
      callerUserId: actor.userId,
      modelAuth: auth,
    })(restored, { ARMADA_SERVER_CODEX: "1" });
    expect(restoredEnv.subscription?.capability).toBe(
      auth.broker!.configuration(actor, account.id, 1, modalId).capability,
    );
    expect(restoredEnv.codexAuthJson).toBeUndefined();
    expect(JSON.stringify(restoredEnv)).not.toContain("migration-refresh-");

    expect(boat.stops).toContain(unknownPin.id);
    expect(boat.prompts.map((prompt) => prompt.text)).toEqual(["shared-0", "shared-1", "shared-2"]);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-2",
      revision: 2,
    });
    for (const id of ids) {
      await resolver.assertTurn!(actor, id, false);
      const access = await auth.broker!.route(
        new Request("https://armada.example/api/internal/model/access", {
          method: "POST",
          headers: { authorization: `Bearer ${auth.broker!.configuration(actor, account.id, 1, id).capability}` },
          body: "{}",
        }),
      );
      expect(access?.status).toBe(200);
      expect(await access!.json()).toMatchObject({ accessToken: "migration-access-2" });
    }
    expect(await auth.broker!.access(actor, account.id, 1, 2)).toMatchObject({
      accessToken: "migration-access-3",
      revision: 3,
    });
    expect(renewals).toBe(1);
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    await boat.provider.prompt({ sandboxId: oldBoat.id, harness: "codex", text: "old next prompt" });
    expect(boat.prompts.at(-1)?.text).toBe("old next prompt");
    expect(drained).toBe(1);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-3",
      revision: 3,
    });
    // A known old home can appear after global enrollment; validate its latest
    // private token instead of assuming the broker's older import is still valid.
    grants.delete(oldBoat.id);
    writer = true;
    disk = native(4);
    afterDrain = native(4);
    // A new shared guest encounters the spent saved token. Its renewal itself
    // must discover/drain the known legacy source and return verified access,
    // without requiring the old owner to prompt or sign in first.
    expect(await auth.broker!.access(actor, account.id, 1, 3)).toMatchObject({
      accessToken: "migration-access-5",
      revision: 4,
    });
    expect(writer).toBe(false);
    expect(disk).toBeUndefined();
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    await boat.provider.prompt({
      sandboxId: oldBoat.id,
      harness: "codex",
      text: "old prompt after automatic recovery",
    });
    expect(boat.prompts.at(-1)?.text).toBe("old prompt after automatic recovery");
    expect(drained).toBe(2);
    // A known superseded import must never be replayed upstream; use the
    // current ready authority rather than trigger vendor reuse protection.
    grants.delete(oldBoat.id);
    writer = true;
    disk = native(0);
    afterDrain = native(0);
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-6",
      revision: 5,
    });
    expect(submitted).not.toContain("migration-refresh-0");
    expect(renewals).toBe(4);
    // An unknown stale token is different: its authoritative refusal permits
    // exactly one attempt with the different, still-ready saved token.
    grants.delete(oldBoat.id);
    writer = true;
    disk = native(-1);
    afterDrain = native(-1);
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-6",
      revision: 6,
    });
    expect(submitted.slice(-2)).toEqual(["migration-refresh--1", "migration-refresh-6"]);
    expect(renewals).toBe(6);
    pendingHomes.add(oldBoat.id);
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    expect(pendingHomes.has(oldBoat.id)).toBe(false);
    expect(renewals).toBe(6);
    // A received vendor outage is not lost auth: keep the private native token
    // paused and retry automatic handoff without requiring another login.
    grants.delete(oldBoat.id);
    writer = true;
    disk = native(8);
    afterDrain = native(8);
    await expect(migration.prepareAccount(actor, account.id, 1)).rejects.toThrow(
      "Model sign-in is temporarily unavailable. Try again.",
    );
    expect(writer).toBe(false);
    expect(disk).toBe(native(8));
    expect(grants.has(oldBoat.id)).toBe(false);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-6",
      revision: 6,
    });
    await auth.beforePrompt(boat.provider, oldBoat.id, actor);
    expect(await auth.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-9",
      revision: 7,
    });
    await boat.provider.prompt({ sandboxId: oldBoat.id, harness: "codex", text: "retried after provider outage" });
    expect(boat.prompts.at(-1)?.text).toBe("retried after provider outage");
    expect(writer).toBe(false);
    expect(disk).toBeUndefined();
    expect(grants.has(oldBoat.id)).toBe(true);
    // A genuinely lost renewal is the only sign-in fallback, and cleanup still
    // removes the old writer and raw auth before reporting that fixed message.
    grants.delete(oldBoat.id);
    writer = true;
    disk = native(7);
    afterDrain = native(7);
    await expect(auth.beforePrompt(boat.provider, oldBoat.id, actor)).rejects.toThrow(
      "Sign in again to this ChatGPT account.",
    );
    expect(writer).toBe(false);
    expect(disk).toBeUndefined();
    expect(grants.has(oldBoat.id)).toBe(true);
    await expect(auth.broker!.access(actor, account.id, 1)).rejects.toThrow("Sign in again to this ChatGPT account.");
    expect(renewals).toBe(9);
    expect(submitted).not.toContain("migration-refresh-0");
  } finally {
    await db.close();
  }
});

test("replicas observe an already-stopping Modal checkpoint before either adopts shared auth", async () => {
  const { db, people } = await database();
  let release!: () => void;
  let firstEnrollment: Promise<void> | undefined, secondEnrollment: Promise<void> | undefined;
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [actor.userId, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const scope: Scope = {
      orgId: actor.orgId,
      userId: actor.userId,
      visibility: "org",
      binding: { workspace: "ws", environment: "main", appId: "app" },
    };
    const golden = await createSqlGoldenStore(db).insert({
      orgId: actor.orgId,
      ownerId: actor.userId,
      name: "stopping-modal",
      visibility: "org",
      provider: "modal",
      modal: scope.binding,
      config: { repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] },
    });
    const id = crypto.randomUUID(),
      physical = "stopping-native";
    await createSqlSandboxStore(db).insert({
      id,
      provider: "modal",
      providerSandboxId: physical,
      goldenId: golden.id,
      orgId: actor.orgId,
      ownerId: actor.userId,
      harness: "codex",
      status: "ready",
      visibility: "org",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      credentialId: account.id,
      credentialVersion: 1,
    });
    await db.query(
      "insert into modal_machines(scope,id,org_id,owner_id,visibility,request_key,record) values($1,$2,$3,$4,'org','stopping-migration',$5::jsonb)",
      [
        scopeKey(scope),
        physical,
        actor.orgId,
        actor.userId,
        JSON.stringify({ generation: 1, launchUserId: actor.userId }),
      ],
    );
    let entering!: () => void, observed!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let stopping = false,
      complete = false,
      busy = false,
      stops = 0;
    let firstMigration!: ReturnType<typeof createSubscriptionMigration>,
      secondMigration!: ReturnType<typeof createSubscriptionMigration>;
    const first = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, {
      origin: "https://armada.example",
      prepareAccount: (...args) => firstMigration.prepareAccount(...args),
    });
    const second = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, {
      origin: "https://armada.example",
      prepareAccount: (...args) => secondMigration.prepareAccount(...args),
    });
    const provider = {
      ...fakeBoat().provider,
      id: "modal" as const,
      get: async () => {
        if (busy && !complete) {
          observed();
          await stopped;
        }
        return {
          id: physical,
          name: physical,
          state: complete ? ("stopped" as const) : stopping ? ("stopping" as const) : ("running" as const),
          providerState: complete ? "stopped" : stopping ? "checkpoint" : "active",
          labels: {},
        };
      },
      stop: async () => {
        stops++;
        if (stopping) {
          busy = true;
          throw new ProviderError({
            provider: "modal",
            code: "conflict",
            providerCode: "lifecycle_lease_busy",
            message: "Synthetic active lifecycle lease",
            retryable: true,
          });
        }
        stopping = true;
        entering();
        try {
          await checkpoint;
          expect(
            await first.publishFromModal(
              scope,
              { sandboxId: physical, generation: "1", expiresAt: Date.now() + 60000 },
              native(1),
              0,
            ),
          ).toEqual({ authRevision: 1, committed: true });
          complete = true;
        } finally {
          finish();
        }
      },
    };
    firstMigration = createSubscriptionMigration(
      db,
      async () => ({ provider, providerSandboxId: physical }),
      (...args) => first.capture(...args),
      first.broker!,
    );
    secondMigration = createSubscriptionMigration(
      db,
      async () => ({ provider, providerSandboxId: physical }),
      (...args) => second.capture(...args),
      second.broker!,
    );
    firstEnrollment = first.broker!.enroll(actor, account.id, 1);
    await entered;
    secondEnrollment = second.broker!.enroll(actor, account.id, 1);
    expect(await Promise.race([secondEnrollment.then(() => "adopted"), observation.then(() => "waiting")])).toBe(
      "waiting",
    );
    release();
    await Promise.all([firstEnrollment, secondEnrollment]);
    expect(stops).toBe(2); // One owner stop and one typed busy reply; never redispatch.
    expect(await first.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-1",
      revision: 1,
    });
    expect(await second.broker!.access(actor, account.id, 1)).toMatchObject({
      accessToken: "migration-access-1",
      revision: 1,
    });
  } finally {
    release?.();
    await Promise.allSettled([firstEnrollment, secondEnrollment]);
    await db.close();
  }
});
