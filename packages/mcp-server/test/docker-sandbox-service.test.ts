import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import type { dockerRuntimeConfiguration } from "../src/docker-runtime-configuration.ts";
import { createDockerSandboxService, DockerSandboxDenied } from "../src/docker-sandbox-service.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const key = Buffer.alloc(32, 7).toString("base64");
const hosts = createDockerHostStore(sql, key);
const service = createDockerSandboxService(sql, key, { enabled: true });
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});
async function fixture(ttlSeconds?: number) {
  const orgId = randomUUID(),
    issuerId = randomUUID(),
    userId = randomUUID(),
    otherId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2),($3)`, [issuerId, userId, otherId]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `reservation-${orgId}`]);
  await db.query(
    `insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member'),($1,$4,'member')`,
    [orgId, issuerId, userId, otherId],
  );
  const admin = { userId: issuerId, orgId },
    actor = { userId, orgId },
    other = { userId: otherId, orgId };
  const registration = await hosts.issueRegistration(admin),
    installationId = randomUUID();
  const host = await hosts.exchangeRegistration(registration.registrationToken, installationId);
  await db.query(
    "update public.docker_hosts set free_disk_bytes=$2,disk_floor_bytes=$3,last_seen_at=now() where id=$1",
    [host.hostId, 100 * 1024 ** 3, 10 * 1024 ** 3],
  );

  const credentialId = randomUUID();
  await db.query(`insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)`, [
    credentialId,
    userId,
    new Uint8Array([1]),
  ]);
  const input = {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
  return { actor, admin, other, installationId, ...host, input };
}
async function denied(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(DockerSandboxDenied);
  await expect(work).rejects.toThrow("Docker sandbox denied");
}

// This owner boundary protects allocation opt-in, not the model resolver's catalog matrix.
test("reservation is literal opt-in and accepts only pinned, narrow metadata", async () => {
  const f = await fixture();
  for (const enabled of [undefined, false, "true", 1]) {
    await denied(createDockerSandboxService(sql, key, { enabled } as never).reserve(f.actor, f.input));
  }
  for (const change of [
    { image: "worker:latest" },
    { ttlSeconds: 86401 },
    { credentialVersion: 0 },
    { env: { TOKEN: "not-an-input" } },
    { model: 1 },
    { ttlSeconds: 0 },
    { ttlSeconds: null },
  ]) {
    await denied(service.reserve(f.actor, { ...f.input, ...change } as never));
  }
  expect((await db.query(`select 1 from public.sandboxes where id=$1`, [f.input.requestId])).rows).toHaveLength(0);
});

test("member allocation and lost-commit-response retry retain one SQL-derived bound create", async () => {
  const f = await fixture();
  let lost = true;
  const lostResponse: Sql = {
    ...sql,
    transaction: async (work) => {
      if (!sql.transaction) throw Error("transactions required");
      const result = await sql.transaction(work);
      if (lost) {
        lost = false;
        throw Error("lost commit response");
      }
      return result;
    },
  };
  await denied(createDockerSandboxService(lostResponse, key, { enabled: true }).reserve(f.actor, f.input));
  const initial = await service.get(f.actor, f.input.requestId);
  const retried = await createDockerSandboxService(sql, key, { enabled: true }).reserve(f.actor, f.input);
  expect(retried).toEqual(initial);
  const projectionTarget: Parameters<typeof dockerRuntimeConfiguration>[0]["sandbox"] = retried;
  expect(projectionTarget).toMatchObject({ deletedAt: null, stopRequestedAt: null });
  expect(
    (
      await db.query<{ requested_ttl_seconds: number | null }>(
        `select requested_ttl_seconds from public.sandboxes where id=$1`,
        [retried.id],
      )
    ).rows[0]?.requested_ttl_seconds,
  ).toBeNull();
  expect(retried).toMatchObject({
    provider: "docker",
    ownerId: f.actor.userId,
    orgId: f.actor.orgId,
    harness: "codex",
    visibility: "private",
    status: "starting",
    ttlSeconds: 14400,
    repositoryDir: null,
    credentialId: f.input.credentialId,
    credentialVersion: 1,
  });
  expect(retried.providerSandboxId).toBe(`armada-${f.installationId}-${f.hostId}-${retried.id}-${retried.generation}`);
  const delivery = await hosts.poll(f.hostToken, f.installationId, undefined, false, {
    cpus: 128,
    memoryBytes: 1024 ** 4,
    disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
  });
  expect(delivery).toEqual({
    requestId: retried.id,
    operation: "create",
    request: {
      sandboxId: retried.id,
      generation: retried.generation,
      image: f.input.image,
      ttlSeconds: 14400,
      expiresAt: Date.parse(retried.expiresAt),
    },
  });
  expect(
    (await db.query(`select 1 from public.docker_host_jobs where bound_sandbox_id=$1`, [retried.id])).rows,
  ).toHaveLength(1);
  await hosts.complete(f.hostToken, f.installationId, { requestId: retried.id, outcome: "completed" });
  expect((await service.get(f.actor, retried.id)).status).toBe("starting");
  expect(await service.job(f.actor, retried.id, retried.id)).toEqual({
    requestId: retried.id,
    operation: "create",
    state: "completed",
  });
  expect(JSON.stringify(retried)).not.toMatch(/golden|boat|value_enc|input_enc/);
});

