import { expect, spyOn, test } from "bun:test";
import { createSqlVaultStore, decryptSecret, encryptSecret, type Provider, ProviderError } from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { configureClaudeEndpoint } from "../../agent-runtime/src/claude-endpoint.ts";
import type { Caller } from "../src/caller.ts";
import { createCredentialRepoint } from "../src/credential-repoint.ts";
import { createSqlData } from "../src/data.ts";
import { exposedSecrets, launchCredentials } from "../src/launch-credentials.ts";
import { modalLaunchEnvironment } from "../src/modal-launch-environment.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createModelUsageApi } from "../src/model-usage.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { database, ENCRYPTION_KEY, fakeBoat, SECRETS } from "./support.ts";

async function fixture(
  options: {
    native?: boolean;
    shared?: boolean;
    orgVisible?: boolean;
    harness?: "claude" | "codex";
    boat?: boolean;
    active?: boolean;
    stopUncertain?: boolean;
    failAfterBoot?: boolean;
    revokeAfterBoot?: boolean;
    removeMemberAfterBoot?: boolean;
    preservationFails?: boolean;
    diskLost?: boolean;
  } = {},
) {
  const { db, people } = await database();
  const harness = options.harness ?? "codex";
  const caller: Caller = { userId: people.owner, orgs: [{ orgId: people.org, role: "member" }], via: "supabase" };
  const scope: Scope = {
    orgId: people.org,
    userId: people.owner,
    visibility: options.orgVisible ? "org" : "private",
    binding: { workspace: "ws-repoint", environment: "main", appId: "ap-repoint" },
  };
  await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
    scopeKey(scope),
    JSON.stringify(scope),
  ]);
  const golden = crypto.randomUUID(),
    id = crypto.randomUUID(),
    physical = "retained-workspace";
  await db.query(
    `insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id,config) values($1,$2,$3,'repoint',$9,$8::public.sandbox_provider,$4,$5,$6,$7::jsonb)`,
    [
      golden,
      people.org,
      people.owner,
      options.boat ? null : scope.binding.workspace,
      options.boat ? null : scope.binding.environment,
      options.boat ? null : scope.binding.appId,
      JSON.stringify({ repos: [], init: [] }),
      options.boat ? "boat" : "modal",
      options.orgVisible ? "org" : "private",
    ],
  );
  if (harness === "claude")
    await db.query(
      "insert into credentials(scope,owner_id,kind,name,value_enc) values('org',$1,'anthropic','Previous Claude',$2)",
      [people.org, await encryptSecret("previous-claude-api-secret", ENCRYPTION_KEY)],
    );
  const old = (
    await db.query<{ id: string }>("select id from credentials where scope='org' and owner_id=$1 and kind=$2", [
      people.org,
      harness === "claude" ? "anthropic" : "openai",
    ])
  ).rows[0]!;
  const secret = options.native
    ? JSON.stringify({
        tokens: {
          access_token: "replacement-access-token",
          refresh_token: "replacement-refresh-token",
          account_id: "replacement-native-account",
        },
      })
    : "sk-proj-replacement-api-secret";
  const target = (
    await db.query<{ id: string }>(
      "insert into credentials(scope,owner_id,kind,name,value_enc,is_default) values('user',$1,$2,'Replacement',$3,true) returning id",
      [
        people.owner,
        options.native ? "codex_auth" : harness === "claude" ? "anthropic" : "openai",
        await encryptSecret(secret, ENCRYPTION_KEY),
      ],
    )
  ).rows[0]!;
  await db.query(
    `insert into sandboxes(id,org_id,owner_id,golden_id,provider,provider_sandbox_id,harness,status,conversation_ids,credential_id,credential_version,effective_ttl_seconds,task_prompt_id)
    values($1,$2,$3,$4,$7::public.sandbox_provider,$5,$8::public.harness,'ready',array['existing-conversation'],$6,1,3600,'previous-terminal')`,
    [id, people.org, people.owner, golden, physical, old.id, options.boat ? "boat" : "modal", harness],
  );
  const machine: Machine = {
    info: {
      id: physical,
      name: "retained",
      state: "ready",
      providerState: "active",
      labels: { sandbox: id, credentialId: old.id, credentialVersion: "1" },
    },
    launchUserId: people.owner,
    golden: false,
    phase: "active",
    generation: 1,
    ttlSeconds: 3600,
    physicalName: "retained",
    recoveryImageId: "retained-image",
  };
  await createSqlModalStore(db, scope).reserve("repoint-fixture", machine);
  await db.query(
    "insert into modal_server_harnesses(scope,machine_id,harness,github_enabled,credential_id,credential_version) values($1,$2,$4::public.harness,false,$3,1)",
    [scopeKey(scope), physical, old.id, harness],
  );
  const auth = createModelAuthOwnership(
    db,
    ENCRYPTION_KEY,
    undefined,
    undefined,
    async () => ({
      provider,
      providerSandboxId: physical,
    }),
    options.shared
      ? {
          origin: "https://armada.example",
          fetch: Object.assign(
            async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
              throw Error("Unexpected upstream refresh in handoff fixture.");
            },
            { preconnect: fetch.preconnect },
          ),
        }
      : undefined,
  );
  const environment = modalLaunchEnvironment({
    sql: db,
    vault: createSqlVaultStore(db),
    encryptionKey: ENCRYPTION_KEY,
    scope,
    scopeKey: scopeKey(scope),
    callerUserId: people.owner,
    modelAuth: auth,
  });
  let current = machine,
    stops = 0,
    boots = 0,
    failOnce = options.failAfterBoot === true,
    used: string | undefined = SECRETS.orgOpenai;
  let delivered: Record<string, string> = {};
  let subscription: { url: string; capability: string } | undefined;
  const readMachine = async () => {
    const row = (
      await db.query<{ record: Machine }>("select record from modal_machines where scope=$1 and id=$2", [
        scopeKey(scope),
        physical,
      ])
    ).rows[0]!;
    return row.record;
  };
  const provider: Provider = {
    ...fakeBoat().provider,
    id: options.boat ? "boat" : "modal",
    async get() {
      return { ...current.info, physicalGeneration: String(current.generation) };
    },
    async hasActiveTurns() {
      return options.active === true;
    },
    async getPrompt({ promptId }) {
      return { promptId, status: "finished", done: true };
    },
    async stop() {
      stops++;
      if (options.stopUncertain) return;
      current = await readMachine();
      current = {
        ...current,
        phase: "stopped",
        info: {
          ...current.info,
          state: "stopped",
          providerState: "stopped",
          ...(options.diskLost ? { stopNote: "checkpoint_failed_disk_not_retained" } : {}),
        },
      };
      if (options.diskLost) delete current.recoveryImageId;
      await db.query("update modal_machines set record=$3::jsonb where scope=$1 and id=$2", [
        scopeKey(scope),
        physical,
        JSON.stringify(current),
      ]);
    },
    async exec(request) {
      if (request.preservationStage)
        return {
          detached: false,
          timedOut: false,
          truncated: false,
          exitCode: 0,
          stdout: options.preservationFails ? "{}" : JSON.stringify({ status: "clean" }),
          stderr: "",
        };
      boots++;
      current = await readMachine();
      const config = await environment(current, {});
      expect(config.execEnv).not.toHaveProperty("OPENAI_API_KEY");
      expect(config.credentialRepoint).toBeString();
      configureClaudeEndpoint(config.claudeEnv);
      delivered = harness === "claude" ? config.claudeEnv : config.codexEnv;
      subscription = config.subscription;
      if (subscription) expect(config.codexAuthJson).toBeUndefined();
      used = config.codexAuthJson
        ? JSON.parse(config.codexAuthJson).tokens.access_token
        : (delivered.OPENAI_API_KEY ?? delivered.ANTHROPIC_AUTH_TOKEN ?? delivered.ANTHROPIC_API_KEY);
      current = { ...current, phase: "active", info: { ...current.info, state: "ready", providerState: "active" } };
      await db.query("update modal_machines set record=$3::jsonb where scope=$1 and id=$2", [
        scopeKey(scope),
        physical,
        JSON.stringify(current),
      ]);
      if (options.removeMemberAfterBoot) {
        options.removeMemberAfterBoot = false;
        await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
      }
      if (options.revokeAfterBoot) await db.query("update credentials set status='revoked' where id=$1", [target.id]);
      if (failOnce) {
        failOnce = false;
        throw new ProviderError({
          provider: "modal",
          code: "unavailable",
          message: "Synthetic acknowledgment lost after native restore",
          retryable: true,
        });
      }
      return { detached: false, timedOut: false, truncated: false, exitCode: 0, stdout: "", stderr: "" };
    },
    async delete() {
      current = { ...current, phase: "deleted", info: { ...current.info, state: "stopped", providerState: "deleted" } };
      return { status: "deleted" };
    },
    async prompt(request) {
      await auth.assertCredentialReady(provider, physical);
      // External-token clients consume the private grant at turn admission,
      // not while idle compute is only bootstrapping the handoff.
      if (subscription) {
        const access = await auth.broker!.route(
          new Request(subscription.url, {
            method: "POST",
            headers: { authorization: `Bearer ${subscription.capability}` },
            body: "{}",
          }),
        );
        expect(access?.status).toBe(200);
        const body = await access!.text();
        expect(body).not.toContain("replacement-refresh-token");
        used = JSON.parse(body).accessToken;
      }
      if (!used) throw Error("Selected native credentials were not delivered.");
      return { promptId: "new-prompt", conversationId: request.conversationId ?? "new-conversation", status: "queued" };
    },
  };
  const service = createCredentialRepoint(db, ENCRYPTION_KEY, { resolve: async () => provider }, auth);
  const context = {
    caller,
    data: createSqlData(db)(caller),
    launchCredentials: launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, auth),
    credentialRepoint: service,
    provider: async () => provider,
    exposedSecrets: async () => [],
    now: () => new Date(),
    sleep: async () => {},
  };
  return {
    db,
    people,
    caller,
    id,
    target,
    old,
    secret,
    scope,
    physical,
    service,
    provider,
    auth,
    context,
    get delivered() {
      return delivered;
    },
    get subscription() {
      return subscription;
    },
    get used() {
      return used;
    },
    get stops() {
      return stops;
    },
    get boots() {
      return boots;
    },
    readMachine,
  };
}

