import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DOCKER_HOST_PROTOCOL,
  DOCKER_HOST_PROTOCOL_HEADER,
  type DockerHostListResponse,
  type Sql,
  VERSION,
} from "@armada/core";
import { DockerHostDraining } from "../src/docker-capacity.ts";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { observeRequest } from "../src/request-observability.ts";
import { collectTransactionWakes } from "../src/wake-bus.ts";
import { rowOnlyConnection } from "./row-only-database.ts";

const connection = rowOnlyConnection();

async function fixture() {
  const db = await connection();
  const userId = randomUUID(),
    memberId = randomUUID(),
    spareAdminId = randomUUID(),
    orgId = randomUUID();
  await db.query("insert into auth.users(id) values($1),($2),($3)", [userId, memberId, spareAdminId]);
  await db.query("insert into orgs(id,name) values($1,'HTTP host fixture')", [orgId]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member'),($1,$4,'admin')", [
    orgId,
    userId,
    memberId,
    spareAdminId,
  ]);
  const sql: Sql = {
    query: (q, p) => db.query(q, p),
    async transaction(work) {
      let publish: (() => void) | undefined;
      const result = await db.transaction((tx) => {
        const scoped: Sql = { query: (q, p) => tx.query(q, p) };
        publish = collectTransactionWakes(scoped);
        return work(scoped);
      });
      publish?.();
      return result;
    },
  };
  const store = createDockerHostStore(sql, Buffer.alloc(32, 8).toString("base64"));
  const authenticate = async (request: Request) => {
    const token = request.headers.get("authorization");
    if (token === "Bearer fixture-user-token")
      return {
        ok: true as const,
        caller: { userId, orgs: [{ orgId, role: "admin" as const }], via: "supabase" as const },
      };
    if (token === "Bearer fixture-member-token")
      return {
        ok: true as const,
        caller: { userId: memberId, orgs: [{ orgId, role: "member" as const }], via: "supabase" as const },
      };
    return { ok: false as const };
  };
  const route = createDockerHostRoutes(store, authenticate, { publicUrl: "https://public.example" });
  async function post(path: string, token: string, body: unknown, extra: Record<string, string> = {}, target = route) {
    const response = await target(
      new Request(`https://staging.example${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response) throw new Error("Expected Docker host route");
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response;
  }
  return { db, sql, userId, memberId, orgId, store, authenticate, route, post };
}

function inventoryRouteFixture(requestOrigin?: string) {
  const hostId = "10000000-0000-0000-0000-000000000001";
  const installationId = "10000000-0000-0000-0000-000000000002";
  const publicUrl = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example`;
  const store = createDockerHostStore(
    {
      async query() {
        throw new Error("Unexpected SQL");
      },
    },
    Buffer.alloc(32, 8).toString("base64"),
  );
  const records: unknown[] = [];
  const route = createDockerHostRoutes(
    {
      ...store,
      inventoryOwnership: async () => ({ hostId, rows: [] }),
      retentionForHost: async () => ({ hostId, retentionSeconds: undefined }),
      poll: async () => null,
      pendingStartsForHost: async () => [],
    },
    async () => ({ ok: false }),
    { publicUrl, log: (line) => records.push(JSON.parse(line)) },
  );
  const send = (
    body: string,
    endpoint = "container-inventory",
    headers: Record<string, string> = { [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL) },
  ) =>
    route(
      new Request(`${requestOrigin ?? publicUrl}/api/docker-host/${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${"f".repeat(64)}`, ...headers },
        body,
      }),
    );
  return { hostId, installationId, publicUrl, records, send };
}

test("poll accepts the previous daemon protocol and refuses unsupported or missing protocols", async () => {
  const { installationId, send } = inventoryRouteFixture();
  const body = JSON.stringify({ installationId, version: "0.0.0" });
  for (const protocol of [DOCKER_HOST_PROTOCOL - 1, DOCKER_HOST_PROTOCOL]) {
    const response = await send(body, "poll", { [DOCKER_HOST_PROTOCOL_HEADER]: String(protocol) });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ job: null });
  }
  for (const protocol of [DOCKER_HOST_PROTOCOL - 2, DOCKER_HOST_PROTOCOL + 1, "1.0", null]) {
    const response = await send(
      body,
      "poll",
      protocol === null ? {} : { [DOCKER_HOST_PROTOCOL_HEADER]: String(protocol) },
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: { code: "docker_host_upgrade_required" } });
  }
});

test("a full Docker inventory with long container names reaches the reaper", async () => {
  const { hostId, installationId, publicUrl, records, send } = inventoryRouteFixture();
  const containers = Array.from({ length: 4096 }, (_, i) => ({
    machineId: i.toString(16).padStart(64, "0"),
    sandboxId: hostId,
    generation: installationId,
    deploymentId: `${publicUrl}/${hostId}/${installationId}`,
    createdAt: "2026-11-18T00:00:00.000Z",
    containerName: "a".repeat(255),
  }));
  const body = JSON.stringify({ installationId, containers });
  expect((await send(body))?.status).toBe(204);
  expect(records[0]).toMatchObject({ metric: "reaper_unknown_machines", count: 4096, complete: true });
});

