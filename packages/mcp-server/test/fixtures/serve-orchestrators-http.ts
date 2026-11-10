// Child-process-only infrastructure mocks: never replace production route/runtime factories.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import * as core from "@armada/core/server";
import type { Machine, Scope } from "@armada/provider-modal";
import { applyMigrations, openDatabase } from "../../../../scripts/db/apply.ts";
import { ArmadaApiError, createArmadaApiClient } from "../../../cli/src/armada-api.ts";
import { run } from "../../../cli/src/run.ts";
import { memorySessionStore } from "../../../cli/src/session.ts";
import { fakeModalRuntime } from "./fake-modal-runtime.ts";
import { checkSandboxSkillLaunch } from "./sandbox-skill-launch.ts";
import { catalogReceipt, catalogReference } from "./skillpack-catalog.ts";

const db = await openDatabase();
await applyMigrations(db);
const sql: core.Sql = {
  query: (q, values) => db.query(q, values),
  transaction: (work) => db.transaction((tx) => work({ query: (q, values) => tx.query(q, values) })),
};
const key = Buffer.alloc(32, 17).toString("base64");
const ownerId = crypto.randomUUID(),
  orgId = crypto.randomUUID(),
  modelId = crypto.randomUUID();
const modalId = "ak-servefixtureauthority",
  modalSecret = "as-servefixtureauthority",
  modelSecret = "synthetic-serve-openai-key";
const binding = { workspace: "app:ap_serve_fixture", environment: "main", appId: "ap_serve_fixture" };
const appName = `armada-user-${ownerId.replaceAll("-", "")}`;
const scope: Scope = { orgId, userId: ownerId, visibility: "private", binding };
let native: Machine;
let nativeScope = "";
const fake = fakeModalRuntime({
  appName,
  appId: binding.appId,
  tokenId: modalId,
  tokenSecret: modalSecret,
  skillRevision: "a".repeat(40),
  legacy: () => native,
  scope: () => nativeScope,
});
const effects = fake.effects;
mock.module("modal", () => ({ ModalClient: fake.Client }));
const sqlModule = await import("../../src/sql.ts");
mock.module(new URL("../../src/sql.ts", import.meta.url).pathname, () => ({ ...sqlModule, bunSql: () => sql }));
// Actual serve, control, authentication, factory, authority, stores and native adapter.
const { startServer } = await import("../../src/serve.ts");
const { LifecycleRuntimeStore } = await import("../../src/orchestrator-lifecycle-integration.ts");
const { createSqlModalStore, scopeKey } = await import("@armada/provider-modal");
await sql.query("insert into auth.users(id) values($1)", [ownerId]);
await sql.query("insert into orgs(id,name) values($1,'Serve fixture')", [orgId]);
await sql.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [orgId, ownerId]);
await sql.query(
  "insert into credentials(id,scope,owner_id,kind,value_enc,name) values($1,'user',$2,'openai',$3,'HTTP fixture model')",
  [modelId, ownerId, await core.encryptSecret(modelSecret, key)],
);
await sql.query(
  "insert into credentials(scope,owner_id,kind,value_enc,name) values('user',$1,'modal',$2,'HTTP fixture provider')",
  [ownerId, await core.encryptSecret(JSON.stringify({ token_id: modalId, token_secret: modalSecret }), key)],
);
await sql.query(
  "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'user',$3,$4,$5,'main')",
  [orgId, `user:${ownerId}`, ownerId, appName, binding.appId],
);
const goldens = core.createSqlGoldenStore(sql);
const golden = await goldens.insert({
  orgId,
  ownerId,
  name: "HTTP boot source",
  visibility: "private",
  provider: "modal",
  modal: binding,
  config: {
    repos: [{ url: "https://github.com/example/serve-fixture.git", branch: "main", dir: "fixture" }],
    init: [],
  },
});
await goldens.setSnapshot(golden.id, "serve-source-snapshot");
const store = new LifecycleRuntimeStore(sql, core.reserveOrchestratorOperation);
const configuration: core.OrchestratorCreate = {
  version: 1,
  orgId,
  name: "HTTP uncertain parent",
  goldenId: golden.id,
  provider: "modal",
  harness: "codex",
  model: "gpt-6.1-sol",
  modelAccountId: modelId,
};
const created = await store.create({
  ownerId,
  configuration,
  key: "serve-original-create",
  skillRevision: "a".repeat(40),
});
await store.complete(created, { state: "uncertain", parentState: "blocked", errorCode: "runtime_uncertain" });
const id = created.identity.id,
  nativeId = `modal_${crypto.randomUUID()}`;
