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
let nativeScope = "",
  exit: number | null = null;
let providerReads = 0;
const effects = { allocations: 0, terminations: 0, runnerCalls: 0 };
const forbidden = () => {
  effects.runnerCalls++;
  throw Error("Unexpected native work in routing regression.");
};
class FakeModalClient {
  constructor(options: { tokenId: string; tokenSecret: string }) {
    assert(options.tokenId === modalId && options.tokenSecret === modalSecret, "Wrong fixture management authority.");
  }
  apps = {
    fromName: async (name: string, options: object) => {
      providerReads++;
      assert.equal(name, appName);
      assert.deepEqual(options, { environment: "main", createIfMissing: false });
      return { appId: binding.appId };
    },
  };
  sandboxes = {
    create: async () => {
      effects.allocations++;
      throw Error("Routing regression must not allocate.");
    },
    fromId: forbidden,
    fromName: async (name: string, physicalName: string, options: object) => {
      assert.equal(name, appName);
      assert.equal(physicalName, native.physicalName);
      assert.deepEqual(options, { environment: "main", includeTerminated: true });
      return {
        sandboxId: native.physicalId,
        getTags: async () => ({ armada_sandbox: native.info.id, armada_scope: nativeScope, armada_generation: "1" }),
        poll: async () => exit,
        terminate: async () => {
          effects.terminations++;
          exit = 0;
        },
        exec: forbidden,
        createConnectToken: forbidden,
      };
    },
  };
  close() {}
}
mock.module("modal", () => ({ ModalClient: FakeModalClient }));
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
await createSqlModalStore(sql, scope).reserve(created.operation.id, native);
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
  assert.equal(code, 0, err);
  assert.equal(err, "");
  return JSON.parse(out);
}
async function http<T = unknown>(method: string, path: string, body?: object, key = "serve-direct-key") {
  const response = await auditedFetch(`${activeOrigin}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, payload: (await response.json()) as T };
}
async function auditOwnerRoutes(expectedRevision: number) {
  assert.equal((await cli(["capabilities"], 200)).enabled, true);
  assert.equal((await cli(["list", "--org", orgId], 200)).items[0].id, id);
  assert.equal((await cli(["detail", id, "--org", orgId], 200)).orchestrator.revision, expectedRevision);
  assert.equal((await cli(["events", id, "--org", orgId], 200)).version, 1);
  await cli(
    [
      "create",
      "invalid-golden",
      "--org",
      orgId,
      "--golden",
      crypto.randomUUID(),
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
    404,
    "not_found",
  );
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
  assert.deepEqual(effects, { allocations: 0, terminations: 0, runnerCalls: 0 });
  const recovered = await cli(
    ["recover", id, "--org", orgId, "--expected-revision", "1", "--idempotency-key", "serve-recover"],
    202,
  );
  assert.equal(recovered.state, "succeeded");
  // The actual Next catch-all handlers proxy to the actual serve socket. This
  // was the missing production boundary in the original direct-handler tests.
  activeOrigin = proxyOrigin;
  const readsBeforeReplay = providerReads;
  const effectsBeforeReplay = { ...effects };
  const proxyRecovered = await cli(
    ["recover", id, "--org", orgId, "--expected-revision", "1", "--idempotency-key", "serve-recover"],
    202,
  );
  assert.deepEqual(proxyRecovered, recovered);
  assert.equal(providerReads, readsBeforeReplay, "Completed recovery replay must not resolve provider SDK state.");
  assert.deepEqual(effects, effectsBeforeReplay);
  const replayProviderReads = providerReads - readsBeforeReplay;
  await auditOwnerRoutes(2);

  assert.deepEqual(effects, { allocations: 0, terminations: 1, runnerCalls: 0 });
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
  // registered owner paths above must never be mistaken for that bare 404.
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
      error.message.includes("Armada server request failed (404)"),
  );
  assert.equal(routes.at(-1)?.status, 404);
  assert.equal(routes.at(-1)?.code, null);
  for (const secret of [token.token, modalId, modalSecret, modelSecret, key]) assert(!logs.join("\n").includes(secret));
  console.log(
    `SERVE_HTTP_ROUTE_RECEIPT ${JSON.stringify({ version: 1, baseline: "green", proxyRecovery: true, replayProviderReads, routes, effects })}`,
  );
} finally {
  await proxy.stop(true);
  await server.stop(true);
  await server.workerDone;
  await db.close();
}