test("an HTTPS alias poll supplies the deployment identity accepted by the inventory receiver", async () => {
  const alias = "https://alias.example";
  const { hostId, installationId, publicUrl, records, send } = inventoryRouteFixture(alias);
  const poll = await send(JSON.stringify({ installationId }), "poll");
  expect(poll?.status).toBe(200);
  const offer = (await poll?.json()) as { containerInventoryDeploymentId?: string };
  const deploymentId = offer.containerInventoryDeploymentId ?? `${alias}/${hostId}/${installationId}`;
  const response = await send(
    JSON.stringify({
      installationId,
      containers: [
        {
          machineId: "a".repeat(64),
          sandboxId: hostId,
          generation: installationId,
          deploymentId,
          createdAt: "2026-11-18T00:00:00.000Z",
          containerName: "observed-container",
        },
      ],
    }),
  );
  expect(response?.status).toBe(204);
  expect(records[0]).toMatchObject({ metric: "reaper_unknown_machines", count: 1, complete: true });
  expect(deploymentId).toBe(`${publicUrl}/${hostId}/${installationId}`);
});

test("an oversized Docker inventory is refused before reaching the reaper", async () => {
  const { installationId, records, send } = inventoryRouteFixture();
  const body = JSON.stringify({ installationId, containers: [] }).padEnd(5 * 1024 * 1024 + 1);
  const response = await send(body);
  expect(response?.status).toBe(413);
  expect(await response?.json()).toEqual({ error: { code: "invalid", message: "The request is too large." } });
  expect(records).toHaveLength(0);
});

test("an authenticated Docker inventory report counts only unknown containers in its own binding", async () => {
  const { db, sql, userId, orgId, store, authenticate, post } = await fixture();
  const actor = { userId, orgId };
  const installationId = randomUUID();
  const ticket = await store.issueRegistration(actor);
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  const poll = await post("/api/docker-host/poll", host.hostToken, {
    installationId,
    version: "2.57.1",
    resources: { cpus: 8, memoryBytes: 26 * 1024 ** 3 },
    resourcePolicyVersion: 1,
  });
  expect(await poll.json()).toMatchObject({ containerInventory: 1 });
  const credentialId = randomUUID();
  await db.query("insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)", [
    credentialId,
    userId,
    new Uint8Array([1]),
  ]);
  const sandboxes = createDockerSandboxService(sql, Buffer.alloc(32, 8).toString("base64"), { enabled: true });
  const sandbox = await sandboxes.reserve(actor, {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
  });
  const deploymentId = `https://public.example/${host.hostId}/${installationId}`;
  const owned = {
    machineId: "a".repeat(64),
    sandboxId: sandbox.id,
    generation: sandbox.generation,
    containerName: `armada-${installationId}-${host.hostId}-${sandbox.id}-${sandbox.generation}`,
    deploymentId,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const unknown = { ...owned, machineId: "b".repeat(64), sandboxId: randomUUID() };
  const records: unknown[] = [];
  const route = createDockerHostRoutes(store, authenticate, {
    publicUrl: "https://public.example",
    clock: { now: () => Date.parse("2026-11-18T01:00:00.000Z"), wait: async () => {} },
    log: (line) => records.push(JSON.parse(line)),
  });
  const report = {
    installationId,
    containers: [
      owned,
      unknown,
      { ...owned, machineId: "e".repeat(64), containerName: "operator-renamed" },
      { ...owned, machineId: "c".repeat(64), generation: randomUUID() },
      {
        ...unknown,
        machineId: "d".repeat(64),
        deploymentId: `https://foreign.example/${host.hostId}/${installationId}`,
      },
    ],
  };
  const send = (token: string, body: unknown) => post("/api/docker-host/container-inventory", token, body, {}, route);
  expect((await send(ticket.registrationToken, report)).status).toBe(401);
  expect((await send(host.hostToken, { ...report, installationId: randomUUID() })).status).toBe(401);
  expect((await send(host.hostToken, { ...report, containers: [owned, unknown, unknown] })).status).toBe(400);
  expect(records).toHaveLength(0);
  expect((await send(host.hostToken, report)).status).toBe(204);
  expect(records).toEqual([
    {
      metric: "reaper_unknown_machines",
      provider: "docker",
      source: host.hostId,
      count: 3,
      overdue: 3,
      complete: true,
    },
    {
      metric: "reaper_deleted",
      provider: "docker",
      source: host.hostId,
      reason: "unknown",
      candidates: 3,
      count: 0,
      reportOnly: true,
      complete: true,
    },
    {
      metric: "reaper_deleted",
      provider: "docker",
      source: host.hostId,
      reason: "terminal",
      candidates: 0,
      count: 0,
      reportOnly: true,
      complete: true,
    },
  ]);
});

test("a draining snapshot refusal is a typed conflict the dashboard can show, not a generic snapshot refusal", async () => {
  const f = await fixture();
  const route = createDockerHostRoutes(f.store, f.authenticate, {
    publicUrl: "https://public.example",
    snapshots: {
      command: async () => {
        throw new DockerHostDraining();
      },
    },
  });
  const response = await f.post("/api/v1/docker/snapshots/create", "fixture-user-token", { org: f.orgId }, {}, route);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "host_draining", message: expect.stringContaining("draining for uninstall") },
  });
});