test.each([false, true])(
  "removing an API-key pin uses its eligible subscription default and retained conversation (shared: %s)",
  async (shared) => {
    const f = await fixture({ native: true, shared });
    try {
      await f.db.query("update credentials set status='deleted' where id=$1", [f.old.id]);
      const sent = await callSharedTool(f.context, "send", { id: f.id, prompt: "Continue the existing work" });
      expect(sent).toMatchObject({
        id: f.id,
        conversationId: "existing-conversation",
        credentialNote: "The pinned account was removed. This sandbox now uses your default account.",
      });
      expect(f.used).toBe("replacement-access-token");
      if (shared) expect(f.subscription).toMatchObject({ url: "https://armada.example/api/internal/model/access" });
      expect(f.stops).toBe(1);
      const saved = await createSqlData(f.db)(f.caller).sandboxes.get(f.id);
      expect(saved).toMatchObject({
        credentialId: f.target.id,
        credentialVersion: 1,
        credentialDeliveryPending: false,
        conversationIds: ["existing-conversation"],
      });
      expect(JSON.stringify(sent)).not.toContain("replacement-access-token");
      expect(JSON.stringify(sent)).not.toContain(SECRETS.orgOpenai);
      expect((await f.readMachine()).info.labels.credentialId).toBe(f.target.id);
      let quotaReads = 0;
      const quota = await createModelUsageApi(f.db).read(f.caller, f.target.id, f.id, async () => {
        quotaReads++;
        return { provider: f.provider, providerSandboxId: f.physical };
      });
      expect(quota).toMatchObject({ accountId: f.target.id, status: "unavailable", windows: [] });
      expect(quotaReads).toBe(0);
      await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.owner]);
      await f.db.query("set role authenticated");
      try {
        expect(
          (await f.db.query<{ credential_note: string }>("select credential_note from sandboxes where id=$1", [f.id]))
            .rows[0]?.credential_note,
        ).toContain("default account");
        await expect(f.db.query("select redaction_enc from sandbox_model_credentials")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await f.db.query("reset role");
      }
    } finally {
      await f.db.close();
    }
  },
  30_000,
);

