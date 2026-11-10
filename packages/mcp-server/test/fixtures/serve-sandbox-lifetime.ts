// Isolated infrastructure fakes only: production serve/auth/provider/lifecycle factories remain intact.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import * as core from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope } from "@armada/provider-modal";
import { forwardControl } from "../../../../apps/dashboard/src/app/api/v1/[...path]/control-proxy.ts";
import { applyMigrations, openDatabase } from "../../../../scripts/db/apply.ts";
import { fakeModalRuntime } from "./fake-modal-runtime.ts";

const db = await openDatabase();
await applyMigrations(db);
const sql: core.Sql = {
  query: (q, values) => db.query(q, values),
  transaction: (work) => db.transaction((tx) => work({ query: (q, values) => tx.query(q, values) })),
};
const sqlModule = await import("../../src/sql.ts");
mock.module(new URL("../../src/sql.ts", import.meta.url).pathname, () => ({ ...sqlModule, bunSql: () => sql }));
const key = Buffer.alloc(32, 19).toString("base64");
// Work preservation uses the process environment, just as the deployed server does.
process.env.ARMADA_ENCRYPTION_KEY = key;
const orgId = crypto.randomUUID(),
  ownerId = crypto.randomUUID(),
  memberId = crypto.randomUUID(),
  adminId = crypto.randomUUID(),
  modelId = crypto.randomUUID();
const binding = { workspace: "app:ap_lifetime_fixture", environment: "main", appId: "ap_lifetime_fixture" };
const appName = `armada-org-${orgId.replaceAll("-", "")}`;
const scope: Scope = { orgId, userId: ownerId, visibility: "org", binding };
const provenance = { credentialScope: "org" as const, credentialOwnerId: orgId };
const sourceId = `modal_${crypto.randomUUID()}`;
const source: Machine = {
  info: { id: sourceId, name: sourceId, state: "stopped", providerState: "stopped", labels: {} },
  generation: 1,
  phase: "stopped",
  golden: true,
  launchUserId: ownerId,
  physicalId: "sb_lifetime_source",
  physicalName: "lifetime-source",
  ttlSeconds: 86400,
  imageId: "im_lifetime_source",
  managementAuthority: provenance,
};
const modal = fakeModalRuntime({
  appName,
  appId: binding.appId,
  tokenId: "ak-lifetimefixture",
  tokenSecret: "as-lifetimefixture",
  skillRevision: "a".repeat(40),
  legacy: () => source,
  scope: () => "unused-source",
});
modal.release();
modal.failPreservation("missing_bun");
type Effect = { id: string; op: string; ttlSeconds?: number };
const effects: Effect[] = [];
const physicalIds = new Map<string, string>();
const conversations = new Map<string, string>();
type NativeSandbox = Awaited<ReturnType<InstanceType<typeof modal.Client>["sandboxes"]["create"]>>;
function logicalId(physicalId: string): string {
  const id = physicalIds.get(physicalId);
  assert(id, "Unknown physical sandbox");
  return id;
}
function auditedNative(sb: NativeSandbox): NativeSandbox {
  return {
    ...sb,
    terminate: async () => {
      effects.push({ id: logicalId(sb.sandboxId), op: "stop" });
      return sb.terminate();
    },
    snapshotFilesystem: async () => {
      effects.push({ id: logicalId(sb.sandboxId), op: "snapshot" });
      return sb.snapshotFilesystem();
    },
  };
}
class ModalClient extends modal.Client {
  constructor(options: ConstructorParameters<typeof modal.Client>[0]) {
    super(options);
    const sdk = this.sandboxes;
    this.sandboxes = {
      ...sdk,
      create: async (app, image, options) => {
        const sb = await sdk.create(app, image, options);
        const id = options.tags.armada_sandbox;
        assert(id);
        physicalIds.set(sb.sandboxId, id);
        const timeoutMs: unknown = Reflect.get(options, "timeoutMs");
        assert.equal(typeof timeoutMs, "number");
        effects.push({ id, op: "allocate", ttlSeconds: Number(timeoutMs) / 1000 });
        return auditedNative(sb);
      },
      fromId: async (id) => auditedNative(await sdk.fromId(id)),
      fromName: async (name, physicalName, options) => auditedNative(await sdk.fromName(name, physicalName, options)),
    };
  }
}
mock.module("modal", () => ({ ModalClient }));