test("snapshot routes record no provider call themselves; the service records host-work admission", async () => {
  const f = await fixture();
  const route = createDockerHostRoutes(f.store, f.authenticate, {
    publicUrl: "https://public.example",
    snapshots: { command: async () => ({ snapshots: [], currentVersion: "test" }) },
  });
  for (const operation of ["list", "get", "create", "rebuild"]) {
    const records: Record<string, unknown>[] = [];
    const response = (await observeRequest(
      () => f.post(`/api/v1/docker/snapshots/${operation}`, "fixture-user-token", { org: f.orgId }, {}, route),
      (line) => records.push(JSON.parse(line)),
    )) as Response;
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(records).toEqual([expect.objectContaining({ event: "http_request", requestId, status: 200 })]);
  }
});

// HTTP owns bearer separation, bounded shape admission and cache/error policy.
// Mailbox authority/replay/durability contracts remain owned by docker-host-store.test.ts.
test("opt-in host HTTP routes separate user and host capabilities and never cache or echo private input", async () => {
  const { db, orgId, userId, store, route, post } = await fixture();
  const installationId = randomUUID();
  const ticketResponse = await post("/api/v1/docker/hosts/register-token", "fixture-user-token", {
    org: orgId,
    name: "my-docker",
  });
  expect(ticketResponse.status).toBe(200);
  const ticket = (await ticketResponse.json()) as {
    hostId: string;
    registrationToken: string;
    command: string;
    expiresAt: string;
  };
  expect(ticket.command).toBe(
    `curl -fsSL --proto '=https' --proto-redir '=https' 'https://public.example/install-host.sh' | sh -s -- --token ${ticket.registrationToken}`,
  );
  const issued = await db.query<{ registration_expires_at: Date; name: string }>(
    "select registration_expires_at,name from docker_hosts where id=$1",
    [ticket.hostId],
  );
  expect(new Date(issued.rows[0]!.registration_expires_at).toISOString()).toBe(ticket.expiresAt);
  expect(issued.rows[0]!.name).toBe("my-docker");
  const registered = await post("/api/docker-host/register", ticket.registrationToken, { installationId });
  expect(registered.status).toBe(200);
  const host = (await registered.json()) as { hostId: string; hostToken: string };
  expect(host.hostId).toBe(ticket.hostId);
  expect((await post("/api/docker-host/poll", host.hostToken, { installationId })).status).toBe(200);
  const unused = await store.issueRegistration({ userId, orgId });
  for (const body of [
    {},
    { hostId: host.hostId, extra: true },
    { hostId: "malformed" },
    { installationId },
    { hostId: 42 },
  ])
    expect((await post("/api/docker-host/reuse-registration", unused.registrationToken, body)).status).toBe(400);
  for (const bearer of [host.hostToken, "fixture-user-token", "not-a-token"])
    expect((await post("/api/docker-host/reuse-registration", bearer, { hostId: host.hostId })).status).toBe(401);
  expect(
    (
      await post(
        "/api/docker-host/reuse-registration",
        unused.registrationToken,
        { hostId: host.hostId },
        { origin: "https://foreign.example" },
      )
    ).status,
  ).toBe(400);
  const reused = await post("/api/docker-host/reuse-registration", unused.registrationToken, { hostId: host.hostId });
  expect(reused.status).toBe(200);
  expect(await reused.json()).toEqual({ hostId: host.hostId, name: "my-docker" });
  const reuseDenied = await post("/api/docker-host/reuse-registration", unused.registrationToken, {
    hostId: host.hostId,
  });
  expect(reuseDenied.status).toBe(401);
  expect(await reuseDenied.json()).toEqual({ error: "docker_host_denied" });
  expect((await post("/api/v1/docker/hosts/register-token", host.hostToken, { org: orgId })).status).toBe(401);
  expect((await post("/api/docker-host/poll", "fixture-user-token", { installationId })).status).toBe(401);
  expect((await post("/api/docker-host/poll", host.hostToken, { installationId, unexpected: true })).status).toBe(400);
  expect(
    (await post("/api/docker-host/poll", host.hostToken, { installationId }, { origin: "https://foreign.example" }))
      .status,
  ).toBe(400);
  const expiry = { installationId, requestId: randomUUID(), expired: true };
  // Exact expiry packets reach machine authorization; ambiguous/nonliteral
  // packets are rejected by HTTP before any machine fact can be recorded.
  expect((await post("/api/docker-host/results", host.hostToken, expiry)).status).toBe(401);
  for (const body of [
    { ...expiry, expired: false },
    { ...expiry, expired: "true" },
    { ...expiry, outcome: "completed" },
    { ...expiry, extra: true },
  ])
    expect((await post("/api/docker-host/results", host.hostToken, body)).status).toBe(400);
  const denied = await post("/api/docker-host/results", host.hostToken, {
    installationId,
    requestId: randomUUID(),
    outcome: "completed",
  });
  expect(denied.status).toBe(401);
  // A known failure reason reaches machine authorization; a reason on a success, an unknown one or on an expiry
  // packet is refused by HTTP.
  const unknownJob = { installationId, requestId: randomUUID(), outcome: "failed" };
  expect(
    (await post("/api/docker-host/results", host.hostToken, { ...unknownJob, reason: "image_unavailable" })).status,
  ).toBe(401);
  for (const body of [
    { ...unknownJob, outcome: "completed", reason: "image_unavailable" },
    { ...unknownJob, reason: "unknown_failure" },
    { ...unknownJob, reason: 1 },
    { ...expiry, reason: "image_unavailable" },
  ])
    expect((await post("/api/docker-host/results", host.hostToken, body)).status).toBe(400);
  const deniedText = await denied.text();
  expect(deniedText.includes(host.hostToken)).toBe(false);
  expect(deniedText.includes(ticket.registrationToken)).toBe(false);
  expect(
    (await post("/api/v1/docker/hosts/revoke", "fixture-user-token", { org: orgId, hostId: host.hostId })).status,
  ).toBe(200);
  expect((await post("/api/docker-host/poll", host.hostToken, { installationId })).status).toBe(401);
  expect((await route(new Request("https://staging.example/api/docker-host/poll")))?.status).toBe(405);
  expect(await route(new Request("https://staging.example/unrelated"))).toBeNull();
});

