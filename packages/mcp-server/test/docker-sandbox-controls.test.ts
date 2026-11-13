import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSqlAuthStore } from "@armada/auth";
import {
  type AgentEvent,
  type DockerSandboxStatus,
  isSandboxPlacementProvider,
  ProviderError,
  type SandboxListMetadata,
  type Sql,
} from "@armada/core";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { parseSandboxListMetadata } from "../../../apps/dashboard/src/lib/sandbox-access.ts";
import { sandboxListText } from "../../cli/src/sandbox-list.ts";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerNormalSend } from "../src/docker-normal-send.ts";
import { createDockerRuntimeLifecycle } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const controls = createDockerSandboxControls(sql, Buffer.alloc(32, 13).toString("base64"));
const key = Buffer.alloc(32, 13).toString("base64");
const service = createDockerRuntimeLifecycle(sql, key, { enabled: true });
const hosts = createDockerHostStore(sql, key);
const reservations = createDockerSandboxService(sql, key, { enabled: true });
const authority = createRuntimeEnrolments(sql, key);
const commands = createRuntimeCommands(authority, key);
const bootstrap = createDockerBootstrapService(sql, key, {
  enabled: true,
  serverUrl: "https://armada.example",
  architecture: "x64",
  manifest: {
    protocol: 1,
    platform: "linux",
    architecture: "x64",
    libc: "glibc",
    runtime: { sha256: "b".repeat(64), bytes: 42 },
    harnesses: { codex: { files: [{ path: "bin/codex" }] } },
  },
  credentials: launchCredentials(createSqlVaultStore(sql), key),
});
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});
async function fixture() {
  const orgId = randomUUID(),
    userId = randomUUID(),
    adminId = randomUUID(),
    credentialId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2)`, [userId, adminId]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `lifecycle-${orgId}`]);
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin')`, [
    orgId,
    userId,
    adminId,
  ]);
  const actor = { userId, orgId },
    admin = { userId: adminId, orgId };
  const registration = await hosts.issueRegistration(admin),
    installationId = randomUUID();
  const host = await hosts.exchangeRegistration(registration.registrationToken, installationId);
  await db.query(`insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)`, [
    credentialId,
    userId,
    await encryptSecret(`offline-lifecycle-${randomUUID()}`, key),
  ]);
  const sandbox = await reservations.reserve(actor, {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
  });
  await hosts.complete(host.hostToken, installationId, { requestId: sandbox.id, outcome: "completed" });
  await bootstrap.bootstrap(actor, sandbox.id, randomUUID());
  const job = await hosts.poll(host.hostToken, installationId);
  if (job?.operation !== "bootstrap") throw Error("missing bootstrap");
  await hosts.complete(host.hostToken, installationId, { requestId: job.requestId, outcome: "completed" });
  const enrol = () => authority.enrol(job.bootstrap.enrolmentToken);
  return { actor, admin, credentialId, sandbox, installationId, ...host, enrol };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function complete(session: Awaited<ReturnType<Fixture["enrol"]>>, payload: unknown, status = 200) {
  const next = await commands.next(session.runtimeToken, session.epoch);
  if (!next.command) throw Error("missing queued command");
  await commands.complete(session.runtimeToken, session.epoch, {
    epoch: session.epoch,
    requestId: next.command.requestId,
    status,
    body: { version: 1, requestId: next.command.requestId, result: payload },
  });
  return next.command;
}
async function ready(f: Fixture) {
  const session = await f.enrol(),
    requestId = randomUUID();
  expect(await service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "pending" });
  await complete(session, { ready: true, generation: session.epoch });
  expect(await service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "ready", epoch: session.epoch });
  return session;
}