test("first allocation validates account scope/version/status; retries reject changed claims and current authority", async () => {
  const f = await fixture();
  await denied(service.reserve(f.other, f.input)); // User-scoped account is not the other member's account.
  await denied(service.reserve(f.actor, { ...f.input, credentialVersion: 2 }));
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.input.credentialId]);
  await denied(service.reserve(f.actor, f.input));
  await db.query(`update public.credentials set status='active',expires_at=now()-interval '1 second' where id=$1`, [
    f.input.credentialId,
  ]);
  await denied(service.reserve(f.actor, f.input));
  await db.query(`update public.credentials set expires_at=null where id=$1`, [f.input.credentialId]);
  const saved = await service.reserve(f.actor, f.input);
  const another = await hosts.issueRegistration(f.admin);
  const secondHost = await hosts.exchangeRegistration(another.registrationToken, randomUUID());
  for (const change of [
    { hostId: secondHost.hostId },
    { ttlSeconds: 30 },
    { image: `other@sha256:${"b".repeat(64)}` },
    { model: "other-model" },
    { credentialVersion: 2 },
    { credentialId: randomUUID() },
  ]) {
    await denied(service.reserve(f.actor, { ...f.input, ...change }));
  }
  await denied(service.reserve(f.other, f.input));
  const foreign = await fixture();
  await denied(service.reserve(foreign.actor, f.input));
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.input.credentialId]);
  expect(await service.reserve(f.actor, f.input)).toEqual(saved); // Historical admission, no replacement.
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await denied(service.reserve(f.actor, f.input));
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await denied(service.reserve(f.actor, f.input)); // Rejoined member has a different actor epoch.
  await hosts.revoke(f.admin, f.hostId);
  expect((await service.get(f.actor, saved.id)).generation).toBe(saved.generation);
});

test("bound job insert failure rolls back both reservation and machine claim", async () => {
  const f = await fixture();
  await db.exec(`create function public.reject_reservation_job() returns trigger language plpgsql as $$
    begin raise exception 'private failure detail'; end $$;
    create trigger reject_reservation_job before insert on public.docker_host_jobs
    for each row execute function public.reject_reservation_job();`);
  try {
    await denied(service.reserve(f.actor, f.input));
  } finally {
    await db.exec(
      `drop trigger reject_reservation_job on public.docker_host_jobs; drop function public.reject_reservation_job();`,
    );
  }
  expect((await db.query(`select 1 from public.sandboxes where id=$1`, [f.input.requestId])).rows).toHaveLength(0);
  expect(
    (await db.query(`select 1 from public.docker_host_jobs where request_id=$1`, [f.input.requestId])).rows,
  ).toHaveLength(0);
  const admitted = await service.reserve(f.actor, f.input);
  expect(admitted.status).toBe("starting");
  const manualId = randomUUID();
  await db.query(
    `insert into public.sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
    docker_host_id,docker_installation_id,docker_generation,docker_image,model,reasoning_effort,
    credential_id,credential_version,effective_ttl_seconds,expires_at)
    select $1,org_id,owner_id,provider,$2,harness,status,docker_host_id,docker_installation_id,
    docker_generation,docker_image,model,reasoning_effort,credential_id,credential_version,effective_ttl_seconds,expires_at
    from public.sandboxes where id=$3`,
    [manualId, `armada-${f.installationId}-${f.hostId}-${manualId}-${admitted.generation}`, admitted.id],
  );
  await denied(service.reserve(f.actor, { ...f.input, requestId: manualId }));
});