// This route is the sole owner of the safe host-list DTO and its SQL-backed visibility/heartbeat contract.
test("host lists admit current members and expose only scoped safe heartbeat summaries and retained counts", async () => {
  const { db, orgId, userId, memberId, store, authenticate, post } = await fixture();
  const actor = { userId, orgId };
  const pending = await store.issueRegistration(actor);
  const expiredPending = await store.issueRegistration(actor);
  const revokedPending = await store.issueRegistration(actor);
  await store.revoke(actor, revokedPending.hostId);
  await db.query(`update docker_hosts set registration_expires_at=now()-interval '1 second' where id in ($1,$2)`, [
    expiredPending.hostId,
    revokedPending.hostId,
  ]);
  const registered = async () => {
    const ticket = await store.issueRegistration(actor);
    const installationId = randomUUID();
    const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
    return { ...host, installationId };
  };
  const online = await registered(),
    offline = await registered(),
    neverSeen = await registered(),
    revoked = await registered();
  // Registration expiry never hides a registered or explicitly revoked host.
  await db.query(
    `update docker_hosts set registration_expires_at=now()-interval '1 second' where installation_id is not null`,
  );
  const timestamp = "2026-01-01T00:00:00.000Z";
  await db.query(`update docker_hosts set created_at=$1`, [timestamp]);
  await db.query(`update docker_hosts set last_seen_at=now() where id in ($1,$2)`, [online.hostId, revoked.hostId]);
  await db.query(`update docker_hosts set last_seen_at=now()-interval '61 seconds' where id=$1`, [offline.hostId]);
  // Retained stopped sandboxes remain counted; deleted rows do not.
  async function sandbox(host: typeof online, status: "starting" | "stopped" | "deleted") {
    const id = randomUUID(),
      generation = randomUUID();
    await db.query(
      `insert into sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
      docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at,effective_ttl_seconds,
      stopped_at,deleted_at)
      values($1,$2,$3,'docker',$4,'codex',$5::public.sandbox_status,$6,$7,$8,$9,now()+interval '1 hour',3600,
        case when $5::public.sandbox_status in ('stopped','deleted') then now() else null end,
        case when $5::public.sandbox_status='deleted' then now() else null end)`,
      [
        id,
        orgId,
        memberId,
        `armada-${host.installationId}-${host.hostId}-${id}-${generation}`,
        status,
        host.hostId,
        host.installationId,
        generation,
        `example/worker@sha256:${"a".repeat(64)}`,
      ],
    );
  }
  await sandbox(online, "starting");
  await sandbox(online, "stopped");
  await sandbox(online, "deleted");
  await sandbox(offline, "stopped");
  await store.revoke(actor, revoked.hostId);
  const otherOrg = randomUUID(),
    foreignHost = randomUUID();
  await db.query(`insert into orgs(id,name) values($1,'foreign')`, [otherOrg]);
  await db.query(`insert into docker_hosts(id,org_id,owner_id,registration_expires_at) values($1,$2,$3,now())`, [
    foreignHost,
    otherOrg,
    userId,
  ]);
  const list = async () => {
    const response = await post("/api/v1/docker/hosts/list", "fixture-member-token", { org: orgId });
    expect(response.status).toBe(200);
    return (await response.json()) as DockerHostListResponse;
  };
  const result = await list();
  expect(result.targetVersion).toBe(VERSION);

  expect(result.placement).toBe(false);
  expect(result.hosts).toHaveLength(6);
  const byId = new Map(result.hosts.map((host) => [host.id, host]));
  expect(byId.has(expiredPending.hostId)).toBe(false);
  expect(byId.get(revokedPending.hostId)?.state).toBe("revoked");
  expect(byId.get(pending.hostId)).toEqual({
    diskFreeBytes: null,
    stoppedSandboxBytes: null,
    retentionSeconds: null,
    retentionOverrideSeconds: null,
    nextCleanupAt: null,
    id: pending.hostId,
    name: null,
    state: "pending",
    createdAt: timestamp,
    lastSeenAt: null,
    revokedAt: null,
    sandboxes: 0,
    canManageLimits: false,
    limitsSupported: false,
    running: 0,
    resources: null,
    version: null,
    protocol: null,
    upgradeRequired: true,
  });
  expect(byId.get(online.hostId)?.state).toBe("online");
  expect(byId.get(online.hostId)?.sandboxes).toBe(2);
  expect(byId.get(offline.hostId)?.state).toBe("offline");
  expect(byId.get(offline.hostId)?.sandboxes).toBe(1);
  expect(byId.get(neverSeen.hostId)?.state).toBe("offline");
  expect(byId.get(neverSeen.hostId)?.lastSeenAt).toBeNull();
  expect(byId.get(revoked.hostId)?.state).toBe("revoked");
  expect(byId.get(revoked.hostId)?.revokedAt).not.toBeNull();
  for (const host of result.hosts) {
    expect(Object.keys(host).sort()).toEqual([
      "canManageLimits",
      "createdAt",
      "diskFreeBytes",
      "id",
      "lastSeenAt",
      "limitsSupported",
      "name",
      "nextCleanupAt",
      "resources",
      "retentionOverrideSeconds",
      "retentionSeconds",
      "revokedAt",
      "running",
      "sandboxes",
      "state",
      "stoppedSandboxBytes",
      "version",
    ]);
    for (const value of [host.createdAt, host.lastSeenAt, host.revokedAt]) {
      if (value !== null) expect(new Date(value).toISOString()).toBe(value);
    }
  }
  expect(JSON.stringify(result)).not.toContain(online.hostToken);
  expect(JSON.stringify(result)).not.toContain(pending.registrationToken);
  const enabled = createDockerHostRoutes(store, authenticate, { placement: true });
  expect(
    await (await post("/api/v1/docker/hosts/list", "fixture-member-token", { org: orgId }, {}, enabled)).json(),
  ).toEqual({ ...result, placement: true });
  for (const [path, body] of [
    ["register-token", { org: orgId }],
    ["revoke", { org: orgId, hostId: online.hostId }],
  ] as const)
    expect((await post(`/api/v1/docker/hosts/${path}`, "fixture-member-token", body)).status).toBe(403);
  expect((await post("/api/v1/docker/hosts/list", online.hostToken, { org: orgId })).status).toBe(401);
  expect((await post("/api/v1/docker/hosts/list", "fixture-member-token", { org: otherOrg })).status).toBe(403);
  expect((await post("/api/v1/docker/hosts/list", "fixture-member-token", { org: orgId, extra: true })).status).toBe(
    400,
  );
  expect(
    (
      await post(
        "/api/v1/docker/hosts/list",
        "fixture-member-token",
        { org: orgId },
        { origin: "https://foreign.example" },
      )
    ).status,
  ).toBe(400);
  // A demoted issuer is still a current member; removed issuers are not active hosts.
  await db.query(`update members set role='member' where org_id=$1 and user_id=$2`, [orgId, userId]);
  expect((await list()).hosts.find((host) => host.id === online.hostId)?.state).toBe("online");
  await db.query(`delete from members where org_id=$1 and user_id=$2`, [orgId, userId]);
  expect((await list()).hosts.find((host) => host.id === online.hostId)?.state).toBe("offline");
  // The authenticate closure deliberately retains stale membership claims.
  await db.query(`delete from members where org_id=$1 and user_id=$2`, [orgId, memberId]);
  const denied = await post("/api/v1/docker/hosts/list", "fixture-member-token", { org: orgId });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "docker_host_denied" });
});