function caller(actor: { userId: string; orgId: string }, role: "member" | "admin" = "member"): Caller {
  return { userId: actor.userId, orgs: [{ orgId: actor.orgId, role }], via: "supabase" };
}
async function invoke<T = Record<string, unknown>>(
  who: Caller,
  name: string,
  args: Record<string, unknown>,
  controller = controls,
): Promise<NoInfer<T>> {
  const reply = await controller.invoke(who, name, args);
  if (!reply.handled) throw Error("Docker request not handled");
  return reply.result as T;
}
async function publish(f: Fixture, session: Awaited<ReturnType<typeof ready>>, events: AgentEvent[], start = 1) {
  const response = await createRuntimeEvents(authority, key).route(
    new Request("https://armada.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
      body: JSON.stringify({
        sandboxId: f.sandbox.id,
        generation: session.epoch,
        events: events.map((event, index) => ({ sequence: start + index, event })),
      }),
    }),
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ acknowledgedSequence: start + events.length - 1 });
}
async function rejected(work: Promise<unknown>, code: string) {
  try {
    await work;
    throw Error("request unexpectedly allowed");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "docker", code });
  }
}

// The SQL boundary owns visibility, archive paging and machine acknowledgement;
// transport/schema coverage below can reuse this same real allocation fixture.
test("normal Docker reads authorize owner/admin with live membership, preserve native outcomes/usage, and retain archives", async () => {
  const f = await fixture(),
    session = await ready(f),
    who = caller(f.actor),
    admin = caller(f.admin, "admin");
  const promptId = randomUUID(),
    conversationId = randomUUID();
  const input = { requestId: randomUUID(), text: "begin" };
  await service.prompt(f.actor, f.sandbox.id, input);
  await complete(session, { promptId, conversationId, status: "queued" });
  await service.prompt(f.actor, f.sandbox.id, input);
  const pending = await invoke<DockerSandboxStatus>(who, "status", { id: f.sandbox.id });
  expect(pending).toMatchObject({
    provider: "docker",
    hostId: f.hostId,
    image: f.sandbox.image,
    golden: null,
    model: f.sandbox.model,
    harness: "codex",
    visibility: "private",
    conversationIds: [conversationId],
    prompt: { promptId, conversationId, state: "running" },
    settled: false,
  });
  await publish(f, session, [
    { id: "p-start", at: 1, kind: "prompt", promptId, conversationId, text: "begin", status: "running" },
    { id: "p-done", at: 2, kind: "prompt", promptId, conversationId, text: "begin", status: "finished" },
    {
      id: "tokens",
      at: 3,
      kind: "other",
      promptId,
      type: "armada/turnUsage",
      data: { model: f.sandbox.model, inputTokens: 50, outputTokens: 8, cachedTokens: 5 },
    },
  ]);
  const settled = await invoke<DockerSandboxStatus>(admin, "status", { id: f.sandbox.id, prompt_id: promptId });
  expect(settled).toMatchObject({
    status: "running",
    settled: true,
    prompt: { promptId, conversationId, state: "finished", reason: null },
    usage: {
      computeSeconds: null,
      turnCount: 1,
      turns: [{ promptId, inputTokens: 50, outputTokens: 8, cachedTokens: 5 }],
      tokenTotals: { inputTokens: 50, outputTokens: 8 },
    },
  });
  expect(settled.usage?.cost).toMatchObject({ usd: null, unpricedTurns: 1 });
  const busy = { requestId: randomUUID(), text: "busy", conversationId };
  await service.prompt(f.actor, f.sandbox.id, busy);
  const busyCommand = (await commands.next(session.runtimeToken, session.epoch)).command;
  if (!busyCommand) throw Error("missing busy command");
  await commands.complete(session.runtimeToken, session.epoch, {
    epoch: session.epoch,
    requestId: busyCommand.requestId,
    status: 409,
    body: { version: 1, requestId: busyCommand.requestId, error: "conversation_busy" },
  });
  expect(await invoke(who, "status", { id: f.sandbox.id })).toMatchObject({ settled: true });
  const following = { requestId: randomUUID(), text: "continue", conversationId },
    nextPrompt = randomUUID();
  await service.prompt(f.actor, f.sandbox.id, following);
  await complete(session, { promptId: nextPrompt, conversationId, status: "queued" });
  await service.prompt(f.actor, f.sandbox.id, following);
  expect(await invoke(who, "status", { id: f.sandbox.id })).toMatchObject({
    settled: false,
    prompt: { promptId: nextPrompt, state: "running" },
  });
  await publish(
    f,
    session,
    [
      {
        id: "next-done",
        at: 4,
        kind: "prompt",
        promptId: nextPrompt,
        conversationId,
        text: "continue",
        status: "finished",
      },
    ],
    4,
  );
  expect(await invoke(who, "status", { id: f.sandbox.id })).toMatchObject({
    settled: true,
    prompt: { promptId: nextPrompt, state: "finished" },
  });

  const metadataOnly = randomUUID();
  await db.query(`insert into auth.users(id) values($1)`, [metadataOnly]);
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [
    f.actor.orgId,
    metadataOnly,
  ]);
  await rejected(
    invoke(caller({ ...f.actor, userId: metadataOnly }, "admin"), "status", { id: f.sandbox.id }),
    "not_found",
  );
  const foreign = await fixture();
  await rejected(invoke(caller(foreign.admin, "admin"), "logs", { id: f.sandbox.id }), "not_found");
  await rejected(invoke({ ...who, orgs: [] }, "status", { id: f.sandbox.id }), "not_found");
  const stopId = randomUUID(),
    deleteId = randomUUID();
  await reservations.stop(f.actor, f.sandbox.id, stopId);
  await hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  await reservations.delete(f.actor, f.sandbox.id, deleteId);
  await hosts.complete(f.hostToken, f.installationId, { requestId: deleteId, outcome: "completed" });
  await hosts.revoke(f.admin, f.hostId);
  expect(await invoke(who, "status", { id: f.sandbox.id })).toMatchObject({ status: "deleted", settled: true });
  expect(await invoke(admin, "logs", { id: f.sandbox.id })).toMatchObject({
    source: "armada-runtime",
    events: [{ id: "p-start" }, { id: "p-done" }, { id: "tokens" }, { id: "next-done" }],
  });
  expect(await invoke(admin, "delete", { id: f.sandbox.id })).toEqual({ id: f.sandbox.id, status: "deleted" });
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await rejected(invoke(who, "status", { id: f.sandbox.id }), "not_found");
});

