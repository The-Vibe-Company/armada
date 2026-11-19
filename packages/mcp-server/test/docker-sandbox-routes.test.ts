import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerRuntimeLifecycle } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxRoutes } from "../src/docker-sandbox-routes.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { migratedDatabase } from "./migrated-database.ts";

let connection: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
function database() {
  if (!connection) throw new Error("Database fixture is not open");
  return connection;
}
const key = Buffer.alloc(32, 17).toString("base64");
const sql: Sql = {
  query: (q, p) => database().query(q, p),
  transaction: (work) => database().transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
};
beforeAll(async () => {
  connection = await migratedDatabase();
});
afterAll(async () => {
  const db = connection;
  connection = undefined;
  await db?.close();
});
const manifest = {
  protocol: 1,
  platform: "linux",
  architecture: "x64",
  libc: "glibc",
  runtime: { sha256: "b".repeat(64), bytes: 42 },
  harnesses: { codex: { files: [{ path: "bin/codex" }] } },
};
async function fixture() {
  const db = database();
  const userId = randomUUID(),
    orgId = randomUUID(),
    installationId = randomUUID();
  await db.query(`insert into auth.users(id) values($1)`, [userId]);
  await db.query(`insert into orgs(id,name) values($1,$2)`, [orgId, `Docker HTTP ${orgId}`]);
  await db.query(`insert into members(org_id,user_id,role) values($1,$2,'admin')`, [orgId, userId]);
  const actor = { userId, orgId };
  const hosts = createDockerHostStore(sql, key);
  const ticket = await hosts.issueRegistration(actor);
  const host = await hosts.exchangeRegistration(ticket.registrationToken, installationId);
  const credentialId = randomUUID();
  await db.query(`insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)`, [
    credentialId,
    userId,
    await encryptSecret(`offline-http-${randomUUID()}`, key),
  ]);
  const authenticate = async (request: Request) =>
    request.headers.get("authorization") === "Bearer fixture-user"
      ? { ok: true as const, caller: { userId, orgs: [{ orgId, role: "admin" as const }], via: "service" as const } }
      : { ok: false as const };
  const route = (enabled: boolean) =>
    createDockerSandboxRoutes(
      {
        sandboxes: createDockerSandboxService(sql, key, { enabled }),
        ...(enabled
          ? {
              bootstrap: createDockerBootstrapService(sql, key, {
                enabled,
                serverUrl: "https://staging.example",
                manifest,
                architecture: "x64",
                credentials: launchCredentials(createSqlVaultStore(sql), key),
              }),
            }
          : {}),
        runtime: createDockerRuntimeLifecycle(sql, key, { enabled }),
      },
      authenticate,
    );
  const post = async (
    operation: string,
    body: Record<string, unknown>,
    enabled = true,
    token = "fixture-user",
    extra = {},
  ) => {
    const response = await route(enabled)(
      new Request(`https://staging.example/api/v1/docker/sandboxes/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...extra },
        body: JSON.stringify({ org: orgId, ...body }),
      }),
    );
    if (!response) throw Error("route missing");
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response;
  };
  const launch = {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
  };
  return { actor, installationId, hosts, ...host, post, route, launch };
}

// HTTP owns dispatch/shape/bearer boundaries; lifecycle authorization is exercised by its service tests.
test("Docker HTTP requires explicit placement, user bearer and bounded exact shapes", async () => {
  const db = database();
  const f = await fixture();
  expect((await f.post("launch", f.launch, false)).status).toBe(403);
  expect((await f.post("launch", f.launch, true, f.hostToken)).status).toBe(401);
  expect((await f.post("launch", f.launch, true, "fixture-user", { origin: "https://foreign.example" })).status).toBe(
    400,
  );
  expect((await f.post("launch", { ...f.launch, configuration: { secret: "never-accepted" } })).status).toBe(400);
  expect((await f.post("launch", { ...f.launch, image: "x".repeat(32769) })).status).toBe(413);
  const prompt = { sandboxId: randomUUID(), requestId: randomUUID(), text: "Continue" };
  expect(
    await f.route(true)(
      new Request("https://staging.example/api/v1/docker/sandboxes/prompt", {
        method: "POST",
        headers: { authorization: "Bearer fixture-user" },
        body: JSON.stringify({ org: f.actor.orgId, ...prompt }),
      }),
    ),
  ).toBeNull();
  for (const operation of ["ready", "stop", "delete", "job", "bootstrap", "get", "journal"])
    expect(
      (
        await f.post(operation, {
          sandboxId: prompt.sandboxId,
          ...(["get", "journal"].includes(operation) ? {} : { requestId: prompt.requestId }),
          conversationId: randomUUID(),
        })
      ).status,
    ).toBe(400);
  expect((await f.route(true)(new Request("https://staging.example/api/v1/docker/sandboxes/launch")))?.status).toBe(
    405,
  );
  expect(await f.route(true)(new Request("https://staging.example/unrelated"))).toBeNull();
  expect((await db.query(`select 1 from sandboxes where id=$1`, [f.launch.requestId])).rows).toHaveLength(0);
});

test("Docker preview journal retains acknowledged runtime answer and usage after cleanup", async () => {
  const f = await fixture();
  const launched = await f.post("launch", f.launch);
  expect(launched.status).toBe(201);
  const sandbox = (await launched.json()) as { id: string; provider: string };
  expect(sandbox.provider).toBe("docker");
  const sandboxId = sandbox.id;
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: sandboxId, outcome: "completed" });
  const bootstrapId = randomUUID();
  expect((await f.post("bootstrap", { sandboxId, requestId: bootstrapId })).status).toBe(202);
  const job = await f.hosts.poll(f.hostToken, f.installationId);
  if (job?.operation !== "bootstrap") throw Error("missing bootstrap");
  const authority = createRuntimeEnrolments(sql, key),
    commands = createRuntimeCommands(authority, key);
  const active = await authority.enrol(job.bootstrap.enrolmentToken);
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: bootstrapId, outcome: "completed" });
  const healthId = randomUUID();
  expect((await f.post("ready", { sandboxId, requestId: healthId })).status).toBe(202);
  const health = (await commands.next(active.runtimeToken, active.epoch)).command;
  if (health?.op !== "health") throw Error("missing health");
  await commands.complete(active.runtimeToken, active.epoch, {
    epoch: active.epoch,
    requestId: health.requestId,
    status: 200,
    body: { version: 1, requestId: health.requestId, result: { ready: true, generation: active.epoch } },
  });
  expect((await f.post("ready", { sandboxId, requestId: healthId })).status).toBe(200);
  const conversationId = randomUUID();
  const runtime = createDockerRuntimeLifecycle(sql, key, { enabled: true });
  const events: Record<string, unknown>[] = [];
  for (let turn = 0; turn < 2; turn++) {
    const prompt = {
      requestId: randomUUID(),
      text: turn ? "Now reply only FOLLOWUP_OK" : "Reply only DOCKER_OK",
      ...(turn ? { conversationId } : {}),
    };
    expect((await runtime.prompt(f.actor, sandboxId, prompt)).state).toBe("pending");
    const request = (await commands.next(active.runtimeToken, active.epoch)).command;
    if (request?.op !== "prompt") throw Error("missing prompt");
    expect(request.input).toMatchObject({ harness: "codex", cwd: "/home/user", text: prompt.text });
    expect(request.input.conversationId).toBe(turn ? conversationId : undefined);
    const promptId = randomUUID();
    await commands.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: request.requestId,
      status: 200,
      body: { version: 1, requestId: request.requestId, result: { promptId, conversationId, status: "queued" } },
    });
    expect(await runtime.prompt(f.actor, sandboxId, prompt)).toEqual({
      state: "admitted",
      epoch: active.epoch,
      receipt: { promptId, conversationId, status: "queued" },
    });
    const nextEvents = [
      {
        id: `answer-${turn}`,
        at: turn * 3 + 1,
        kind: "message",
        promptId,
        conversationId,
        text: turn ? "FOLLOWUP_OK" : "DOCKER_OK",
        partial: false,
        tools: [],
      },
      {
        id: `usage-${turn}`,
        at: turn * 3 + 2,
        kind: "other",
        promptId,
        type: "armada/turnUsage",
        data: { model: "gpt-6.1-sol", inputTokens: 10, outputTokens: 3 },
      },
      {
        id: `done-${turn}`,
        at: turn * 3 + 3,
        kind: "prompt",
        promptId,
        conversationId,
        text: prompt.text,
        status: "finished",
      },
    ];
    const ack = await createRuntimeEvents(authority, key).route(
      new Request("https://staging.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
        body: JSON.stringify({
          sandboxId,
          generation: active.epoch,
          events: nextEvents.map((event, i) => ({ sequence: events.length + i + 1, event })),
        }),
      }),
    );
    events.push(...nextEvents);
    expect(ack?.status).toBe(200);
    expect(await ack?.json()).toEqual({ acknowledgedSequence: events.length });
  }
  // Queuing host work is a provider call; database-only reads leave just the HTTP record.
  const records: Record<string, unknown>[] = [];
  const observed = (work: () => Promise<Response>) =>
    observeRequest(work, (line) => records.push(JSON.parse(line))) as Promise<Response>;
  const stopId = randomUUID();
  const stopped = await observed(() => f.post("stop", { sandboxId, requestId: stopId }, false));
  expect(stopped.status).toBe(202);
  expect(records.filter((record) => record.event === "provider_call")).toEqual([
    expect.objectContaining({
      requestId: stopped.headers.get("x-request-id"),
      provider: "docker",
      operation: "stop",
      outcome: "ok",
    }),
  ]);
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  const deleteId = randomUUID();
  expect((await f.post("delete", { sandboxId, requestId: deleteId }, false)).status).toBe(202);
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: deleteId, outcome: "completed" });
  records.length = 0;
  const state = await observed(() => f.post("get", { sandboxId }, false));
  expect(((await state.json()) as { status: string }).status).toBe("deleted");
  expect((await observed(() => f.post("job", { sandboxId, requestId: deleteId }, false))).status).toBe(200);
  const journal = await observed(() => f.post("journal", { sandboxId }, false));
  expect(journal.status).toBe(200);
  expect(records.map((record) => record.event)).toEqual(["http_request", "http_request", "http_request"]);
  const archive = (await journal.json()) as { events: { event: unknown }[]; usage: unknown };
  expect(archive.events.map((entry) => entry.event)).toEqual(events);
  expect(archive.usage).toMatchObject({
    turnCount: 2,
    turns: [
      expect.objectContaining({ inputTokens: 10, outputTokens: 3 }),
      expect.objectContaining({ inputTokens: 10, outputTokens: 3 }),
    ],
  });
  expect(JSON.stringify(archive)).not.toMatch(/armada_enrol_|armada_runtime_/);
});

test("a draining host refusal is an actionable HTTP conflict naming the uninstall, not a permission failure", async () => {
  const db = database();
  const f = await fixture();
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  const response = await f.post("launch", f.launch);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "host_draining",
    message: expect.stringContaining("draining for uninstall"),
  });
});

test("full host refusal is an actionable HTTP conflict rather than a generic server failure", async () => {
  const f = await fixture();
  await f.hosts.poll(f.hostToken, f.installationId, "2.31.0", false, { cpus: 2, memoryBytes: 6 * 1024 ** 3 });
  expect((await f.post("launch", f.launch)).status).toBe(201);
  const response = await f.post("launch", { ...f.launch, requestId: randomUUID() });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "host_full",
    message: expect.stringContaining("1/1 sandboxes running; stop one or raise the limit"),
  });
});

test("a retried preview launch or cleanup records host work only for the request that queued it", async () => {
  const db = database();
  const f = await fixture();
  const observed = async (work: () => Promise<Response>) => {
    const records: Record<string, unknown>[] = [];
    const response = (await observeRequest(work, (line) => records.push(JSON.parse(line)))) as Response;
    return { response, calls: records.filter((record) => record.event === "provider_call") };
  };
  const jobs = async () =>
    Number(
      (
        await db.query<{ count: string }>("select count(*)::text as count from docker_host_jobs where host_id=$1", [
          f.hostId,
        ])
      ).rows[0]?.count,
    );
  const first = await observed(() => f.post("launch", f.launch));
  expect(first.response.status).toBe(201);
  expect(first.calls).toEqual([
    expect.objectContaining({
      requestId: first.response.headers.get("x-request-id"),
      provider: "docker",
      operation: "reserve",
      outcome: "ok",
    }),
  ]);
  expect(await jobs()).toBe(1);
  const replay = await observed(() => f.post("launch", f.launch));
  expect(replay.response.status).toBe(201);
  expect(replay.calls).toEqual([]);
  expect(await jobs()).toBe(1);
  const stop = { sandboxId: f.launch.requestId, requestId: randomUUID() };
  const stopped = await observed(() => f.post("stop", stop));
  expect(stopped.response.status).toBe(202);
  expect(stopped.calls).toEqual([expect.objectContaining({ operation: "stop", outcome: "ok" })]);
  expect(await jobs()).toBe(2);
  const restopped = await observed(() => f.post("stop", stop));
  expect(restopped.response.status).toBe(202);
  expect(restopped.calls).toEqual([]);
  expect(await jobs()).toBe(2);
});