test("only the owner changes a drained capable host; policy reaches admission and the daemon", async () => {
  const { db, userId, orgId, store, post } = await fixture();
  const actor = { userId, orgId };
  const ticket = await store.issueRegistration(actor);
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  const body = { org: orgId, hostId: host.hostId };
  const endpoint = "/api/v1/docker/hosts/limits";
  expect((await post(endpoint, "fixture-user-token", { ...body, auto: true })).status).toBe(409);
  const poll = (capable: boolean) =>
    post("/api/docker-host/poll", host.hostToken, {
      installationId,
      version: "2.31.0",
      resources: { cpus: 8, memoryBytes: 26 * 1024 ** 3 },
      ...(capable ? { resourcePolicyVersion: 1 } : {}),
    });
  const first = await poll(true);
  expect(await first.json()).toMatchObject({ limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 4096 } });
  expect((await post(endpoint, "fixture-member-token", { ...body, cpus: 1 })).status).toBe(403);
  for (const patch of [{ cpus: 99 }, { memoryBytes: 0 }, { cpus: null }, { auto: true, cpus: 1 }])
    expect((await post(endpoint, "fixture-user-token", { ...body, ...patch })).status).toBe(400);
  const changed = await post(endpoint, "fixture-user-token", {
    ...body,
    cpus: 1,
    memoryBytes: 2 * 1024 ** 3,
    maxSandboxes: 3,
  });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ resources: { capacity: 3, mode: "manual" } });
  const sql: Sql = {
    query: (q, p) => db.query(q, p),
    transaction: (work) => db.transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
  };
  const sandboxes = createDockerSandboxService(sql, Buffer.alloc(32, 8).toString("base64"), { enabled: true });
  const credentialId = randomUUID();
  await db.query("insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)", [
    credentialId,
    userId,
    new Uint8Array([1]),
  ]);
  const input = { hostId: host.hostId, image: `worker@sha256:${"a".repeat(64)}`, credentialId, credentialVersion: 1 };
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await sandboxes.reserve(actor, { ...input, requestId: randomUUID() }));
  await expect(sandboxes.reserve(actor, { ...input, requestId: randomUUID() })).rejects.toThrow("3/3");
  expect((await post(endpoint, "fixture-user-token", { ...body, auto: true })).status).toBe(409);
  const raised = await post(endpoint, "fixture-user-token", { ...body, maxSandboxes: 4 });
  expect(raised.status).toBe(200);
  expect(await raised.json()).toMatchObject({ resources: { capacity: 4, mode: "manual" } });
  expect((await post(endpoint, "fixture-user-token", { ...body, maxSandboxes: 2 })).status).toBe(409);
  // An older daemon cannot execute override-sensitive starts, but cleanup stays available.
  expect(await (await poll(false)).json()).toMatchObject({ job: null, pendingStarts: [], resumeClaims: [] });
  const delivery = await (await poll(true)).json();
  expect(delivery).toMatchObject({
    job: { operation: "create" },
    limits: { cpus: 1, memoryBytes: 2 * 1024 ** 3, pids: 4096 },
  });
  for (const row of rows) {
    await store.complete(host.hostToken, installationId, { requestId: row.id, outcome: "completed" });
    await store.expired(host.hostToken, installationId, { requestId: row.id });
  }
  const reset = await post(endpoint, "fixture-user-token", { ...body, auto: true });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toMatchObject({ resources: { capacity: 6, mode: "automatic" } });
  await post(endpoint, "fixture-user-token", { ...body, cpus: 4 });
  await store.poll(host.hostToken, installationId, "2.31.0", false, { cpus: 2, memoryBytes: 26 * 1024 ** 3 }, 1);
  await expect(sandboxes.reserve(actor, { ...input, requestId: randomUUID() })).rejects.toThrow(
    "Host hardware changed",
  );
  expect((await store.list(actor))[0]?.resources).toBeNull();
  expect((await post(endpoint, "fixture-user-token", { ...body, auto: true })).status).toBe(200);
});