test("normal logs preserve raw cursors through private diagnostics and conversation filters, backward paging and all", async () => {
  const f = await fixture(),
    session = await ready(f),
    who = caller(f.actor),
    conversationId = randomUUID();
  await publish(f, session, [
    { id: "private", at: 1, kind: "other", type: "account/updated", data: { secret: "not public" }, conversationId },
    { id: "unrelated", at: 2, kind: "other", type: "notice", data: null, conversationId: randomUUID() },
    { id: "visible", at: 3, kind: "message", text: "hello", partial: false, tools: [], conversationId },
    { id: "visible2", at: 4, kind: "message", text: "world", partial: false, tools: [], conversationId },
  ]);
  const prefix = `ar1_${f.sandbox.id}_`;
  expect(await invoke(who, "logs", { id: f.sandbox.id, limit: 1, conversation_id: conversationId })).toMatchObject({
    events: [],
    cursor: `${prefix}1`,
    hasMore: true,
    source: "armada-runtime",
  });
  expect(
    await invoke(who, "logs", {
      id: f.sandbox.id,
      limit: 1,
      since_cursor: `${prefix}1`,
      conversation_id: conversationId,
    }),
  ).toMatchObject({
    events: [],
    cursor: `${prefix}2`,
    hasMore: true,
  });
  expect(
    await invoke(who, "logs", { id: f.sandbox.id, limit: 1, all: true, conversation_id: conversationId }),
  ).toMatchObject({
    events: [{ id: "visible" }, { id: "visible2" }],
    cursor: `${prefix}4`,
    hasMore: false,
  });
  expect(await invoke(who, "logs", { id: f.sandbox.id, limit: 1, direction: "backward" })).toMatchObject({
    events: [{ id: "visible2" }],
    cursor: `${prefix}4`,
    olderCursor: `${prefix}4`,
    hasMore: true,
  });
  expect(
    await invoke(who, "logs", { id: f.sandbox.id, limit: 1, direction: "backward", since_cursor: `${prefix}4` }),
  ).toMatchObject({
    events: [{ id: "visible" }],
    olderCursor: `${prefix}3`,
  });
  await publish(
    f,
    session,
    Array.from(
      { length: 105 },
      (_, index): AgentEvent => ({
        id: `tail-${index}`,
        at: index + 5,
        kind: "other",
        type: "notice",
        data: null,
      }),
    ),
    5,
  );
  expect(await invoke(who, "logs", { id: f.sandbox.id, limit: 1, all: true })).toMatchObject({
    cursor: `${prefix}100`,
    hasMore: true,
  });
  for (const args of [{ all: true, direction: "backward" }, { since_cursor: `ar1_${randomUUID()}_1` }, { maxBytes: 1 }])
    await rejected(invoke(who, "logs", { id: f.sandbox.id, ...args }), "invalid_request");
});