test.each(["other-owner", "wrong-harness", "active-other-conversation", "uncertain-stop", "leased"] as const)(
  "re-point refuses unsafe selection without changing billing identity (%s)",
  async (mode) => {
    const f = await fixture({ active: mode === "active-other-conversation", stopUncertain: mode === "uncertain-stop" });
    try {
      let target = f.target.id,
        caller = f.caller;
      if (mode === "other-owner")
        caller = { ...caller, userId: f.people.admin, orgs: [{ orgId: f.people.org, role: "admin" }] };
      if (mode === "leased")
        await f.db.query(
          "update sandboxes set activity_lease_id=$2::uuid,activity_until=now()+interval '1 hour' where id=$1",
          [f.id, crypto.randomUUID()],
        );
      if (mode === "wrong-harness")
        target = (
          await f.db.query<{ id: string }>(
            "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
            [f.people.owner],
          )
        ).rows[0]!.id;
      await expect(f.service.repoint(caller, { id: f.id, credentialId: target })).rejects.toMatchObject({
        code:
          mode === "leased"
            ? "sandbox_not_ready"
            : mode === "other-owner"
              ? "not_found"
              : mode === "wrong-harness"
                ? "credential_refused"
                : mode === "uncertain-stop"
                  ? "credential_binding_unsafe"
                  : "conflict",
      });
      expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialId).toBe(f.old.id);
      expect(f.boots).toBe(0);
      if (mode !== "uncertain-stop") expect(f.stops).toBe(0);
    } finally {
      await f.db.close();
    }
  },
  30_000,
);