test("heartbeat availability is validated and drives the public busy-capacity summary", async () => {
  const { userId, orgId, store, post } = await fixture();
  const ticket = await store.issueRegistration({ userId, orgId });
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  const resources = { cpus: 16, memoryBytes: 38 * 1024 ** 3, availableCpus: 8, availableMemoryBytes: 30 * 1024 ** 3 };
  const poll = (value: unknown, diskFreeBytes: unknown = 20_000_000_000) =>
    post("/api/docker-host/poll", host.hostToken, {
      installationId,
      version: "2.33.0",
      resourcePolicyVersion: 1,
      resources: value,
      diskFreeBytes,
    });
  expect((await poll(resources)).status).toBe(200);
  const listed = await post("/api/v1/docker/hosts/list", "fixture-user-token", { org: orgId });
  const list = (await listed.json()) as DockerHostListResponse;
  expect(list.hosts[0]).toMatchObject({ diskFreeBytes: 20_000_000_000, resources: { capacity: 7, heldBack: 2 } });
  for (const invalid of [-1, 0.5, "lots", Number.MAX_SAFE_INTEGER + 1])
    expect((await poll(resources, invalid)).status).toBe(400);
  expect((await poll(resources, null)).status).toBe(200);
  for (const invalid of [
    { ...resources, availableCpus: 17 },
    { ...resources, availableMemoryBytes: -1 },
    { cpus: 16, memoryBytes: 38 * 1024 ** 3, availableCpus: 8 },
  ])
    expect((await poll(invalid)).status).toBe(400);
});