await sql.query("insert into orgs(id,name) values($1,'Lifetime composition fixture')", [orgId]);
for (const [id, role] of [
  [ownerId, "member"],
  [memberId, "member"],
  [adminId, "admin"],
]) {
  await sql.query("insert into auth.users(id) values($1)", [id]);
  await sql.query("insert into members(org_id,user_id,role) values($1,$2,$3)", [orgId, id, role]);
}
await sql.query("update orgs set boat_api_key_enc=$2 where id=$1", [
  orgId,
  await core.encryptSecret("synthetic-lifetime-boat-key", key),
]);
for (const [kind, value] of [
  ["modal", JSON.stringify({ token_id: "ak-lifetimefixture", token_secret: "as-lifetimefixture" })],
] as const)
  await sql.query("insert into credentials(scope,owner_id,kind,value_enc,name) values('org',$1,$2,$3,$4)", [
    orgId,
    kind,
    await core.encryptSecret(value, key),
    `Lifetime ${kind}`,
  ]);
await sql.query(
  "insert into credentials(id,scope,owner_id,kind,value_enc,name) values($1,'org',$2,'openai',$3,'Lifetime model')",
  [modelId, orgId, await core.encryptSecret("synthetic-lifetime-model-key", key)],
);
await sql.query(
  "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'org',$1,$3,$4,'main')",
  [orgId, `org:${orgId}`, appName, binding.appId],
);
const nativeStore = createSqlModalStore(sql, scope);
await nativeStore.reserve("lifetime-source", source);
await nativeStore.saveImage({
  info: { name: "lifetime-modal-source", status: "ready", sourceSandboxId: sourceId },
  sourceId,
  imageId: "im_lifetime_source",
  goldenClean: true,
  managementAuthority: provenance,
});
const goldens = core.createSqlGoldenStore(sql);
const goldenNames = new Map<string, string>();
for (const provider of ["boat", "modal"] as const) {
  const golden = await goldens.insert({
    orgId,
    ownerId,
    provider,
    name: `Lifetime ${provider}`,
    visibility: "org",
    modal: provider === "modal" ? binding : null,
    config: { repos: [{ url: "https://github.com/example/lifetime.git", branch: "main", dir: "fixture" }], init: [] },
  });
  await goldens.setSnapshot(golden.id, `lifetime-${provider}-source`);
  goldenNames.set(provider, golden.name);
}
const tokens = new Map<string, string>();
for (const id of [ownerId, memberId, adminId])
  tokens.set(
    id,
    (await createServiceToken(createSqlAuthStore(sql), { userId: id, label: "lifetime fixture", now: new Date() }))
      .token,
  );

