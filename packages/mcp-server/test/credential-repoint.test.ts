import { expect, spyOn, test } from "bun:test";
import { createSqlVaultStore, decryptSecret, encryptSecret, type Provider, ProviderError } from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { configureClaudeEndpoint } from "../../agent-runtime/src/claude-endpoint.ts";
import type { Caller } from "../src/caller.ts";
import { createCredentialRepoint } from "../src/credential-repoint.ts";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { modalLaunchEnvironment } from "../src/modal-launch-environment.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createModelUsageApi } from "../src/model-usage.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { database, ENCRYPTION_KEY, fakeBoat, SECRETS } from "./support.ts";

async function fixture(
  options: {
    native?: boolean;
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
    visibility: "private",
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
    `insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id,config) values($1,$2,$3,'repoint','private',$8::public.sandbox_provider,$4,$5,$6,$7::jsonb)`,
    [
      golden,
      people.org,
      people.owner,
      options.boat ? null : scope.binding.workspace,
      options.boat ? null : scope.binding.environment,
      options.boat ? null : scope.binding.appId,
      JSON.stringify({ repos: [], init: [] }),
      options.boat ? "boat" : "modal",
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
  const auth = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, async () => ({
    provider,
    providerSandboxId: physical,
  }));
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

test("removing an API-key pin lets the next ordinary send use the eligible subscription default and retain its conversation", async () => {
  const f = await fixture({ native: true });
  try {
    await f.db.query("update credentials set status='deleted' where id=$1", [f.old.id]);
    const sent = await callSharedTool(f.context, "send", { id: f.id, prompt: "Continue the existing work" });
    expect(sent).toMatchObject({
      id: f.id,
      conversationId: "existing-conversation",
      credentialNote: "The pinned account was removed. This sandbox now uses your default account.",
    });
    expect(f.used).toBe("replacement-access-token");
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
}, 30_000);

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
    const original = f.auth.claim.bind(f.auth);
    const interrupted = spyOn(f.auth, "claim").mockImplementationOnce(async (...args) => {
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
    await f.auth.claim(actor, f.target.id, 2, next);
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