test("a host reporting many retained deadlines still fits the poll body limit", async () => {
  const { userId, orgId, store, post } = await fixture();
  const ticket = await store.issueRegistration({ userId, orgId });
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  // A busy host retains more generations than fit in the previous 4 KiB cap.
  const deadlines = Array.from({ length: 128 }, () => ({
    sandboxId: randomUUID(),
    generation: randomUUID(),
    deadline: new Date().toISOString(),
  }));
  const response = await post("/api/docker-host/poll", host.hostToken, {
    installationId,
    version: "2.33.0",
    retentionSeconds: 3600,
    nextCleanupAt: new Date().toISOString(),
    deadlines,
  });
  expect(JSON.stringify({ deadlines }).length).toBeGreaterThan(4096);
  expect(response.status).toBe(200);
});

test("a held host poll returns a locally enqueued job with the clock frozen", async () => {
  const { userId, orgId, store, authenticate, post } = await fixture();
  const actor = { userId, orgId };
  const ticket = await store.issueRegistration(actor);
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  const job = {
    requestId: randomUUID(),
    operation: "create" as const,
    request: {
      sandboxId: randomUUID(),
      generation: randomUUID(),
      image: `example/worker@sha256:${"a".repeat(64)}`,
      ttlSeconds: 300,
    },
  };
  const waiting = Promise.withResolvers<AbortSignal>();
  const delay = Promise.withResolvers<void>();
  const held = createDockerHostRoutes(store, authenticate, {
    clock: {
      now: () => 0,
      wait(_ms, signal) {
        signal.addEventListener("abort", () => delay.resolve(), { once: true });
        waiting.resolve(signal);
        return delay.promise;
      },
    },
  });
  const poll = post(
    "/api/docker-host/poll",
    host.hostToken,
    { installationId, version: "2.51.0", waitSeconds: 20 },
    {},
    held,
  );
  const signal = await Promise.race([
    waiting.promise,
    poll.then(() => {
      throw new Error("Host poll returned before waiting");
    }),
  ]);
  try {
    await store.enqueue(actor, host.hostId, job);
    expect(signal.aborted).toBe(true);
  } finally {
    if (!signal.aborted) delay.reject(new Error("Host poll received no enqueue wake"));
  }
  const response = await poll;
  expect(await response.json()).toMatchObject({ held: true, job });
});

