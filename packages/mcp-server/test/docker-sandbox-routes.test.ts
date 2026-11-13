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
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const key = Buffer.alloc(32, 17).toString("base64");
const sql: Sql = {
  query: (q, p) => db.query(q, p),
  transaction: (work) => db.transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
};
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
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
  const f = await fixture();
  expect((await f.post("launch", f.launch, false)).status).toBe(403);
  expect((await f.post("launch", f.launch, true, f.hostToken)).status).toBe(401);
  expect((await f.post("launch", f.launch, true, "fixture-user", { origin: "https://foreign.example" })).status).toBe(
    400,
  );
  expect((await f.post("launch", { ...f.launch, configuration: { secret: "never-accepted" } })).status).toBe(400);
  expect((await f.post("launch", { ...f.launch, image: "x".repeat(32769) })).status).toBe(413);
  expect((await f.route(true)(new Request("https://staging.example/api/v1/docker/sandboxes/launch")))?.status).toBe(
    405,
  );
  expect(await f.route(true)(new Request("https://staging.example/unrelated"))).toBeNull();
  expect((await db.query(`select 1 from sandboxes where id=$1`, [f.launch.requestId])).rows).toHaveLength(0);
});

test("public Docker preview dispatches one prompt through runtime commands and retains acknowledged answer/usage after cleanup", async () => {
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
  if (!health || health.op !== "health") throw Error("missing health");
  await commands.complete(active.runtimeToken, active.epoch, {
    epoch: active.epoch,
    requestId: health.requestId,
    status: 200,
    body: { version: 1, requestId: health.requestId, result: { ready: true, generation: active.epoch } },
  });
  expect((await f.post("ready", { sandboxId, requestId: healthId })).status).toBe(200);
  const prompt = { sandboxId, requestId: randomUUID(), text: "Reply only DOCKER_OK" };
  expect((await f.post("prompt", prompt)).status).toBe(202);
  const request = (await commands.next(active.runtimeToken, active.epoch)).command;
  if (!request || request.op !== "prompt") throw Error("missing prompt");
  expect(request.input).toMatchObject({ harness: "codex", cwd: "/home/user", text: prompt.text });
  const promptId = randomUUID(),
    conversationId = randomUUID();
  await commands.complete(active.runtimeToken, active.epoch, {
    epoch: active.epoch,
    requestId: request.requestId,
    status: 200,
    body: { version: 1, requestId: request.requestId, result: { promptId, conversationId, status: "queued" } },
  });
  expect((await f.post("prompt", prompt)).status).toBe(200);
  const events = [
    { id: "answer", at: 1, kind: "message", promptId, conversationId, text: "DOCKER_OK", partial: false, tools: [] },
    {
      id: "usage",
      at: 2,
      kind: "other",
      promptId,
      type: "armada/turnUsage",
      data: { model: "gpt-6.1-sol", inputTokens: 10, outputTokens: 3 },
    },
    { id: "done", at: 3, kind: "prompt", promptId, conversationId, text: prompt.text, status: "finished" },
  ];
  const ack = await createRuntimeEvents(authority, key).route(
    new Request("https://staging.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
      body: JSON.stringify({
        sandboxId,
        generation: active.epoch,
        events: events.map((event, i) => ({ sequence: i + 1, event })),
      }),
    }),
  );
  expect(ack?.status).toBe(200);
  expect(await ack!.json()).toEqual({ acknowledgedSequence: 3 });
  const stopId = randomUUID();
  expect((await f.post("stop", { sandboxId, requestId: stopId }, false)).status).toBe(202);
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  const deleteId = randomUUID();
  expect((await f.post("delete", { sandboxId, requestId: deleteId }, false)).status).toBe(202);
  await f.hosts.complete(f.hostToken, f.installationId, { requestId: deleteId, outcome: "completed" });
  const state = await f.post("get", { sandboxId }, false);
  expect(((await state.json()) as { status: string }).status).toBe("deleted");
  const journal = await f.post("journal", { sandboxId }, false);
  expect(journal.status).toBe(200);
  const archive = (await journal.json()) as { events: { event: unknown }[]; usage: unknown };
  expect(archive.events.map((entry) => entry.event)).toEqual(events);
  expect(archive.usage).toMatchObject({
    turnCount: 1,
    turns: [expect.objectContaining({ inputTokens: 10, outputTokens: 3 })],
  });
  expect(JSON.stringify(archive)).not.toMatch(/armada_enrol_|armada_runtime_/);
});