type BoatMachine = {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  archiveAfter: string;
  labels: Record<string, string>;
  desktopAvailable: boolean;
  snapshotAvailable: boolean;
  conversation?: string;
  turnRunning?: boolean;
  bootId: string;
};
const boats = new Map<string, BoatMachine>();
let shortBoatConfirmation = false;
const nativeFetch = globalThis.fetch;
const realFetch = nativeFetch.bind(globalThis);
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://supabase.invalid") {
    const token = new Headers(init?.headers).get("authorization")?.slice(7);
    return Response.json({ id: token === "fixture.personal.owner" ? ownerId : adminId });
  }
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.origin === modal.tunnelOrigin) {
    const physicalId = url.pathname.slice(1);
    const id = logicalId(physicalId);
    const packet = JSON.parse(String(init?.body)) as {
      version: number;
      requestId: string;
      op: string;
      input?: { command?: string; conversationId?: string };
    };
    if (packet.op === "prompt") {
      const conversationId = conversations.get(id) ?? crypto.randomUUID();
      assert(
        !packet.input?.conversationId || packet.input.conversationId === conversationId,
        "Modal conversation changed",
      );
      conversations.set(id, conversationId);
      effects.push({ id, op: "prompt" });
      return Response.json({
        version: 1,
        requestId: packet.requestId,
        result: { promptId: crypto.randomUUID(), conversationId, status: "running" },
      });
    }
    if (packet.op === "interrupt") effects.push({ id, op: "interrupt" });
    if (packet.op === "exec" && packet.input?.command?.includes("ARMADA_RECOVERY"))
      effects.push({ id, op: "preserve" });
    if (packet.op === "checkpoint") effects.push({ id, op: "checkpoint" });
    return realFetch(`${modal.localOrigin}${url.pathname}`, init);
  }
  assert.equal(url.origin, "https://boat.dev", "Unexpected outbound network in lifetime fixture");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const json = (value: object, status = 200) => Response.json({ ok: true, ...value }, { status });
  if (url.pathname === "/api/v1/sandboxes" && method === "POST") {
    const id = `bx_${crypto.randomUUID()}`;
    const machine: BoatMachine = {
      id,
      name: id,
      state: "running",
      labels: body.labels ?? {},
      createdAt: new Date().toISOString(),
      archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(),
      desktopAvailable: false,
      snapshotAvailable: false,
      bootId: crypto.randomUUID(),
    };
    boats.set(id, machine);
    effects.push({ id, op: "allocate", ttlSeconds: body.ttlSeconds });
    return json({ sandbox: machine }, 202);
  }
  const match = url.pathname.match(/^\/api\/v1\/sandboxes\/([^/]+)(.*)$/);
  assert(match, `Unexpected Boat route ${method} ${url.pathname}`);
  const machine = boats.get(decodeURIComponent(match[1] ?? ""));
  assert(machine, "Unknown Boat sandbox");
  const suffix = match[2];
  if (!suffix) {
    if (method !== "GET") {
      effects.push({ id: machine.id, op: "extend", ttlSeconds: body.ttlSeconds });
      machine.archiveAfter = new Date(Date.now() + (shortBoatConfirmation ? 1 : body.ttlSeconds) * 1000).toISOString();
    }
    return json({ sandbox: machine });
  }
  if (suffix === "/commands") {
    if (body.command?.includes("ARMADA_RECOVERY")) {
      assert(!machine.turnRunning, "Preservation must wait for terminal turn evidence");
      effects.push({ id: machine.id, op: "preserve" });
    }
    return json({
      type: "command.finished",
      success: true,
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: body.command?.includes("ARMADA_RECOVERY")
        ? JSON.stringify({ status: "failed", reason: "missing_bun" })
        : body.command === "cat /proc/sys/kernel/random/boot_id"
          ? machine.bootId
          : "",
    });
  }
  if (suffix === "/interrupt") {
    effects.push({ id: machine.id, op: "interrupt" });
    machine.turnRunning = false;
    return json({});
  }
  if (suffix === "/stop") {
    effects.push({ id: machine.id, op: "stop" });
    machine.state = "archived";
    return json({ id: machine.id, stop: { id: "fixture-stop", status: "completed" } }, 202);
  }
  if (suffix === "/resume") {
    effects.push({ id: machine.id, op: "resume" });
    machine.state = "running";
    return json({ sandbox: machine }, 202);
  }
  if (suffix === "/prompt") {
    effects.push({ id: machine.id, op: "prompt" });
    machine.conversation ??= crypto.randomUUID();
    machine.turnRunning = true;
    assert(!body.conversationId || body.conversationId === machine.conversation, "Boat conversation changed");
    return json({ promptId: crypto.randomUUID(), conversationId: machine.conversation, status: "running" }, 202);
  }
  if (suffix === "/conversations")
    return json({
      conversations: machine.conversation
        ? [{ id: machine.conversation, running: machine.turnRunning ?? false, lastHarness: "codex" }]
        : [],
    });
  if (suffix === "/events") return json({ events: [], pageInfo: { hasMore: false } });
  throw Error(`Unexpected Boat route ${method} ${url.pathname}`);
}) as typeof fetch;
globalThis.fetch = fakeFetch;
const { startServer } = await import("../../src/serve.ts");
const logs: string[] = [];
async function start() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return startServer(
    {
      PORT: String(port),
      ARMADA_DATABASE_URL: "postgres://fixture.invalid/db",
      SUPABASE_URL: "https://supabase.invalid",
      SUPABASE_ANON_KEY: "fixture-anon",
      ARMADA_AUTH_SECRET: "synthetic-lifetime-auth-secret",
      ARMADA_PUBLIC_URL: "https://lifetime.invalid",
      ARMADA_ENCRYPTION_KEY: key,
      ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS: "1800",
    },
    { log: (line) => logs.push(line), logError: (line) => logs.push(line) },
  );
}
let server = await start();
async function request<T = unknown>(action: string, body: object, expected = 200, userId = ownerId): Promise<T> {
  // The real background observer can briefly own a row. Retry only the closed admission conflict.
  for (let attempt = 0; attempt < 20; attempt++) {
    process.env.ARMADA_MCP_URL = `http://127.0.0.1:${server.port}/mcp`;
    const response = await forwardControl(
      new Request(`https://dashboard.test/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(userId)}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, org: orgId }),
      }),
      ["sandbox", action],
      fakeFetch,
    );
    const result = (await response.json()) as T & { error?: { code?: string } };
    if (expected !== 409 && response.status === 409 && result.error?.code === "sandbox_not_ready") continue;
    assert.equal(
      response.status,
      expected,
      `${action} ${JSON.stringify(body)}: ${JSON.stringify(result)}\n${logs.join("\n")}`,
    );
    return result;
  }
  throw Error(`${action}: real lifecycle admission did not settle`);
}
async function row(id: string) {
  const found = (
    await sql.query<{
      status: string;
      status_reason: string | null;
      expires_at: Date;
      effective_ttl_seconds: number;
      preservation_note: string | null;
      provider_sandbox_id: string;
      conversation_ids: string[];
    }>(
      "select status::text,status_reason,expires_at,effective_ttl_seconds,preservation_note,provider_sandbox_id,conversation_ids from sandboxes where id=$1",
      [id],
    )
  ).rows[0];
  assert(found);
  return found;
}
/** No gateway request registers this lease in memory: renewal must come from the HTTP extend composition. */
async function unusedBoatLease(sandboxId: string, nativeId: string): Promise<string> {
  const connection = crypto.randomUUID(),
    grant = crypto.randomUUID(),
    lease = crypto.randomUUID();
  const machine = boats.get(nativeId);
  assert(machine);
  await sql.query(
    "insert into mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type) values($1,$2,$3,'personal','lifetime renewal','http','https://unused-mcp.invalid','none')",
    [connection, orgId, ownerId],
  );
  await sql.query("insert into mcp_grants(id,connection_id,status) values($1,$2,'connected')", [grant, connection]);
  await sql.query("insert into mcp_bindings(sandbox_id,connection_id,grant_id) values($1,$2,$3)", [
    sandboxId,
    connection,
    grant,
  ]);
  await sql.query(
    "insert into mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,'installed',true) on conflict(sandbox_id) do update set physical_generation=excluded.physical_generation,revision=excluded.revision,configured=true",
    [sandboxId, JSON.stringify(["boat", nativeId, machine.bootId])],
  );
  await sql.query(
    "insert into mcp_leases(id,sandbox_id,connection_id,grant_id,org_id,owner_id,generation,sandbox_generation,hash,operations,expires_at) select $1,$2,$3,$4,$5,$6,1,mcp_generation,$7,array['tools'],now()+interval '30 seconds' from sandboxes where id=$2",
    [lease, sandboxId, connection, grant, orgId, ownerId, "b".repeat(64)],
  );
  return lease;
}
const scenarios: {
  provider: "boat" | "modal";
  active: boolean;
  id: string;
  nativeId: string;
  conversation: string | null;
}[] = [];
try {
  const missing = await request<{ error: { code: string } }>(
    "extend",
    { id: crypto.randomUUID(), ttl_seconds: 600 },
    404,
  );
  assert.equal(missing.error.code, "extension_not_found");
  for (const provider of ["boat", "modal"] as const) {
    for (const active of [false, true]) {
      const launch = await request<{ sandbox: { id: string } }>("launch", {
        golden: goldenNames.get(provider),
        provider,
        harness: "codex",
        credentialId: modelId,
        repo: "fixture",
        connections: [],
        ttlSeconds: 120,
      });
      const id = launch.sandbox.id;
      const before = await row(id);
      if (provider === "boat")
        assert.equal(
          effects.find((item) => item.id === before.provider_sandbox_id && item.op === "allocate")?.ttlSeconds,
          420,
        );
      if (provider === "modal")
        assert.equal(
          effects.find((item) => item.id === before.provider_sandbox_id && item.op === "allocate")?.ttlSeconds,
          2220,
          "A two-minute Modal launch must have only the configured 30-minute headroom plus five-minute preservation margin, not a 24h timer",
        );
      const unusedLease = provider === "boat" && !active ? await unusedBoatLease(id, before.provider_sandbox_id) : null;
      const deniedBefore = effects.length;
      const denied = await request<{ error: { code: string } }>("extend", { id, ttl_seconds: 600 }, 403, memberId);
      assert.equal(denied.error.code, "extension_not_allowed");
      assert.equal(effects.length, deniedBefore, "Denied member must not mutate provider state");
      let conversation: string | null = null;
      if (active)
        conversation = (await request<{ conversationId: string }>("send", { id, prompt: "remember lifetime-token" }))
          .conversationId;
      await request("extend", { id, ttl_seconds: 500 }, 200, active ? adminId : ownerId);
      const serviceToken = tokens.get(active ? adminId : ownerId)!;
      tokens.set(active ? adminId : ownerId, active ? "fixture.personal.admin" : "fixture.personal.owner");
      const extended = await request<{ id: string; ttlSeconds: number; expiresAt: string }>(
        "extend",
        { id, ttl_seconds: 600 },
        200,
        active ? adminId : ownerId,
      );
      tokens.set(active ? adminId : ownerId, serviceToken);
      if (unusedLease) {
        const renewed = (
          await sql.query<{ expires_at: Date }>("select expires_at from mcp_leases where id=$1", [unusedLease])
        ).rows[0];
        assert(renewed);
        assert.equal(
          new Date(renewed.expires_at).toISOString(),
          boats.get(before.provider_sandbox_id)?.archiveAfter,
          "HTTP extend must renew even an unused/restart-lost MCP lease to the confirmed physical deadline",
        );
      }
      assert.equal(extended.id, id);
      assert.equal(extended.ttlSeconds, 600);
      assert(new Date(extended.expiresAt).getTime() > new Date(before.expires_at).getTime());
      assert.equal(new Date((await row(id)).expires_at).toISOString(), extended.expiresAt);
      const status = await request<{ expiresAt: string }>("status", { id });
      assert.equal(
        status.expiresAt,
        extended.expiresAt,
        "HTTP status must expose the logical deadline, not provider hard TTL",
      );
      if (provider === "boat")
        assert.equal(
          effects.filter((item) => item.id === before.provider_sandbox_id && item.op === "extend").at(-1)?.ttlSeconds,
          900,
        );
      const acceptedDeadline = new Date((await row(id)).expires_at).toISOString();
      for (const ttl_seconds of [0, 2_592_001, 1, provider === "boat" ? 2_591_701 : 86_101]) {
        const refusal = await request<{ error: { code: string } }>(
          "extend",
          { id, ttl_seconds },
          ttl_seconds === 1 ? 409 : 400,
        );
        if (ttl_seconds > 0)
          assert.equal(refusal.error.code, ttl_seconds === 1 ? "extension_state" : "extension_maximum");
      }
      assert.equal(
        new Date((await row(id)).expires_at).toISOString(),
        acceptedDeadline,
        "Invalid/non-extending TTL must not publish",
      );
      if (provider === "boat") {
        shortBoatConfirmation = true;
        await request("extend", { id, ttl_seconds: 900 }, 409);
        shortBoatConfirmation = false;
        const shortened = await row(id);
        assert(
          ["stopping", "stopped"].includes(shortened.status),
          "A provider cap that shortens the old lifetime must schedule stop",
        );
        assert(new Date(shortened.expires_at).getTime() < new Date(acceptedDeadline).getTime());
        const lease = (
          await sql.query<{ activity_lease_id: string | null; stop_requested_at: Date | null }>(
            "select activity_lease_id,stop_requested_at from sandboxes where id=$1",
            [id],
          )
        ).rows[0]!;
        assert.equal(lease.activity_lease_id, null, "Preservation must not wait for an unknown-outcome lease");
        assert(lease.stop_requested_at || shortened.status === "stopped");
      } else {
        // Simulate an older VM whose physical grant has less headroom than the server maximum.
        const originalGrant = (await nativeStore.get(before.provider_sandbox_id)).grantExpiresAt;
        assert(originalGrant);
        await nativeStore.lease(before.provider_sandbox_id, async (native, save) => {
          native.grantExpiresAt = Date.now() + 900_000;
          await save(native);
        });
        const refusal = await request<{ error: { code: string } }>("extend", { id, ttl_seconds: 1200 }, 400);
        assert.equal(refusal.error.code, "extension_maximum");
        assert.equal(
          (
            await sql.query<{ activity_lease_id: string | null }>(
              "select activity_lease_id from sandboxes where id=$1",
              [id],
            )
          ).rows[0]?.activity_lease_id,
          null,
          "A definite refusal must release activity ownership for immediate retry/stop",
        );
        assert.equal(new Date((await row(id)).expires_at).toISOString(), acceptedDeadline);
        await nativeStore.lease(before.provider_sandbox_id, async (native, save) => {
          native.grantExpiresAt = originalGrant;
          await save(native);
        });
      }
      scenarios.push({ provider, active, id, nativeId: before.provider_sandbox_id, conversation });
    }
  }
  // Restarting serve runs its first real worker batch immediately. No sleeps, fake lifecycle factory,
  // manual helper invocation or reliance on the worker's one-second idle timer.
  await server.stop(true);
  await server.workerDone;
  const expirationStart = 0;
  for (const { id } of scenarios)
    await sql.query(
      "update sandboxes set expires_at=now()-interval '1 second',reconcile_after=now()-interval '1 second',reconcile_lease_until=null,activity_until=null where id=$1",
      [id],
    );
  server = await start();
  for (let attempt = 0; attempt < 1000; attempt++) {
    if ((await Promise.all(scenarios.map(({ id }) => row(id)))).every((item) => item.status === "stopped")) break;
    // Yield to actual SQL/SDK/socket work, never elapsed time.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (const scenario of scenarios) {
    const stopped = await row(scenario.id);
    assert.equal(stopped.status, "stopped", JSON.stringify({ scenario, stopped, logs, effects }));
    assert.equal(stopped.status_reason, "expired");
    assert.equal(stopped.preservation_note, "unpushed work could not be preserved (missing_bun)");
    const operations = effects
      .slice(expirationStart)
      .filter((item) => item.id === scenario.nativeId)
      .map((item) => item.op);
    assert(operations.indexOf("interrupt") >= 0, JSON.stringify({ scenario, operations }));
    assert(operations.indexOf("preserve") > operations.indexOf("interrupt"), JSON.stringify({ scenario, operations }));
    assert(operations.indexOf("stop") > operations.indexOf("preserve"), JSON.stringify({ scenario, operations }));
    if (scenario.provider === "modal") {
      assert(operations.indexOf("checkpoint") > operations.indexOf("preserve"));
      assert(operations.indexOf("snapshot") > operations.indexOf("checkpoint"));
      assert(operations.indexOf("stop") > operations.indexOf("snapshot"));
      const native = await nativeStore.get(scenario.nativeId);
      assert.equal(native.phase, "stopped");
      assert(native.recoveryImageId, "Expiry must retain the verified disk checkpoint");
    } else assert.equal(boats.get(scenario.nativeId)?.state, "archived");
    await request("extend", { id: scenario.id, ttl_seconds: 1200 }, 409);
    // Model an expiry stop still being confirmed when its owner explicitly retries stop.
    await sql.query("update sandboxes set status='stopping',stopped_at=null where id=$1", [scenario.id]);
    await request("stop", { id: scenario.id });
    assert.equal((await row(scenario.id)).status_reason, "expired", "Explicit stop must not erase the expiry reason");
    if (scenario.active) {
      const resumed = await request<{ conversationId: string }>("send", {
        id: scenario.id,
        prompt: "recall lifetime-token",
      });
      assert.equal(resumed.conversationId, scenario.conversation, "Expiry resume must reuse the saved conversation");
      const continued = await row(scenario.id);
      assert.equal(continued.status, "running");
      assert.equal(continued.status_reason, null);
      assert(new Date(continued.expires_at).getTime() > Date.now(), "Resume must rearm the logical lifetime");
    }
  }
  console.log(
    `SERVE_SANDBOX_LIFETIME_RECEIPT ${JSON.stringify({ providers: ["boat", "modal"], expiries: scenarios.length, activeExpiries: scenarios.filter((item) => item.active).length })}`,
  );
} finally {
  await server.stop(true);
  await server.workerDone;
  await modal.close();
  await db.close();
}