test("a held host poll answers as soon as work appears and never beyond its hold", async () => {
  let time = 0;
  let polls = 0;
  let probes = 0;
  let readyAt = Number.POSITIVE_INFINITY;
  let refused = false;
  let retentionWrites = 0;
  const running: (readonly string[])[] = [];
  const job = { requestId: randomUUID(), operation: "stop" };
  const store = {
    async retentionForHost() {
      retentionWrites++;
      return { hostId: randomUUID(), retentionSeconds: undefined };
    },
    resumeClaimsForHost: async () => [],
    pendingStartsForHost: async () => [],
    async poll(...args: unknown[]) {
      polls++;
      running.push(args[8] as readonly string[]);
      return time >= readyAt && !refused ? job : null;
    },
    async mayHaveWork(...args: unknown[]) {
      probes++;
      running.push(args[3] as readonly string[]);
      return time >= readyAt;
    },
  } as unknown as ReturnType<typeof createDockerHostStore>;
  const route = createDockerHostRoutes(store, async () => ({ ok: false as const }), {
    clock: {
      now: () => time,
      async wait(ms) {
        time += ms;
      },
    },
  });
  const poll = async (extra: Record<string, unknown>) => {
    const response = await route(
      new Request("https://staging.example/api/docker-host/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(64)}`,
          "content-type": "application/json",
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
        },
        body: JSON.stringify({ installationId: randomUUID(), version: "2.51.0", ...extra }),
      }),
    );
    if (!response) throw new Error("Expected Docker host route");
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  };
  const inFlight = randomUUID();
  readyAt = 2000;
  expect(await poll({ waitSeconds: 20, running: [inFlight] })).toMatchObject({
    status: 200,
    body: { held: true, job },
  });
  // Rechecks are read-only probes; the full poll repeats only once one hits.
  expect([polls, probes, time]).toEqual([2, 2, 2000]);
  expect(running).toEqual([[inFlight], [inFlight], [inFlight], [inFlight]]);
  // Nothing arrives: the hold is capped at 20 seconds, whatever was asked,
  // and an idle hold runs the full (writing) poll only once.
  [polls, probes, time, readyAt] = [0, 0, 0, Number.POSITIVE_INFINITY];
  expect(await poll({ waitSeconds: 600 })).toMatchObject({ status: 200, body: { held: true, job: null } });
  expect([polls, probes, time]).toEqual([1, 20, 20_000]);
  // A probe the full poll cannot serve (a refused admission) is not retried
  // within the hold: one more full poll, not one per second.
  [polls, probes, time, readyAt, refused] = [0, 0, 0, 0, true];
  expect(await poll({ waitSeconds: 20 })).toMatchObject({ status: 200, body: { held: true, job: null } });
  expect([polls, probes, time]).toEqual([2, 1, 20_000]);
  // Without the opt-in the poll answers at once, as for older daemons.
  [polls, probes, time] = [0, 0, 0];
  expect(await poll({})).toMatchObject({
    status: 200,
    body: {
      job: null,
      pendingStarts: [],
      resumeClaims: [],
      targetVersion: VERSION,
    },
  });
  expect([polls, time]).toEqual([1, 0]);
  retentionWrites = 0;
  for (const invalid of [{ waitSeconds: 0 }, { waitSeconds: 1.5 }, { running: ["not-a-uuid"] }, { running: "x" }])
    expect((await poll(invalid)).status).toBe(400);
  // Refused before any write: an older daemon's fallback poll is the only one that writes.
  expect(retentionWrites).toBe(0);
});

test("a host poll skips work the daemon reports running and hands out another sandbox's job", async () => {
  const { db, userId, orgId, store, post, authenticate: fixtureAuth } = await fixture();
  const actor = { userId, orgId };
  const ticket = await store.issueRegistration(actor);
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  const poll = (running: string[]) =>
    post("/api/docker-host/poll", host.hostToken, {
      installationId,
      version: "2.51.0",
      resources: { cpus: 8, memoryBytes: 26 * 1024 ** 3 },
      resourcePolicyVersion: 1,
      running,
    });
  expect((await poll([])).status).toBe(200);
  const sql: Sql = {
    query: (q, p) => db.query(q, p),
    transaction: (work) => db.transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
  };
  const sandboxes = createDockerSandboxService(sql, Buffer.alloc(32, 8).toString("base64"), { enabled: true });
  const credentialId = randomUUID();
  await db.query("insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)", [
    credentialId,
    userId,
    new Uint8Array([1]),
  ]);
  const input = { hostId: host.hostId, image: `worker@sha256:${"a".repeat(64)}`, credentialId, credentialVersion: 1 };
  const first = await sandboxes.reserve(actor, { ...input, requestId: randomUUID() });
  const second = await sandboxes.reserve(actor, { ...input, requestId: randomUUID() });
  const job = async (running: string[]) =>
    ((await (await poll(running)).json()) as { job: { requestId: string } | null }).job;
  const head = await job([]);
  expect(head).toMatchObject({ operation: "create", request: { sandboxId: first.id } });
  const next = await job([head!.requestId]);
  expect(next).toMatchObject({ operation: "create", request: { sandboxId: second.id } });
  expect(await job([head!.requestId, next!.requestId])).toBeNull();

  // Held: a stop queued behind the running create stays fenced until the create's
  // completion is recorded, then is handed out on the next recheck, not after the hold.
  let time = 0;
  const steps = [
    () => sandboxes.stop(actor, first.id, randomUUID()),
    () => store.complete(host.hostToken, installationId, { requestId: head!.requestId, outcome: "completed" }),
  ];
  const held = createDockerHostRoutes(store, fixtureAuth, {
    clock: {
      now: () => time,
      async wait(ms) {
        await steps.shift()?.();
        time += ms;
      },
    },
  });
  const response = await post(
    "/api/docker-host/poll",
    host.hostToken,
    {
      installationId,
      version: "2.51.0",
      resources: { cpus: 8, memoryBytes: 26 * 1024 ** 3 },
      resourcePolicyVersion: 1,
      waitSeconds: 20,
      running: [head!.requestId, next!.requestId],
    },
    {},
    held,
  );
  expect(await response.json()).toMatchObject({
    held: true,
    job: { operation: "stop", request: { sandboxId: first.id } },
  });
  expect(time).toBe(2000);
});