nativeScope = scopeKey(scope);
native = {
  info: {
    id: nativeId,
    name: nativeId,
    state: "starting",
    providerState: "booting",
    labels: {
      sandbox: crypto.randomUUID(),
      operation: created.operation.id,
      orchestrator: id,
      owner: ownerId,
      org: orgId,
      visibility: "private",
      harness: "codex",
    },
  },
  generation: 1,
  phase: "booting",
  golden: false,
  launchUserId: ownerId,
  physicalId: "sb_serve_original",
  physicalName: `armada-${createHash("sha256").update(nativeId).digest("hex").slice(0, 32)}-1`,
  ttlSeconds: 86400,
  runtimePolicy: "explicit-vm-v1",
  runtimeEvidence: { version: 1, runtime: "vm", physicalId: "sb_serve_original", generation: 1 },
  imageId: "im_serve_source",
  sourceImage: { scopeKey: nativeScope, name: "serve-source-snapshot", imageId: "im_serve_source" },
  managementAuthority: { credentialScope: "user", credentialOwnerId: ownerId },
};
const nativeStore = createSqlModalStore(sql, scope);
await nativeStore.reserve(created.operation.id, native);
const sourceId = `modal_${crypto.randomUUID()}`;
const sourceMachine: Machine = {
  ...native,
  golden: true,
  phase: "stopped",
  physicalName: `armada-${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}-1`,
  info: { ...native.info, id: sourceId, name: sourceId, labels: {}, state: "stopped" },
};
delete sourceMachine.physicalId;
delete sourceMachine.runtimeEvidence;
delete sourceMachine.runtimePolicy;
delete sourceMachine.sourceImage;
await nativeStore.reserve("fixture-saved-golden", sourceMachine);
await nativeStore.saveImage({
  info: { name: "serve-source-snapshot", status: "ready", sourceSandboxId: sourceId },
  sourceId,
  imageId: "im_serve_source",
  goldenClean: true,
  managementAuthority: { credentialScope: "user", credentialOwnerId: ownerId },
});
const token = await createServiceToken(createSqlAuthStore(sql), {
  userId: ownerId,
  label: "HTTP process fixture",
  now: new Date(),
});
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const nativeFetch = globalThis.fetch;
const realFetch = nativeFetch.bind(globalThis);
const socketOrigins = new Set([origin]);
const socketFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === fake.tunnelOrigin) {
      const target = `${fake.localOrigin}${url.pathname}`;
      return input instanceof Request ? realFetch(new Request(target, input)) : realFetch(target, init);
    }
    assert(socketOrigins.has(url.origin), "Unexpected outbound network in serve regression.");
    return realFetch(input, init);
  },
  {
    preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
      assert(socketOrigins.has(new URL(String(args[0])).origin), "Unexpected outbound preconnect.");
      return nativeFetch.preconnect(...args);
    },
  },
);
globalThis.fetch = socketFetch;
const logs: string[] = [];
const server = await startServer(
  {
    PORT: String(port),
    ARMADA_DATABASE_URL: "postgres://fixture.invalid/db",
    SUPABASE_URL: "https://supabase.invalid",
    SUPABASE_ANON_KEY: "fixture-anon",
    ARMADA_AUTH_SECRET: "synthetic-serve-auth-secret",
    ARMADA_PUBLIC_URL: "https://serve-composition.invalid",
    ARMADA_ENCRYPTION_KEY: key,
    ARMADA_ORCHESTRATOR_PAIRS: "modal:codex",
    ARMADA_ORCHESTRATOR_SKILL_REVISION: "a".repeat(40),
  },
  { log: (line) => logs.push(line), logError: (line) => logs.push(line) },
);
type DashboardRoute = (request: Request, context: { params: Promise<{ path: string[] }> }) => Promise<Response>;
const dashboardRouteModule = new URL("../../../../apps/dashboard/src/app/api/v1/[...path]/route.ts", import.meta.url)
  .href;