test("a restored matching Modal policy can finish a pending automatic handoff after a lost ACK", async () => {
  const f = await fixture({ failAfterBoot: true });
  try {
    await f.db.query("update credentials set status='deleted' where id=$1", [f.old.id]);
    await expect(callSharedTool(f.context, "send", { id: f.id, prompt: "first attempt" })).rejects.toBeDefined();
    expect((await f.readMachine()).phase).toBe("active");
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialDeliveryPending).toBe(true);
    await expect(f.auth.assertCredentialReady(f.provider, f.physical)).rejects.toMatchObject({ code: "conflict" });
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    const result = await callSharedTool(f.context, "send", { id: f.id, prompt: "resume the pending account handoff" });
    expect(result).toMatchObject({
      credentialNote: "The pinned account was removed. This sandbox now uses your default account.",
    });
    expect(f.stops).toBe(1);
    expect(f.used).toBe("sk-proj-replacement-api-secret");
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialDeliveryPending).toBe(false);
  } finally {
    await f.db.close();
  }
}, 30_000);

test("account revocation during native delivery cannot acknowledge a ready binding or expose output", async () => {
  const f = await fixture({ revokeAfterBoot: true });
  try {
    await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
      code: "credential_refused",
    });
    const saved = await createSqlData(f.db)(f.caller).sandboxes.get(f.id);
    expect(saved?.credentialDeliveryPending).toBe(true);
    expect(saved?.credentialNote).toContain("pending");
    await expect(callSharedTool(f.context, "logs", { id: f.id })).rejects.toThrow("Account delivery is pending");
    const material = (
      await f.db.query<{ configuration_enc: Uint8Array; redaction_enc: Uint8Array }>(
        "select configuration_enc,redaction_enc from sandbox_model_credentials where sandbox_id=$1",
        [f.id],
      )
    ).rows[0]!;
    expect(JSON.parse(await decryptSecret(new Uint8Array(material.redaction_enc), ENCRYPTION_KEY))).toContain(f.secret);
    const next = (
      await f.db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'openai','Next eligible',$2) returning id",
        [f.people.owner, await encryptSecret("sk-proj-next-eligible-secret", ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: next.id });
    expect(f.used).toBe("sk-proj-next-eligible-secret");
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialDeliveryPending).toBe(false);
  } finally {
    await f.db.close();
  }
}, 30_000);