test("cleanup waits outside transactions for physical ACK; timeout retries reuse one bound intent", async () => {
  const f = await fixture(),
    who = caller(f.actor),
    admin = caller(f.admin, "admin");
  await ready(f);
  let now = 0,
    waits = 0;
  const pending = createDockerSandboxControls(sql, key, {
    timeoutMs: 500,
    clock: {
      now: () => now,
      wait: async (ms) => {
        // This transaction would nest/deadlock if the controller waited while holding one.
        await sql.transaction?.(async (tx) => {
          await tx.query(`select id from public.sandboxes where id=$1 for update`, [f.sandbox.id]);
        });
        waits++;
        now += ms;
      },
    },
  });
  await rejected(invoke(who, "stop", { id: f.sandbox.id }, pending), "conflict");
  expect(waits).toBe(2);
  const jobs = async () =>
    (
      await db.query<{ request_id: string }>(
        `select request_id from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='stop'`,
        [f.sandbox.id],
      )
    ).rows;
  const original = (await jobs())[0];
  if (!original) throw Error("missing stop intent");
  await rejected(invoke(who, "stop", { id: f.sandbox.id }, pending), "conflict");
  expect(await jobs()).toEqual([original]);
  await rejected(invoke(who, "stop", { id: f.sandbox.id, request_id: randomUUID() }, pending), "conflict");
  await rejected(invoke(admin, "stop", { id: f.sandbox.id }, pending), "conflict");
  expect(await jobs()).toEqual([original]);
  const acking = createDockerSandboxControls(sql, key, {
    clock: {
      now: () => now,
      wait: async (ms) => {
        now += ms;
        const job = await hosts.poll(f.hostToken, f.installationId);
        if (!job) throw Error("missing cleanup job");
        await hosts.complete(f.hostToken, f.installationId, { requestId: job.requestId, outcome: "completed" });
      },
    },
  });
  expect(await invoke(who, "stop", { id: f.sandbox.id }, acking)).toEqual({ id: f.sandbox.id, status: "stopped" });
  expect(await invoke(admin, "delete", { id: f.sandbox.id }, acking)).toEqual({ id: f.sandbox.id, status: "deleted" });
  expect(await invoke(who, "delete", { id: f.sandbox.id })).toEqual({ id: f.sandbox.id, status: "deleted" });
});