test("retained owner/admin diagnostics and delegated cleanup are independent of allocation flag", async () => {
  const f = await fixture(300),
    saved = await service.reserve(f.actor, f.input);
  expect(
    (
      await db.query<{ requested_ttl_seconds: number }>(
        `select requested_ttl_seconds from public.sandboxes where id=$1`,
        [saved.id],
      )
    ).rows[0]?.requested_ttl_seconds,
  ).toBe(300);
  const retained = createDockerSandboxService(sql, key);
  await denied(retained.get(f.other, saved.id));
  await denied(retained.job(f.other, saved.id, saved.id));
  await denied(retained.stop(f.other, saved.id, randomUUID()));
  expect(await retained.get(f.admin, saved.id)).toEqual(saved);
  expect(await retained.job(f.actor, saved.id, randomUUID())).toBeNull();
  await hosts.complete(f.hostToken, f.installationId, { requestId: saved.id, outcome: "completed" });
  const stopId = randomUUID(),
    deleteId = randomUUID();
  await retained.stop(f.admin, saved.id, stopId);
  const stopping = await retained.get(f.actor, saved.id);
  expect(stopping.status).toBe("stopping");
  expect(stopping.stopRequestedAt).not.toBeNull();
  expect(
    await hosts.poll(f.hostToken, f.installationId, undefined, false, {
      cpus: 128,
      memoryBytes: 1024 ** 4,
      disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
    }),
  ).toMatchObject({ requestId: stopId, operation: "stop" });
  await hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  expect((await retained.get(f.actor, saved.id)).status).toBe("stopped");
  expect((await service.reserve(f.actor, f.input)).generation).toBe(saved.generation);
  await retained.delete(f.actor, saved.id, deleteId);
  expect((await retained.get(f.actor, saved.id)).status).toBe("stopped");
  await hosts.complete(f.hostToken, f.installationId, { requestId: deleteId, outcome: "completed" });
  const deleted = await retained.get(f.actor, saved.id);
  expect(deleted.status).toBe("deleted");
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.stopRequestedAt).toBe(stopping.stopRequestedAt);
  await hosts.revoke(f.admin, f.hostId);
  await denied(service.reserve(f.actor, f.input));
  expect(await retained.job(f.admin, saved.id, deleteId)).toEqual({
    requestId: deleteId,
    operation: "delete",
    state: "completed",
  });
  expect((await retained.get(f.actor, saved.id)).status).toBe("deleted");
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await denied(retained.get(f.actor, saved.id));
});

test("host capacity reserves pending starts, preserves retries, and releases only confirmed physical stops", async () => {
  const f = await fixture();
  // Heartbeat observations, not user-supplied launch choices, establish capacity.
  await hosts.poll(f.hostToken, f.installationId, "2.31.0", false, {
    ...{ cpus: 2, memoryBytes: 6 * 1024 ** 3 },
    disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
  });
  await db.query("update public.docker_hosts set name='capacity-host' where id=$1", [f.hostId]);
  const first = await service.reserve(f.actor, f.input);
  expect((await hosts.list(f.actor))[0]).toMatchObject({
    running: 1,
    resources: {
      capacity: 1,
      mode: "automatic",
      machine: { cpus: 2, memoryBytes: 6 * 1024 ** 3 },
      perSandbox: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 4096 },
    },
  });
  expect(await service.reserve(f.actor, f.input)).toEqual(first);
  const next = { ...f.input, requestId: randomUUID() };
  await expect(service.reserve(f.actor, next)).rejects.toThrow(
    "Host capacity-host is full: 1/1 sandboxes running; stop one or raise the limit.",
  );
  await hosts.complete(f.hostToken, f.installationId, { requestId: first.id, outcome: "completed" });
  const stop = randomUUID();
  await service.stop(f.actor, first.id, stop);
  await expect(service.reserve(f.actor, next)).rejects.toThrow("is full");
  await hosts.complete(f.hostToken, f.installationId, { requestId: stop, outcome: "completed" });
  const second = await service.reserve(f.actor, next);
  expect(second.id).toBe(next.requestId);
  // A daemon TTL observation is physical stop proof too, including failed startup rows.
  await hosts.expired(f.hostToken, f.installationId, { requestId: second.id });
  expect((await service.reserve(f.actor, { ...f.input, requestId: randomUUID() })).status).toBe("starting");
});