test.each(["replaced", "revoked"] as const)(
  "automatic fallback never silently changes a still-existing %s pin",
  async (mode) => {
    const f = await fixture();
    try {
      if (mode === "replaced")
        await f.db.query("update credentials set value_enc=$2 where id=$1", [
          f.old.id,
          await encryptSecret("sk-proj-replaced-old-account", ENCRYPTION_KEY),
        ]);
      else await f.db.query("update credentials set status='revoked' where id=$1", [f.old.id]);
      await expect(
        callSharedTool(f.context, "send", { id: f.id, prompt: "Do not silently replace this account" }),
      ).rejects.toMatchObject({ code: "credential_refused" });
      expect(f.stops).toBe(0);
      expect(f.boots).toBe(0);
      expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialId).toBe(f.old.id);
    } finally {
      await f.db.close();
    }
  },
  30_000,
);

test("an org admin can still send with another owner's unchanged valid org pin without entering re-pointing", async () => {
  const f = await fixture();
  try {
    const admin: Caller = { ...f.caller, userId: f.people.admin, orgs: [{ orgId: f.people.org, role: "admin" }] };
    const result = await callSharedTool({ ...f.context, caller: admin, data: createSqlData(f.db)(admin) }, "send", {
      id: f.id,
      prompt: "Existing permitted org-account operation",
    });
    expect(result).toMatchObject({ id: f.id, credentialNote: null });
    expect(f.stops).toBe(0);
    expect(f.boots).toBe(0);
    expect((await f.db.query("select 1 from sandbox_model_credentials where sandbox_id=$1", [f.id])).rows).toHaveLength(
      0,
    );
  } finally {
    await f.db.close();
  }
}, 30_000);

test("membership revoked during native delivery refuses ACK until a new authorized retry", async () => {
  const f = await fixture({ removeMemberAfterBoot: true });
  try {
    await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
      code: "credential_refused",
    });
    expect(
      (
        await f.db.query<{ credential_delivery_pending: boolean }>(
          "select credential_delivery_pending from sandboxes where id=$1",
          [f.id],
        )
      ).rows[0]?.credential_delivery_pending,
    ).toBe(true);
    await f.db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [f.people.org, f.people.owner]);
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialDeliveryPending).toBe(false);
  } finally {
    await f.db.close();
  }
}, 30_000);

test("a claim committed before a lost admission ACK remains recoverable through the product even with a detached public pin", async () => {
  const f = await fixture({ native: true });
  try {
    await f.db.query("update sandboxes set task_prompt_id='retained-turn' where id=$1", [f.id]);
    const original = f.auth.claimLegacy.bind(f.auth);
    const interrupted = spyOn(f.auth, "claimLegacy").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Synthetic admission response lost after commit");
    });
    await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toThrow(
      "Synthetic admission response lost",
    );
    interrupted.mockRestore();
    expect(await createSqlData(f.db)(f.caller).sandboxes.get(f.id)).toMatchObject({
      credentialId: null,
      credentialDeliveryPending: true,
      status: "stopped",
    });
    // Production Modal turn/event reads are fenced while delivery is pending.
    // Status/wait must still expose the durable recovery state, without I/O.
    const context = { ...f.context, storedProvider: async () => f.provider };
    const liveProvider = spyOn(context, "provider");
    const storedProvider = spyOn(context, "storedProvider");
    const nativeRead = spyOn(f.provider, "getPrompt").mockImplementation(async () => {
      await f.auth.assertCredentialReady(f.provider, f.physical);
      throw Error("Pending native reads must remain fenced.");
    });
    try {
      for (const [tool, args] of [
        ["status", { id: f.id }],
        ["wait", { id: f.id, timeout_seconds: 0 }],
      ] as const)
        expect(await callSharedTool(context, tool, args)).toMatchObject({
          id: f.id,
          status: "stopped",
          credentialDeliveryPending: true,
          credentialNote: expect.stringContaining("pending"),
          prompt: null,
        });
      expect(liveProvider).not.toHaveBeenCalled();
      expect(storedProvider).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
    } finally {
      liveProvider.mockRestore();
      storedProvider.mockRestore();
      nativeRead.mockRestore();
    }
    const actor = { userId: f.people.owner, orgId: f.people.org, role: "member" as const };
    expect(await f.auth.holder(actor, f.target.id, 1)).toMatchObject({ sandboxId: f.id, requiresReconnect: true });
    await f.db.query("update credentials set value_enc=$2 where id=$1", [
      f.target.id,
      await encryptSecret(
        JSON.stringify({
          tokens: {
            access_token: "fresh-recovery-access",
            refresh_token: "fresh-recovery-refresh",
            account_id: "replacement-native-account",
          },
        }),
        ENCRYPTION_KEY,
      ),
    ]);
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    expect(await f.auth.holder(actor, f.target.id, 2)).toMatchObject({ sandboxId: f.id, releasable: true });
    await f.auth.releaseFailed(actor, f.target.id, 2, f.id);
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.credentialDeliveryPending).toBe(false);
    const next = crypto.randomUUID();
    await f.auth.claimLegacy(actor, f.target.id, 2, next);
    expect(await f.auth.managed(next)).toBe(true);
  } finally {
    await f.db.close();
  }
}, 30_000);