test("failed/expired cleanup preserves failure facts and unfinished prompt outcome, with safe normal retry after a known failed host job", async () => {
  const f = await fixture(),
    session = await ready(f),
    who = caller(f.actor),
    promptId = randomUUID();
  await publish(f, session, [{ id: "running", at: 1, kind: "prompt", text: "running", status: "running", promptId }]);
  await db.query(
    `update public.sandboxes set status='failed',status_reason='expired',expires_at=now()-interval '1 second' where id=$1`,
    [f.sandbox.id],
  );
  expect(await invoke(who, "status", { id: f.sandbox.id })).toMatchObject({
    status: "failed",
    providerState: null,
    statusReason: "expired",
    settled: true,
    prompt: { state: "failed", reason: "The agent failed." },
  });
  let now = 0,
    outcome: "completed" | "failed" = "failed";
  const controller = createDockerSandboxControls(sql, key, {
    clock: {
      now: () => now,
      wait: async (ms) => {
        now += ms;
        const job = await hosts.poll(f.hostToken, f.installationId);
        if (!job) throw Error("missing cleanup");
        await hosts.complete(f.hostToken, f.installationId, { requestId: job.requestId, outcome });
      },
    },
  });
  const failedRequest = randomUUID();
  await rejected(invoke(who, "stop", { id: f.sandbox.id, request_id: failedRequest }, controller), "conflict");
  outcome = "completed";
  await rejected(invoke(who, "stop", { id: f.sandbox.id, request_id: failedRequest }, controller), "conflict");
  expect(await invoke(who, "stop", { id: f.sandbox.id }, controller)).toEqual({
    id: f.sandbox.id,
    status: "failed",
  });
  const row = (
    await db.query<{ status_reason: string; stopped_at: unknown }>(
      `select status_reason,stopped_at from public.sandboxes where id=$1`,
      [f.sandbox.id],
    )
  ).rows[0];
  expect(row).toMatchObject({ status_reason: "expired" });
  expect(row?.stopped_at).not.toBeNull();
  await hosts.revoke(f.admin, f.hostId);
  expect(await invoke(who, "stop", { id: f.sandbox.id })).toEqual({ id: f.sandbox.id, status: "failed" });
  await rejected(invoke(who, "delete", { id: f.sandbox.id }, controller), "conflict");
});