const { GET, POST }: Record<"GET" | "POST", DashboardRoute> = await import(dashboardRouteModule);
process.env.ARMADA_MCP_URL = `${origin}/mcp`;
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return Response.json({ error: "not_found" }, { status: 404 });
    const context = {
      params: Promise.resolve({ path: url.pathname.slice("/api/v1/".length).split("/").map(decodeURIComponent) }),
    };
    return request.method === "GET" ? GET(request, context) : POST(request, context);
  },
});
const proxyOrigin = `http://127.0.0.1:${proxy.port}`;
socketOrigins.add(proxyOrigin);
let activeOrigin = origin;
type Entry = { via: "server" | "dashboard"; method: string; path: string; status: number; code: string | null };
const routes: Entry[] = [];
async function auditedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const response = await socketFetch(request);
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null;
  routes.push({
    via: new URL(request.url).origin === origin ? "server" : "dashboard",
    method: request.method,
    path: new URL(request.url).pathname,
    status: response.status,
    code: typeof payload?.error === "object" ? (payload.error.code ?? null) : null,
  });
  return response;
}
async function cli(args: string[], expectedStatus: number, expectedError?: string) {
  let out = "",
    err = "";
  const auth = {
    env: { ARMADA_URL: activeOrigin, ARMADA_TOKEN: token.token },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    fetch: auditedFetch,
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  const count = routes.length;
  const code = await run(["orchestrator", ...args, "--json"], auth, { auth });
  assert.equal(routes.length, count + 1, "CLI must issue exactly one real request.");
  assert.equal(routes.at(-1)?.status, expectedStatus, `CLI route ${JSON.stringify(routes.at(-1))}: ${err}`);
  if (expectedError) {
    assert.equal(code, 1);
    assert.equal(JSON.parse(err).error.code, expectedError);
    assert(!err.includes("Armada server request failed (404)"));
    return null;
  }
  assert.equal(err, "");
  const payload = JSON.parse(out);
  assert.equal(code, payload.state === "failed" || payload.state === "uncertain" ? 1 : 0, err);
  return payload;
}
async function http<T = unknown>(method: string, path: string, body?: object, key = "serve-direct-key") {
  const response = await auditedFetch(`${activeOrigin}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, payload: (await response.json()) as T };
}
const invalidGoldenId = crypto.randomUUID();
async function waitForOperation(parentId: string, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = await cli(["detail", parentId, "--org", orgId], 200);
    const operation = detail.operations.find((item: { id: string }) => item.id === operationId);
    if (operation?.state !== "pending") return { detail, operation };
  }
  throw Error("Create did not settle after bounded real HTTP polling.");
}
async function auditOwnerRoutes(expectedRevision: number) {
  assert.equal((await cli(["capabilities"], 200)).enabled, true);
  assert((await cli(["list", "--org", orgId], 200)).items.some((item: { id: string }) => item.id === id));
  assert.equal((await cli(["detail", id, "--org", orgId], 200)).orchestrator.revision, expectedRevision);
  assert.equal((await cli(["events", id, "--org", orgId], 200)).version, 1);
  const invalid = await cli(
    [
      "create",
      "invalid-golden",
      "--org",
      orgId,
      "--golden",
      invalidGoldenId,
      "--provider",
      "modal",
      "--agent",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--model-account",
      modelId,
      "--idempotency-key",
      "serve-invalid-create",
    ],
    202,
  );
  assert.equal((await waitForOperation(invalid.orchestratorId, invalid.id)).operation.state, "failed");
  for (const action of ["send", "steer", "stop", "resume"]) {
    await cli(
      [
        action,
        id,
        ...(["send", "steer"].includes(action) ? ["synthetic-private-message"] : []),
        "--org",
        orgId,
        "--expected-revision",
        "0",
        "--idempotency-key",
        `serve-${action}`,
      ],
      409,
      "conflict",
    );
  }
  const reconciled = await http<{ operation: { id: string } }>(
    "POST",
    "/orchestrators/reconcile",
    { orgId, action: "create", configuration },
    "serve-original-create",
  );
  assert.equal(reconciled.response.status, 202);
  assert.equal(reconciled.payload.operation.id, created.operation.id);
  for (const resource of ["settings", "waits"])
    assert.equal((await http("GET", `/orchestrators/${id}/${resource}?orgId=${orgId}`)).response.status, 200);
  const settings = await http<{ error: { code: string } }>("POST", `/orchestrators/${id}/settings`, {
    orgId,
    expectedRevision: 0,
    idleSeconds: 900,
    maxActiveChildren: null,
  });
  assert.equal(settings.response.status, 409);
  assert.equal(settings.payload.error.code, "conflict");
  for (const suffix of ["waits", `waits/${crypto.randomUUID()}/renew`, `waits/${crypto.randomUUID()}/release`]) {
    const body =
      suffix === "waits"
        ? {
            orgId,
            expectedRevision: 0,
            kind: "child",
            reference: crypto.randomUUID(),
            reason: "fixture wait",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : suffix.endsWith("renew")
          ? { orgId, expectedRevision: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() }
          : { orgId, expectedRevision: 0 };
    const wait = await http<{ error: { code: string } }>("POST", `/orchestrators/${id}/${suffix}`, body);
    assert.equal(wait.response.status, 409);
    assert.equal(wait.payload.error.code, "machine_identity_unavailable");
  }
}

try {
  assert.equal((await socketFetch(`${origin}/healthz`)).status, 200);
  await auditOwnerRoutes(1);
  assert.deepEqual(effects, {
    allocations: 0,
    allocationAttempts: 0,
    terminations: 0,
    runnerCalls: 0,
    modelCalls: 0,
    promptCalls: 0,
    skillLaunchOrder: [],
    mcpConfigurations: 0,
    epochInstalls: 0,
  });
  const recovered = await cli(
    ["recover", id, "--org", orgId, "--expected-revision", "1", "--idempotency-key", "serve-recover"],
    202,
  );
  assert.equal(recovered.state, "succeeded");
  // The actual Next catch-all handlers proxy to the actual serve socket. This
  // was the missing production boundary in the original direct-handler tests.
  activeOrigin = proxyOrigin;
  const readsBeforeReplay = fake.providerReads();
  const effectsBeforeReplay = { ...effects };
  const proxyRecovered = await cli(
    ["recover", id, "--org", orgId, "--expected-revision", "1", "--idempotency-key", "serve-recover"],
    202,
  );
  assert.deepEqual(proxyRecovered, recovered);
  assert.equal(
    fake.providerReads(),
    readsBeforeReplay,
    "Completed recovery replay must not resolve provider SDK state.",
  );
  assert.deepEqual(effects, effectsBeforeReplay);
  const replayProviderReads = fake.providerReads() - readsBeforeReplay;
  await auditOwnerRoutes(2);

  assert.deepEqual(effects, {
    allocations: 0,
    allocationAttempts: 0,
    terminations: 1,
    runnerCalls: 0,
    modelCalls: 0,
    promptCalls: 0,
    skillLaunchOrder: [],
    mcpConfigurations: 0,
    epochInstalls: 0,
  });
  assert.equal((await cli(["detail", id, "--org", orgId], 200)).orchestrator.state, "stopped");
  assert.equal(
    (
      await sql.query<{ state: string }>("select state from orchestrator_operations where id=$1", [
        created.operation.id,
      ])
    ).rows[0]?.state,
    "failed",
  );
  // This deliberately unclaimed path reproduces the observed CLI fallback family;
  // registered owner paths above must never be mistaken for an undeployed route.
  const api = await createArmadaApiClient(
    { env: { ARMADA_URL: origin, ARMADA_TOKEN: token.token }, fetch: auditedFetch, session: memorySessionStore() },
    { preserveServerErrors: true },
  );
  await assert.rejects(
    api.request("/not-an-armada-route"),
    (error: unknown) =>
      error instanceof ArmadaApiError &&
      error.status === 404 &&
      error.serverCode === "unavailable" &&
      error.message.includes(`This Armada deployment at ${origin} does not serve /not-an-armada-route;`),
  );
  assert.equal(routes.at(-1)?.status, 404);
  assert.equal(routes.at(-1)?.code, null);
  // Actual async CREATE through serve+proxy, with actual default-zero managed
  // MCP preparation. The external allocation cannot finish before admission.
  const admitted = await cli(
    [
      "create",
      "actual-managed-create",
      "--skill",
      catalogReference,
      "--org",
      orgId,
      "--golden",
      golden.id,
      "--provider",
      "modal",
      "--agent",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--model-account",
      modelId,
      "--idempotency-key",
      "serve-actual-create",
    ],
    202,
  );
  assert.equal(admitted.state, "pending");
  assert.equal(effects.allocations, 0, "Create waited for external allocation before returning pending.");
  fake.release();
  const initialized = await waitForOperation(admitted.orchestratorId, admitted.id);
  for (const secret of [token.token, modalId, modalSecret, modelSecret, key, ...fake.privateTokens])
    assert(!logs.join("\n").includes(secret), "Sensitive value in server logs.");
  assert.equal(initialized.operation.state, "succeeded", `${JSON.stringify(initialized.operation)} ${logs.join("\n")}`);
  assert.equal(initialized.detail.orchestrator.state, "ready");
  assert.equal(initialized.detail.orchestrator.configuration.skill, catalogReference);
  assert.deepEqual(initialized.detail.orchestrator.skillReceipt, catalogReceipt);
  assert.equal(effects.allocationAttempts, 1);
  assert.equal(effects.allocations, 1);
  assert.equal(effects.modelCalls, 0);
  assert.equal(effects.mcpConfigurations, 0, "Default-zero keeps the real lifecycle's no-prior-bootstrap fast path.");
  assert.equal(effects.epochInstalls, 1);
  await assert.rejects(
    core.createSqlMcpRegistry(sql, key).sandboxConnections(ownerId, orgId, initialized.detail.orchestrator.sandboxId),
    (error: unknown) => error instanceof core.VaultError && error.code === "not_found",
  );
  let turnRevision = initialized.detail.orchestrator.revision;
  async function turn(action: string, text: string, requestKey: string) {
    const result = await cli(
      [
        action,
        admitted.orchestratorId,
        text,
        "--org",
        orgId,
        "--expected-revision",
        String(turnRevision),
        "--idempotency-key",
        requestKey,
      ],
      202,
    );
    turnRevision = result.revision;
    return result;
  }
  assert.equal((await turn("send", "hello", "idle-send")).state, "succeeded");
  const refused = await turn("steer", "too late", "idle-steer");
  assert.equal(refused.state, "failed", JSON.stringify(refused));
  assert.equal(refused.errorCode, "no_running_turn");
  const afterRefusal = await cli(["detail", admitted.orchestratorId, "--org", orgId], 200);
  assert.equal(afterRefusal.orchestrator.state, "ready");
  assert.equal(afterRefusal.orchestrator.blockedReason, null);
  assert.equal((await turn("send", "new turn", "idle-next-send")).state, "succeeded");
  // The same production bundle must keep ordinary child MCP preparation,
  // not pass children into its parent-only private preparation port.
  const epochToken = [...fake.privateTokens].find((value) => value.startsWith("armada_epoch_"));
  assert(epochToken);
  const childResponse = await socketFetch(`${origin}/api/v1/orchestrator-tools/launch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${epochToken}`,
      "content-type": "application/json",
      "idempotency-key": "serve-child-launch",
    },
    body: JSON.stringify({
      selection: {
        goldenId: golden.id,
        harness: "codex",
        credentialId: modelId,
        credentialVersion: 1,
        model: "gpt-6.1-sol",
      },
    }),
  });
  assert.equal(childResponse.status, 200);
  const childReceipt = (await childResponse.json()) as { result: { state: string; sandboxId: string } };
  assert.equal(childReceipt.result.state, "succeeded", "Child must retain ordinary MCP initialization.");
  assert(childReceipt.result.sandboxId);
  assert.equal(effects.allocations, 2);
  assert.equal(effects.epochInstalls, 1, "Child must not install a parent epoch.");
  for (const secret of [token.token, modalId, modalSecret, modelSecret, key, ...fake.privateTokens])
    assert(!logs.join("\n").includes(secret));
  // Ordinary stop survives collector failure notes and transport/receipt failures.
  // Archive decryption itself is covered by the core preservation tests, not this fake runner.
  const ordinary = async (action: string, body: object, status = 200) => {
    // The real background reconciler may own a short observation lease. Exercise
    // the closed retry contract without wall-clock sleeps or bypassing ownership.
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await socketFetch(`${origin}/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as any;
      if (
        (status === 200 || action === "steer") &&
        action !== "launch" &&
        response.status === 409 &&
        result.error?.code === "sandbox_not_ready"
      )
        continue;
      assert.equal(response.status, status, `${action}: ${JSON.stringify(result)}`);
      return result;
    }
    throw Error(`${action}: lifecycle admission never became available`);
  };
  const failures = [
    "missing_bun",
    "missing_git",
    "missing_openssl",
    "unavailable",
    "timeout",
    "size_limit",
    "collector_exit",
    "collector_signal",
    "collector_failed",
    "output_invalid",
    "output_truncated",
    "decrypt",
  ];
  for (const reason of failures) {
    fake.failPreservation(reason);
    const launched = await ordinary("launch", {
      golden: golden.name,
      org: orgId,
      provider: "modal",
      harness: "codex",
      credentialId: modelId,
      connections: [],
    });
    const sandboxId = launched.sandbox.id;
    assert(sandboxId, JSON.stringify(launched));
    // A live observation lease must be a closed retryable conflict, never a 503.
    // Own both fields: an in-flight observer must not clear this fixture's
    // deadline when it finishes under its previous lease token.
    await sql.query(
      "update sandboxes set reconcile_lease=$2,reconcile_lease_until=now()+interval '1 minute' where id=$1",
      [sandboxId, crypto.randomUUID()],
    );
    await ordinary("send", { id: sandboxId, prompt: "hello" }, 409);
    await sql.query("update sandboxes set reconcile_lease=null,reconcile_lease_until=null where id=$1", [sandboxId]);
    const sent = await ordinary("send", { id: sandboxId, prompt: "hello" });
    if (reason === failures[0]) {
      const refused = await ordinary(
        "steer",
        {
          id: sandboxId,
          text: "too late",
          conversation_id: sent.conversationId,
        },
        409,
      );
      assert.equal(refused.error.code, "no_running_turn");
      // The refused mutation must release its lease, not strand ordinary send.
      await ordinary("send", { id: sandboxId, prompt: "new turn", conversation_id: sent.conversationId });
    }
    const stopped = await ordinary("stop", { id: sandboxId });
    assert.equal(stopped.status, "stopped");
    const row = (
      await sql.query<{ status: string; preservation_note: string }>(
        "select status::text, preservation_note from sandboxes where id=$1",
        [sandboxId],
      )
    ).rows[0]!;
    assert.equal(row.status, "stopped");
    assert.equal(row.preservation_note, `unpushed work could not be preserved (${reason})`);
  }
  const epochsBeforeFailure = effects.epochInstalls;
  const callsBeforeFailure = effects.modelCalls;
  const failed = await cli(
    [
      "create",
      "missing method",
      "--org",
      orgId,
      "--golden",
      golden.id,
      "--provider",
      "modal",
      "--agent",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--model-account",
      modelId,
      "--skill",
      "example/missing@1.0.0",
      "--idempotency-key",
      "missing-method",
    ],
    202,
  );
  const blocked = await waitForOperation(failed.orchestratorId, failed.id);
  assert.equal(blocked.detail.orchestrator.state, "blocked");
  assert.equal(blocked.detail.orchestrator.skillReceipt, null);
  assert.equal(blocked.detail.orchestrator.conversationId, null);
  assert.equal(effects.epochInstalls, epochsBeforeFailure, "No delegated authority after failed install");
  assert.equal(effects.modelCalls, callsBeforeFailure, "No first turn after failed install");
  await checkSandboxSkillLaunch({
    sql,
    orgId,
    body: {
      golden: golden.name,
      org: orgId,
      provider: "modal",
      harness: "codex",
      credentialId: modelId,
      connections: [],
    },
    allocations: () => effects.allocations,
    prompts: () => effects.promptCalls,
    stops: () => effects.terminations,
    order: effects.skillLaunchOrder,
    request: async (action, body) => {
      const response = await socketFetch(`${origin}/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  });
  console.log(
    `SERVE_HTTP_ROUTE_RECEIPT ${JSON.stringify({ version: 1, baseline: "green", sandboxSkills: true, proxyRecovery: true, replayProviderReads, routes, effects })}`,
  );
} finally {
  fake.release();
  await proxy.stop(true);
  await server.stop(true);
  await server.workerDone;
  await fake.close();
  await db.close();
}