for (const failure of ["preservation", "retained disk"] as const)
  test(`account handoff refuses an unsafe ${failure} transition without rebinding`, async () => {
    const f = await fixture(failure === "preservation" ? { preservationFails: true } : { diskLost: true });
    try {
      await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toThrow();
      const row = (
        await f.db.query<{ credential_id: string; credential_delivery_pending: boolean }>(
          "select credential_id,credential_delivery_pending from sandboxes where id=$1",
          [f.id],
        )
      ).rows[0]!;
      expect(row.credential_id).toBe(f.old.id);
      expect(row.credential_delivery_pending).toBe(false);
      if (failure === "preservation") expect(f.stops).toBe(0);
    } finally {
      await f.db.close();
    }
  });

for (const harness of ["claude", "codex"] as const)
  test(`Boat account changes refuse a custom ${harness} connection before lifecycle admission`, async () => {
    const f = await fixture({ boat: true, harness });
    try {
      await f.db.query("update credentials set value_enc=$2 where id=$1", [
        f.target.id,
        await encryptSecret(
          JSON.stringify({
            endpoint: {
              version: 1,
              baseUrl: "https://gateway.example/v1",
              ...(harness === "claude" ? { auth: "bearer" } : {}),
            },
            apiKey: "private-gateway-secret",
          }),
          ENCRYPTION_KEY,
        ),
      ]);
      const before = (await f.db.query("select * from sandboxes where id=$1", [f.id])).rows;
      await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
        code: "invalid",
      });
      const after = (await f.db.query("select * from sandboxes where id=$1", [f.id])).rows;
      expect(after).toEqual(before);
      expect(f.stops).toBe(0);
      expect(f.boots).toBe(0);
      expect(
        (await f.db.query("select sandbox_id from sandbox_model_credentials where sandbox_id=$1", [f.id])).rows,
      ).toEqual([]);
    } finally {
      await f.db.close();
    }
  });

test("Modal account re-point delivers the selected Claude gateway auth mode, then returns to an ordinary account", async () => {
  const f = await fixture({ harness: "claude" });
  try {
    for (const auth of ["bearer", "api-key"] as const) {
      const id = (
        await f.db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'anthropic',$2,$3) returning id",
          [
            f.people.owner,
            `Gateway ${auth}`,
            await encryptSecret(
              JSON.stringify({
                endpoint: { version: 1, baseUrl: "https://gateway.example/anthropic", auth },
                apiKey: `private-${auth}-credential`,
              }),
              ENCRYPTION_KEY,
            ),
          ],
        )
      ).rows[0]!.id;
      await f.service.repoint(f.caller, { id: f.id, credentialId: id });
      expect(f.delivered).toMatchObject({
        ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
        [auth === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]: `private-${auth}-credential`,
      });
      expect(f.delivered).not.toHaveProperty(auth === "bearer" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN");
      expect(f.delivered).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(f.delivered).not.toHaveProperty("ARMADA_CLAUDE_ENDPOINT");
    }
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    expect(f.delivered.ANTHROPIC_API_KEY).toBe(f.secret);
    expect(f.delivered).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(f.delivered).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect((await createSqlData(f.db)(f.caller).sandboxes.get(f.id))?.conversationIds).toEqual([
      "existing-conversation",
    ]);
  } finally {
    await f.db.close();
  }
}, 30000);