test("available resource admission and displayed held-back slots agree without evicting reservations", async () => {
  const f = await fixture();
  const hardware = { cpus: 16, memoryBytes: 38 * 1024 ** 3 };
  await hosts.poll(
    f.hostToken,
    f.installationId,
    "2.33.0",
    false,
    {
      ...{ ...hardware, availableCpus: 8, availableMemoryBytes: 30 * 1024 ** 3 },
      disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
    },
    1,
  );
  const saved = [];
  for (let i = 0; i < 5; i++) saved.push(await service.reserve(f.actor, { ...f.input, requestId: randomUUID() }));
  expect((await hosts.list(f.actor))[0]).toMatchObject({ running: 5, resources: { capacity: 7, heldBack: 2 } });
  await hosts.poll(
    f.hostToken,
    f.installationId,
    "2.33.0",
    false,
    {
      ...{ ...hardware, availableCpus: 0, availableMemoryBytes: 0 },
      disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
    },
    1,
  );
  expect((await hosts.list(f.actor))[0]).toMatchObject({ running: 5, resources: { capacity: 5, heldBack: 4 } });
  await expect(service.reserve(f.actor, { ...f.input, requestId: randomUUID() })).rejects.toMatchObject({
    code: "host_full",
  });
  // Earlier admitted UUIDs reconcile, rather than consuming another slot under pressure.
  expect((await service.reserve(f.actor, { ...f.input, requestId: saved[0]!.id })).id).toBe(saved[0]!.id);
  await hosts.poll(
    f.hostToken,
    f.installationId,
    "2.33.0",
    false,
    {
      ...{ ...hardware, availableCpus: 8, availableMemoryBytes: 30 * 1024 ** 3 },
      disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 },
    },
    1,
  );
  expect((await service.reserve(f.actor, { ...f.input, requestId: randomUUID() })).status).toBe("starting");
  // An older daemon's next poll removes stale observations rather than inventing current headroom.
  await hosts.poll(
    f.hostToken,
    f.installationId,
    "2.32.0",
    false,
    { ...hardware, disk: { freeBytes: 100 * 1024 ** 3, floorBytes: 10 * 1024 ** 3 } },
    1,
  );
  expect((await hosts.list(f.actor))[0]?.resources?.capacity).toBe(9);
});

test("disk admission refuses low, unknown and stale telemetry before reservation while exact-floor admission and retained cleanup remain available", async () => {
  const f = await fixture();
  const floor = 10 * 1024 ** 3;
  for (const [free, reportedFloor, fresh, diagnostic] of [
    [floor - 1, floor, true, "below this host's configured floor"],
    [null, floor, true, "free space is unavailable"],
    [floor * 2, null, true, "free space is unavailable"],
    [floor * 2, floor, false, "fresh host heartbeat"],
  ] as const) {
    await db.query(
      "update public.docker_hosts set free_disk_bytes=$2,disk_floor_bytes=$3,last_seen_at=now()-$4::integer*interval '1 second' where id=$1",
      [f.hostId, free, reportedFloor, fresh ? 0 : 61],
    );
    const request = { ...f.input, requestId: randomUUID() };
    await expect(service.reserve(f.actor, request)).rejects.toThrow(diagnostic);
    expect((await db.query("select id from sandboxes where id=$1", [request.requestId])).rows).toHaveLength(0);
    expect(
      (await db.query("select request_id from docker_host_jobs where request_id=$1", [request.requestId])).rows,
    ).toHaveLength(0);
  }
  await hosts.poll(f.hostToken, f.installationId, "2.47.0", false, {
    cpus: 4,
    memoryBytes: 16 * 1024 ** 3,
    disk: { freeBytes: floor, floorBytes: floor },
  });
  expect((await hosts.list(f.actor))[0]?.disk).toEqual({ freeBytes: floor, floorBytes: floor });
  const admitted = await service.reserve(f.actor, f.input);
  // An old daemon heartbeat invalidates cached disk data; historical retries never allocate again.
  await hosts.poll(f.hostToken, f.installationId);
  expect((await hosts.list(f.actor))[0]?.disk).toBeNull();
  expect(await service.reserve(f.actor, f.input)).toEqual(admitted);
  await hosts.complete(f.hostToken, f.installationId, { requestId: admitted.id, outcome: "completed" });
  const stop = randomUUID();
  await service.stop(f.actor, admitted.id, stop);
  await hosts.complete(f.hostToken, f.installationId, { requestId: stop, outcome: "completed" });
  const remove = randomUUID();
  await service.delete(f.actor, admitted.id, remove);
  await hosts.complete(f.hostToken, f.installationId, { requestId: remove, outcome: "completed" });
  expect((await service.get(f.actor, admitted.id)).status).toBe("deleted");
});
