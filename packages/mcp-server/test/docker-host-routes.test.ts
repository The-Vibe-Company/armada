import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DockerHostListResponse, Sql } from "@armada/core";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { migratedDatabase } from "./migrated-database.ts";

async function fixture() {
  const db = await migratedDatabase();
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
    transaction: (work) => db.transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
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
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
      }),
    );
    if (!response) throw new Error("Expected Docker host route");
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response;
  }
  return { db, userId, memberId, orgId, store, authenticate, route, post };
}

// HTTP owns bearer separation, bounded shape admission and cache/error policy.
// Mailbox authority/replay/durability contracts remain owned by docker-host-store.test.ts.
test("opt-in host HTTP routes separate user and host capabilities and never cache or echo private input", async () => {
  const { db, orgId, userId, store, route, post } = await fixture();
  const installationId = randomUUID();
  try {
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
    expect((await post("/api/docker-host/poll", host.hostToken, { installationId, unexpected: true })).status).toBe(
      400,
    );
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
      { ...unknownJob, reason: "disk_full" },
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
  } finally {
    await db.close();
  }
});

// This route is the sole owner of the safe host-list DTO and its SQL-backed visibility/heartbeat contract.
test("host lists admit current members and expose only scoped safe heartbeat summaries and retained counts", async () => {
  const { db, orgId, userId, memberId, store, authenticate, post } = await fixture();
  try {
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
    expect(Object.keys(result).sort()).toEqual(["hosts", "placement"]);
    expect(result.placement).toBe(false);
    expect(result.hosts).toHaveLength(6);
    const byId = new Map(result.hosts.map((host) => [host.id, host]));
    expect(byId.has(expiredPending.hostId)).toBe(false);
    expect(byId.get(revokedPending.hostId)?.state).toBe("revoked");
    expect(byId.get(pending.hostId)).toEqual({
      id: pending.hostId,
      name: null,
      state: "pending",
      createdAt: timestamp,
      lastSeenAt: null,
      revokedAt: null,
      sandboxes: 0,
      version: null,
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
        "createdAt",
        "id",
        "lastSeenAt",
        "name",
        "revokedAt",
        "sandboxes",
        "state",
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
  } finally {
    await db.close();
  }
});