test("re-point's atomic stop admission refuses both new ordinary exec and already admitted commands without serializing them", async () => {
  const f = await fixture();
  try {
    const store = createSqlData(f.db)(f.caller).sandboxes;
    const first = await store.admitExec!(f.id),
      second = await store.admitExec!(f.id);
    expect(first).not.toBe(second);
    await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.stops).toBe(0);
    expect((await store.get(f.id))?.stopRequestedAt).toBeNull();
    await store.assertExecAdmission!(f.id, first);
    await store.assertExecAdmission!(f.id, second);
    await store.settleExec!(f.id, first);
    await store.settleExec!(f.id, second);
    // The failed lifecycle admission remains bounded, but its stop request was
    // ours alone and has been safely removed before any provider mutation.
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    let sampled = false;
    const observe = spyOn(f.provider, "hasActiveTurns").mockImplementation(async () => {
      sampled = true;
      // A caller whose earlier read passed before the fence must still fail
      // its final atomic exec admission, without dispatching provider work.
      await expect(store.admitExec!(f.id)).rejects.toMatchObject({ code: "sandbox_not_ready" });
      await expect(
        callSharedTool(f.context, "exec", { id: f.id, command: "echo must-not-start" }),
      ).rejects.toMatchObject({ code: "sandbox_not_ready" });
      expect((await f.db.query("select id from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toEqual([]);
      return false;
    });
    try {
      await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    } finally {
      observe.mockRestore();
    }
    expect(sampled).toBe(true);
    expect(f.stops).toBe(1);
  } finally {
    await f.db.close();
  }
});

test("unknown ordinary exec retains a claim without delaying normal Stop, and a confirmed stop makes account repair possible", async () => {
  const f = await fixture();
  try {
    const execute = spyOn(f.provider, "exec").mockImplementationOnce(async () => ({
      detached: true,
      processId: 123,
    }));
    try {
      await expect(callSharedTool(f.context, "exec", { id: f.id, command: "background-work" })).rejects.toMatchObject({
        code: "outcome_unknown",
      });
    } finally {
      execute.mockRestore();
    }
    expect((await f.db.query("select id from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toHaveLength(
      1,
    );
    const saved = (
      await f.db.query<{ activity_until: string | null }>("select activity_until from sandboxes where id=$1", [f.id])
    ).rows[0];
    expect(saved?.activity_until).toBeNull();
    await f.provider.stop({ sandboxId: f.physical });
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    expect((await f.db.query("select id from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});

test.each([false, true])(
  "ordinary exec holds admission through native synchronization (publication fails: %s)",
  async (publicationFails) => {
    const f = await fixture();
    try {
      let synchronized = false;
      const native = spyOn(f.context.launchCredentials, "nativeSecrets").mockImplementation(
        async (_actor, _id, _provider, _physical, phase) => {
          if (phase === "after") {
            synchronized = true;
            await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
              code: "conflict",
            });
            expect(f.stops).toBe(0);
            if (publicationFails) throw Error("Synthetic private synchronization acknowledgment lost.");
          }
          return [];
        },
      );
      const command = spyOn(f.provider, "exec").mockImplementationOnce(async () => ({
        detached: false,
        exitCode: 0,
        stdout: "safe result",
        stderr: "",
        timedOut: false,
        truncated: false,
      }));
      try {
        const result = callSharedTool(f.context, "exec", { id: f.id, command: "read work" });
        if (publicationFails) await expect(result).rejects.toMatchObject({ code: "outcome_unknown" });
        else expect(await result).toMatchObject({ stdout: "safe result" });
        expect(synchronized).toBe(true);
        expect(
          (await f.db.query("select active from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows,
        ).toEqual(publicationFails ? [{ active: false }] : []);
      } finally {
        native.mockRestore();
        command.mockRestore();
      }
    } finally {
      await f.db.close();
    }
  },
);

test("a live command paused before dispatch survives ordinary Stop as a fenced call, not permission to run against a rebound account", async () => {
  const f = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = {
    ...f.context,
    connections: {
      validate: async () => {},
      bind: async () => {},
      prepare: async () => {
        enter();
        await released;
      },
    },
  };
  let result: Promise<unknown> | undefined;
  try {
    result = callSharedTool(context, "exec", { id: f.id, command: "must not run against the new account" }).catch(
      (error) => error,
    );
    await entered;
    await callSharedTool(f.context, "stop", { id: f.id });
    await expect(f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.boots).toBe(0);
    expect((await f.db.query("select active from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toEqual([
      { active: true },
    ]);
    release();
    expect(await result).toMatchObject({ code: "sandbox_not_ready" });
    expect(f.boots).toBe(0);
    // The previous refusal retained only its bounded lease, not an introduced
    // stop fence. A settled/unknown call plus authoritative stop is recoverable.
    await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    expect((await f.db.query("select id from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toEqual([]);
  } finally {
    release();
    await result;
    await f.db.close();
  }
});

test("expired command calls cannot dispatch after a stopped-workspace repair", async () => {
  const f = await fixture();
  try {
    const store = createSqlData(f.db)(f.caller).sandboxes,
      claim = await store.admitExec!(f.id);
    await f.provider.stop({ sandboxId: f.physical });
    await f.db.query("update sandbox_exec_admissions set expires_at=now()-interval '1 second' where id=$1", [claim]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    await expect(store.assertExecAdmission!(f.id, claim)).rejects.toMatchObject({ code: "sandbox_not_ready" });
    expect((await f.db.query("select id from sandbox_exec_admissions where sandbox_id=$1", [f.id])).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});

test("retained account-change secrets redact for every authorized org event reader", async () => {
  const f = await fixture({ orgVisible: true });
  try {
    await f.db.query("update sandboxes set visibility='org' where id=$1", [f.id]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    // Replacing the vault value removes the first account revision everywhere
    // except the encrypted history retained by the actual account handoff.
    await f.db.query("update credentials set value_enc=$2,version=version+1 where id=$1", [
      f.target.id,
      await encryptSecret("current-repoint-api-key", ENCRYPTION_KEY),
    ]);
    await f.service.repoint(f.caller, { id: f.id, credentialId: f.target.id });
    expect(
      await exposedSecrets(createSqlVaultStore(f.db), ENCRYPTION_KEY, {
        userId: f.people.owner,
        orgId: f.people.org,
      }),
    ).not.toContain(f.secret);
    const retained = (
      await f.db.query<{ redaction_enc: Uint8Array }>(
        "select redaction_enc from sandbox_model_credentials where sandbox_id=$1",
        [f.id],
      )
    ).rows[0]!;
    expect(JSON.parse(await decryptSecret(new Uint8Array(retained.redaction_enc), ENCRYPTION_KEY))).toContain(f.secret);
    const events = [{ id: "retained", at: 1, kind: "message" as const, partial: false, tools: [], text: f.secret }];
    const read = (userId: string, orgId = f.people.org) =>
      f.auth.redactEvents(f.provider, f.physical, { userId, orgId }, events);
    for (const viewer of [f.people.owner, f.people.member, f.people.admin])
      expect(await read(viewer)).toMatchObject([{ text: "***" }]);
    await f.db.query("update sandboxes set visibility='private' where id=$1", [f.id]);
    for (const viewer of [f.people.member, f.people.admin])
      await expect(read(viewer)).rejects.toMatchObject({ code: "not_found" });
    expect(await read(f.people.owner)).toMatchObject([{ text: "***" }]);
    await f.db.query("update sandboxes set visibility='org' where id=$1", [f.id]);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await expect(read(f.people.member)).rejects.toMatchObject({ code: "not_found" });
    await expect(read(f.people.owner, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.db.close();
  }
}, 30000);