// Actual producer -> MCP output validator -> dashboard parser/CLI formatter. No duplicated DTO fixture.
test("normal API and MCP accept Docker list/status/logs rows and acknowledge cleanup without a golden or provider fallback", async () => {
  const f = await fixture(),
    session = await ready(f),
    who = caller(f.actor);
  const promptId = randomUUID(),
    conversationId = randomUUID();
  const input = { requestId: randomUUID(), text: "Say Hello" };
  await service.prompt(f.actor, f.sandbox.id, input);
  await complete(session, { promptId, conversationId, status: "queued" });
  await service.prompt(f.actor, f.sandbox.id, input);
  await publish(f, session, [
    { id: randomUUID(), at: 1, kind: "prompt", promptId, conversationId, text: "Say Hello", status: "running" },
    {
      id: randomUUID(),
      at: 2,
      kind: "message",
      promptId,
      conversationId,
      text: "Hello Docker",
      partial: false,
      tools: [],
    },
    { id: randomUUID(), at: 3, kind: "prompt", promptId, conversationId, text: "Say Hello", status: "finished" },
    {
      id: randomUUID(),
      at: 4,
      kind: "other",
      type: "auth_status",
      data: { canary: "private-diagnostic-not-for-clients" },
    },
  ]);
  let now = 0;
  const cleanup = createDockerSandboxControls(sql, key, {
    clock: {
      now: () => now,
      async wait(ms) {
        const job = await hosts.poll(f.hostToken, f.installationId);
        if (!job || !["stop", "delete"].includes(job.operation)) throw Error("Expected bound cleanup job");
        await hosts.complete(f.hostToken, f.installationId, { requestId: job.requestId, outcome: "completed" });
        now += ms;
      },
    },
  });
  const store = createSqlVaultStore(sql);
  const context: ToolContext = {
    caller: who,
    data: createSqlData(sql)(who),
    dockerControls: cleanup,
    launchCredentials: launchCredentials(store, key),
    exposedSecrets: async () => {
      throw Error("Read/cleanup must not resolve model secrets");
    },
    provider: async () => {
      throw Error("Docker must not fall back to Boat or Modal");
    },
    now: () => new Date(),
    sleep: async () => {
      throw Error("Unexpected legacy wait");
    },
  };
  const listed = (await callSharedTool(context, "list", {})) as { sandboxes: SandboxListMetadata[] };
  expect(listed.sandboxes).toHaveLength(1);
  expect(isSandboxPlacementProvider(listed.sandboxes[0]?.provider)).toBe(true);
  expect(listed.sandboxes[0]).toMatchObject({ id: f.sandbox.id, provider: "docker", boatId: null });
  const parsed = parseSandboxListMetadata(listed.sandboxes);
  expect(parsed.skipped).toEqual([]);
  expect(parsed.rows[0]?.provider).toBe("docker");
  expect(sandboxListText(listed.sandboxes, new Date())).toContain("Docker");
  const options: ControlOptions = {
    store,
    providers: {
      resolve: async () => {
        throw Error("Docker must not resolve legacy provider credentials");
      },
    },
    encryptionKey: key,
    authStore: createSqlAuthStore(sql),
    data: createSqlData(sql),
    dockerControls: cleanup,
    docker: { hosts: true, placement: false, normalApi: true, normalLaunch: false },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "fixture-anon",
      fetch: async () => Response.json({ id: f.actor.userId }),
    },
  };
  const bearer = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: f.actor.userId })).toString("base64url")}.sig`;
  const post = async (path: string, body: Record<string, unknown>) => {
    const reply = await handleControlRequest(
      new Request(`https://armada.example/api/v1/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ org: f.actor.orgId, ...body }),
      }),
      options,
    );
    if (!reply) throw Error("Missing normal API route");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    return reply.json();
  };
  const apiList = (await post("sandbox/list", {})) as { sandboxes: SandboxListMetadata[] };
  expect(parseSandboxListMetadata(apiList.sandboxes).skipped).toEqual([]);
  expect(apiList.sandboxes[0]?.provider).toBe("docker");
  const status = (await post("sandbox/detail", { id: f.sandbox.id })) as DockerSandboxStatus;
  expect(status).toMatchObject({
    provider: "docker",
    golden: null,
    settled: true,
    prompt: { promptId, state: "finished" },
  });
  expect(await callSharedTool(context, "status", { id: f.sandbox.id })).toEqual(status);
  const logs = (await post("logs/read", { id: f.sandbox.id, follow: true })) as {
    events: AgentEvent[];
    cursor: string;
  };
  expect(logs.events).toHaveLength(3);
  expect(JSON.stringify(logs)).not.toContain("private-diagnostic-not-for-clients");
  const mcpLogs = (await callSharedTool(context, "logs", { id: f.sandbox.id })) as { events: AgentEvent[] };
  expect(mcpLogs.events).toEqual(logs.events);
  const discovery = (await post("launch/options", {})) as {
    providers: { id: string; capabilities: Record<string, boolean> }[];
  };
  expect(discovery.providers.find((p) => p.id === "docker")?.capabilities).toMatchObject({
    status: true,
    logs: true,
    stop: true,
    delete: true,
    launch: false,
    followupPrompts: false,
    resume: false,
  });
  expect(await post("sandbox/stop", { id: f.sandbox.id })).toEqual({ id: f.sandbox.id, status: "stopped" });
  expect(await callSharedTool(context, "delete", { id: f.sandbox.id })).toEqual({
    id: f.sandbox.id,
    status: "deleted",
  });
  const repeated = await handleControlRequest(
    new Request(`https://armada.example/api/v1/sandboxes/${f.sandbox.id}?org=${f.actor.orgId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    }),
    options,
  );
  expect(repeated?.status).toBe(200);
  expect(await repeated?.json()).toEqual({ id: f.sandbox.id, status: "deleted" });
  expect(((await callSharedTool(context, "logs", { id: f.sandbox.id })) as { events: unknown[] }).events).toHaveLength(
    3,
  );
});

// Merge integration: normal Docker cleanup obeys the shared delegated-child fence too.
test("Docker child deletion requires permanent delegated parent deletion before mailbox admission", async () => {
  const f = await fixture(),
    who = caller(f.actor);
  const parent = await reservations.reserve(f.actor, {
    requestId: randomUUID(),
    hostId: f.hostId,
    image: f.sandbox.image,
    credentialId: f.credentialId,
    credentialVersion: 1,
  });
  await hosts.complete(f.hostToken, f.installationId, { requestId: parent.id, outcome: "completed" });
  for (const id of [parent.id, f.sandbox.id]) {
    const requestId = randomUUID();
    await reservations.stop(f.actor, id, requestId);
    await hosts.complete(f.hostToken, f.installationId, { requestId, outcome: "completed" });
  }
  await db.query(
    `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
    values($1,'sandbox',$2,$3,$1,'stopped')`,
    [parent.id, f.actor.orgId, f.actor.userId],
  );
  await db.query(
    `insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id)
    values($1,$2,$3,$4)`,
    [f.sandbox.id, parent.id, f.actor.orgId, f.actor.userId],
  );
  let now = 0;
  const controller = createDockerSandboxControls(sql, key, {
    clock: {
      now: () => now,
      async wait(ms) {
        const job = await hosts.poll(f.hostToken, f.installationId);
        if (!job || job.operation !== "delete") throw Error("Expected authorized delete job");
        await hosts.complete(f.hostToken, f.installationId, { requestId: job.requestId, outcome: "completed" });
        now += ms;
      },
    },
  });
  await rejected(invoke(who, "delete", { id: f.sandbox.id }, controller), "conflict");
  expect(
    (
      await db.query(
        `select request_id from docker_host_jobs where bound_sandbox_id=$1
    and bound_operation='delete'`,
        [f.sandbox.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(await invoke(who, "delete", { id: parent.id }, controller)).toEqual({ id: parent.id, status: "deleted" });
  expect(await invoke(who, "delete", { id: f.sandbox.id }, controller)).toEqual({
    id: f.sandbox.id,
    status: "deleted",
  });
  expect(
    (await db.query(`select sandbox_id from orchestrator_children where sandbox_id=$1`, [f.sandbox.id])).rows,
  ).toEqual([{ sandbox_id: f.sandbox.id }]);
});

// Admission is exercised through the real SQL/runtime boundary, not a receipt mock.
test("normal Docker send continues the saved native conversation and retries exactly once", async () => {
  const f = await fixture(),
    session = await ready(f);
  const conversationId = randomUUID(),
    firstPrompt = randomUUID();
  const first = { requestId: randomUUID(), text: "first" };
  await service.prompt(f.actor, f.sandbox.id, first);
  await complete(session, { promptId: firstPrompt, conversationId, status: "finished" });
  await service.prompt(f.actor, f.sandbox.id, first);
  const promptId = randomUUID();
  let deliveries = 0;
  const send = createDockerNormalSend(sql, key, {
    enabled: true,
    clock: {
      now: () => 0,
      async wait() {
        const command = await complete(session, { promptId, conversationId, status: "queued" });
        expect(command).toMatchObject({ op: "prompt", input: { text: "continue", conversationId } });
        deliveries++;
      },
    },
  });
  const controller = createDockerSandboxControls(sql, key, { send });
  const args = { id: f.sandbox.id, request_id: randomUUID(), prompt: "continue" };
  const result = await invoke(caller(f.actor), "send", args, controller);
  expect(result).toMatchObject({ id: f.sandbox.id, promptId, conversationId, status: "queued" });
  expect(await invoke(caller(f.actor), "send", args, controller)).toEqual(result);
  expect(deliveries).toBe(1);
  await rejected(invoke(caller(f.actor), "send", { ...args, prompt: "changed" }, controller), "conflict");
  await rejected(invoke(caller(f.actor), "send", { ...args, model: "different" }, controller), "invalid_request");
  await rejected(invoke(caller(f.admin, "admin"), "send", args, controller), "conflict");
});
