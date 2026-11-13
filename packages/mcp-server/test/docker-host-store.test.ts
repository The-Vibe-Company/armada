import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { createDockerHostStore, DockerHostDenied } from "../src/docker-host-store.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (query, params) => db.query(query, params),
  transaction: (work) => db.transaction((tx) => work({ query: (query, params) => tx.query(query, params) })),
};
const key = Buffer.alloc(32, 7).toString("base64");
const store = createDockerHostStore(sql, key);
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});
async function fixture() {
  const userId = randomUUID(),
    memberId = randomUUID(),
    backupAdmin = randomUUID(),
    orgId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2),($3)`, [userId, memberId, backupAdmin]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `docker-${orgId}`]);
  await db.query(
    `insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member'),($1,$4,'admin')`,
    [orgId, userId, memberId, backupAdmin],
  );
  const actor = { userId, orgId };
  const ticket = await store.issueRegistration(actor);
  const installationId = randomUUID();
  const host = await store.exchangeRegistration(ticket.registrationToken, installationId);
  return { actor, memberId, ticket, installationId, ...host };
}
function job() {
  return {
    requestId: randomUUID(),
    operation: "create" as const,
    request: {
      sandboxId: randomUUID(),
      generation: randomUUID(),
      image: `example/worker@sha256:${"a".repeat(64)}`,
      ttlSeconds: 300,
    },
  };
}
async function denied(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(DockerHostDenied);
  await expect(work).rejects.toThrow("Docker host denied");
}

// Each case owns an independent security/durability contract at the actual SQL boundary.
test("current admin admission rejects members, cross-org access, and malformed job payloads", async () => {
  const a = await fixture(),
    b = await fixture();
  await denied(store.issueRegistration({ ...a.actor, userId: a.memberId }));
  await denied(store.revoke(b.actor, a.hostId));
  await denied(store.enqueue(b.actor, a.hostId, job()));
  await denied(
    store.enqueue(a.actor, a.hostId, { ...job(), request: { ...job().request, apiKey: "not-allowed" } } as never),
  );
  await denied(store.poll("malformed", a.installationId));
  await denied(store.complete(a.hostToken, a.installationId, { requestId: "invalid", outcome: "failed" }));
  await db.query(`update public.members set role='member' where org_id=$1 and user_id=$2`, [
    a.actor.orgId,
    a.actor.userId,
  ]);
  await denied(store.enqueue(a.actor, a.hostId, job()));
});

test("registration is single-use, expires, and rechecks the issuing admin", async () => {
  const a = await fixture();
  await denied(store.exchangeRegistration(a.ticket.registrationToken, a.installationId));
  const expired = await store.issueRegistration(a.actor);
  const pending = await db.query<{ registration_hash: string }>(
    `select registration_hash from public.docker_hosts where id=$1`,
    [expired.hostId],
  );
  expect(pending.rows[0]?.registration_hash).toBe(createHash("sha256").update(expired.registrationToken).digest("hex"));
  await db.query(`update public.docker_hosts set registration_expires_at=now()-interval '1 second' where id=$1`, [
    expired.hostId,
  ]);
  await denied(store.exchangeRegistration(expired.registrationToken, randomUUID()));
  const demoted = await store.issueRegistration(a.actor);
  await db.query(`update public.members set role='member' where org_id=$1 and user_id=$2`, [
    a.actor.orgId,
    a.actor.userId,
  ]);
  await denied(store.exchangeRegistration(demoted.registrationToken, randomUUID()));
});

test("host credentials bind installation, owner membership, and revocation", async () => {
  const a = await fixture();
  const task = job();
  await store.enqueue(a.actor, a.hostId, task);
  await denied(store.poll(a.hostToken, randomUUID()));
  await denied(store.complete(a.hostToken, randomUUID(), { requestId: task.requestId, outcome: "completed" }));
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [a.actor.orgId, a.actor.userId]);
  await denied(store.poll(a.hostToken, a.installationId));
  await denied(store.complete(a.hostToken, a.installationId, { requestId: task.requestId, outcome: "completed" }));
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'admin')`, [
    a.actor.orgId,
    a.actor.userId,
  ]);
  await store.revoke(a.actor, a.hostId);
  await denied(store.poll(a.hostToken, a.installationId));
  await denied(store.complete(a.hostToken, a.installationId, { requestId: task.requestId, outcome: "completed" }));
});

test("durable UUID enqueue is idempotent only for the same host and payload", async () => {
  const a = await fixture(),
    b = await fixture(),
    task = job();
  await store.enqueue(a.actor, a.hostId, task);
  // Reopen the service to prove identity is durable rather than an in-memory cache.
  await createDockerHostStore(sql, key).enqueue(a.actor, a.hostId, task);
  await denied(store.enqueue(a.actor, a.hostId, { ...task, operation: "delete" }));
  await denied(store.enqueue(a.actor, a.hostId, { ...task, request: { ...task.request, ttlSeconds: 301 } }));
  await denied(store.enqueue(b.actor, b.hostId, task));
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(task);
  expect(await store.poll(b.hostToken, b.installationId)).toBeNull();
});

test("poll redelivers oldest unfinished job; terminal ACKs are isolated and immutable", async () => {
  const a = await fixture(),
    b = await fixture(),
    first = job(),
    second = { ...job(), operation: "stop" as const };
  await store.enqueue(a.actor, a.hostId, first);
  await store.enqueue(a.actor, a.hostId, second);
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(first);
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(first);
  await denied(store.complete(b.hostToken, b.installationId, { requestId: first.requestId, outcome: "completed" }));
  await store.complete(a.hostToken, a.installationId, { requestId: first.requestId, outcome: "completed" });
  await store.complete(a.hostToken, a.installationId, { requestId: first.requestId, outcome: "completed" });
  await denied(store.complete(a.hostToken, a.installationId, { requestId: first.requestId, outcome: "failed" }));
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(second);
  await store.complete(a.hostToken, a.installationId, { requestId: second.requestId, outcome: "failed" });
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  const seen = await db.query<{ last_seen_at: unknown }>(`select last_seen_at from public.docker_hosts where id=$1`, [
    a.hostId,
  ]);
  expect(seen.rows[0]?.last_seen_at).not.toBeNull();
});

test("SQL persists only token hashes and sealed input and denies user-JWT table/sequence access", async () => {
  const a = await fixture(),
    task = job();
  await store.enqueue(a.actor, a.hostId, task);
  const host = await db.query<{ hash: string; registration_hash: string | null }>(
    `select hash,registration_hash from public.docker_hosts where id=$1`,
    [a.hostId],
  );
  expect(host.rows[0]?.hash).toBe(createHash("sha256").update(a.hostToken).digest("hex"));
  expect(host.rows[0]?.registration_hash).toBeNull();
  const sealed = await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
    `select input_enc from public.docker_host_jobs where request_id=$1`,
    [task.requestId],
  );
  const bytes = sealed.rows[0]?.input_enc;
  if (!bytes) throw new Error("Missing sealed job");
  expect(Buffer.from(bytes).includes(Buffer.from(task.request.image))).toBe(false);
  expect(JSON.parse(await decryptSecret(bytes, key))).toEqual({ operation: task.operation, request: task.request });
  for (const role of ["anon", "authenticated"]) {
    await db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      for (const relation of ["docker_hosts", "docker_host_jobs"]) {
        const grants = await tx.query<{ allowed: boolean }>(
          `select has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as allowed`,
          [`public.${relation}`],
        );
        expect(grants.rows[0]?.allowed).toBe(false);
        const columns = await tx.query<{ allowed: boolean }>(
          `select has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') as allowed`,
          [`public.${relation}`],
        );
        expect(columns.rows[0]?.allowed).toBe(false);
      }
      const sequence = await tx.query<{ allowed: boolean }>(
        `select has_sequence_privilege(current_user,'public.docker_host_jobs_position_seq','USAGE,SELECT,UPDATE') as allowed`,
      );
      expect(sequence.rows[0]?.allowed).toBe(false);
    });
  }
});

test("bootstrap tickets are sealed, strictly admitted, immutable and redelivered until terminal acknowledgement", async () => {
  const a = await fixture();
  const task = {
    ...job(),
    operation: "bootstrap" as const,
    bootstrap: {
      serverUrl: "https://armada.example/",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: `armada_enrol_${"c".repeat(64)}`,
    },
  };
  await store.enqueue(a.actor, a.hostId, task);
  await createDockerHostStore(sql, key).enqueue(a.actor, a.hostId, task);
  const normalized = { ...task, bootstrap: { ...task.bootstrap, serverUrl: "https://armada.example" } };
  await store.enqueue(a.actor, a.hostId, normalized);
  const row = await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
    `select input_enc from public.docker_host_jobs where request_id=$1`,
    [task.requestId],
  );
  const bytes = row.rows[0]?.input_enc;
  if (!bytes) throw new Error("Missing sealed bootstrap");
  expect(Buffer.from(bytes).includes(Buffer.from(task.bootstrap.enrolmentToken))).toBe(false);
  expect(JSON.parse(await decryptSecret(bytes, key))).toEqual({
    operation: "bootstrap",
    request: task.request,
    bootstrap: normalized.bootstrap,
  });
  await denied(
    store.enqueue(a.actor, a.hostId, {
      ...task,
      bootstrap: { ...task.bootstrap, enrolmentToken: `armada_enrol_${"d".repeat(64)}` },
    }),
  );
  for (const bootstrap of [
    { ...task.bootstrap, serverUrl: "http://armada.example" },
    { ...task.bootstrap, serverUrl: "https://user:pass@armada.example" },
    { ...task.bootstrap, serverUrl: "https://armada.example/path" },
    { ...task.bootstrap, serverUrl: "https://armada.example/?query=1" },
    { ...task.bootstrap, serverUrl: "https://armada.example/#fragment" },
    { ...task.bootstrap, enrolmentToken: "armada_enrol_invalid" },
    { ...task.bootstrap, artifact: { ...task.bootstrap.artifact, bytes: 0 } },
    { ...task.bootstrap, artifact: { ...task.bootstrap.artifact, bytes: 512 * 1024 * 1024 + 1 } },
    { ...task.bootstrap, artifact: { ...task.bootstrap.artifact, sha256: "invalid" } },
    { ...task.bootstrap, harness: "codex" },
  ])
    await denied(store.enqueue(a.actor, a.hostId, { ...task, requestId: randomUUID(), bootstrap } as never));
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(normalized);
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(normalized);
  const result = { requestId: task.requestId, outcome: "completed" as const };
  await store.complete(a.hostToken, a.installationId, result);
  await store.complete(a.hostToken, a.installationId, result);
  await denied(store.complete(a.hostToken, a.installationId, { ...result, outcome: "failed" }));
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
});

test("frozen machine expiry survives mailbox delivery and cannot change under an admitted request ID", async () => {
  const a = await fixture();
  const task = job();
  const absolute = { ...task, request: { ...task.request, expiresAt: 1_700_000_000_000 } };
  await store.enqueue(a.actor, a.hostId, absolute);
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(absolute);
  await denied(
    store.enqueue(a.actor, a.hostId, {
      ...absolute,
      request: { ...absolute.request, expiresAt: absolute.request.expiresAt + 1 },
    }),
  );
  for (const expiresAt of [null, undefined, "1700000000000", 0, -1, 1.5, NaN, Infinity, 8_640_000_000_000_001]) {
    await denied(
      store.enqueue(a.actor, a.hostId, {
        ...task,
        requestId: randomUUID(),
        request: { ...task.request, expiresAt },
      } as never),
    );
  }
  // Unbounded legacy jobs retain their exact persisted identity/bytes.
  const legacy = job();
  await store.enqueue(a.actor, a.hostId, legacy);
  const row = await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
    "select input_enc from docker_host_jobs where request_id=$1",
    [legacy.requestId],
  );
  const stored = row.rows[0];
  if (!stored) throw new Error("Missing stored legacy job");
  expect(await decryptSecret(stored.input_enc, key)).toBe(
    JSON.stringify({
      operation: legacy.operation,
      request: legacy.request,
    }),
  );
});

async function boundFixture() {
  const host = await fixture();
  const sandboxId = randomUUID(),
    generation = randomUUID();
  await db.query(
    `insert into public.sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
      docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at,effective_ttl_seconds)
     values($1,$2,$3,'docker',$4,'codex','starting',$5,$6,$7,$8,now()+interval '1 hour',3600)`,
    [
      sandboxId,
      host.actor.orgId,
      host.memberId,
      `armada-${host.installationId}-${host.hostId}-${sandboxId}-${generation}`,
      host.hostId,
      host.installationId,
      generation,
      `example/worker@sha256:${"a".repeat(64)}`,
    ],
  );
  const owner = { ...host.actor, userId: host.memberId };
  const create = { requestId: randomUUID(), operation: "create" as const };
  return { ...host, sandboxId, generation, owner, create };
}

// The migrated SQL boundary owns binding, actor fencing, lifecycle intent and capabilities.
test("bound member admission derives immutable machine fields and cannot redirect or adopt mailbox IDs", async () => {
  const a = await boundFixture(),
    b = await boundFixture();
  await denied(store.enqueueSandbox(a.actor, a.sandboxId, a.create)); // admin is not the private owner
  await denied(store.enqueueSandbox(b.owner, a.sandboxId, b.create));
  await denied(store.enqueueSandbox(a.owner, randomUUID(), a.create));
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, { ...a.create, request: job().request } as never));
  await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
  await createDockerHostStore(sql, key).enqueueSandbox(a.owner, a.sandboxId, a.create);
  const delivered = await store.poll(a.hostToken, a.installationId);
  expect(delivered).toEqual({
    ...a.create,
    request: {
      sandboxId: a.sandboxId,
      generation: a.generation,
      image: `example/worker@sha256:${"a".repeat(64)}`,
      ttlSeconds: 3600,
      expiresAt: expect.any(Number),
    },
  });
  const metadata = (
    await db.query<{ bound_actor_id: string; bound_operation: string; bound_actor_epoch: string }>(
      `select bound_actor_id,bound_operation,bound_actor_epoch::text from docker_host_jobs where request_id=$1`,
      [a.create.requestId],
    )
  ).rows[0];
  expect(metadata).toEqual({ bound_actor_id: a.owner.userId, bound_operation: "create", bound_actor_epoch: "1" });
  if (!delivered) throw Error("missing bound job");
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, { ...a.create, requestId: randomUUID() }));
  await db.query(`update sandboxes set status='ready',expires_at=now()+interval '2 hours' where id=$1`, [a.sandboxId]);
  await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
  const sealed = (
    await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
      `select input_enc from docker_host_jobs where request_id=$1`,
      [a.create.requestId],
    )
  ).rows[0];
  if (!sealed) throw Error("missing sealed bound job");
  const envelope = JSON.parse(await decryptSecret(sealed.input_enc, key));
  expect(envelope).toEqual({ bound: 1, job: { operation: delivered.operation, request: delivered.request } });
  // Pre-bound servers feed this plaintext to the strict parser and must reject it.
  const { parseDockerHostJob } = await import("../../core/src/docker-host-job.ts");
  expect(() => parseDockerHostJob({ ...envelope, requestId: a.create.requestId })).toThrow("Invalid host job");
  expect(Object.keys(delivered).sort()).toEqual(["operation", "request", "requestId"]);
  await denied(store.enqueue(a.actor, a.hostId, delivered));
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, { ...a.create, requestId: randomUUID() }));
});

test("poll retires stale actor grants without starving authorized cleanup; ACK remains a machine fact", async () => {
  for (const change of ["demotion", "removal", "rejoin"] as const) {
    const a = await boundFixture();
    await db.query(`update members set role='admin' where org_id=$1 and user_id=$2`, [a.owner.orgId, a.owner.userId]);
    await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
    await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
    const stale = { requestId: randomUUID(), operation: "stop" as const };
    await store.enqueueSandbox(a.owner, a.sandboxId, stale);
    if (change === "demotion")
      await db.query(`update members set role='member' where org_id=$1 and user_id=$2`, [
        a.owner.orgId,
        a.owner.userId,
      ]);
    else {
      await db.query(`delete from members where org_id=$1 and user_id=$2`, [a.owner.orgId, a.owner.userId]);
      if (change === "rejoin")
        await db.query(`insert into members(org_id,user_id,role) values($1,$2,'admin')`, [
          a.owner.orgId,
          a.owner.userId,
        ]);
    }
    const stop = { requestId: randomUUID(), operation: "stop" as const };
    await store.enqueueSandbox(a.actor, a.sandboxId, stop);
    // Both STOPs are logically valid. Only the stale actor grant retires the head.
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
    expect(
      (
        await db.query<{ outcome: string }>(`select outcome from docker_host_jobs where request_id=$1`, [
          stale.requestId,
        ])
      ).rows[0]?.outcome,
    ).toBe("failed");
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(stop.requestId);
    await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "completed" });
  }

  const b = await boundFixture();
  await store.enqueueSandbox(b.owner, b.sandboxId, b.create);
  expect((await store.poll(b.hostToken, b.installationId))?.requestId).toBe(b.create.requestId);
  await db.query(`delete from members where org_id=$1 and user_id=$2`, [b.owner.orgId, b.owner.userId]);
  await store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "completed" });
  await store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "completed" });
  await denied(store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "failed" }));
  expect(
    (await db.query<{ status: string }>(`select status from sandboxes where id=$1`, [b.sandboxId])).rows[0]?.status,
  ).toBe("starting");
});

test("bound bootstrap requires ACKed creation and the exact pending capability, then redelivers after enrolment", async () => {
  const a = await boundFixture(),
    b = await boundFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  const issue = (f: typeof a) =>
    authority.issue({ sandboxId: f.sandboxId, ownerId: f.owner.userId, configuration: { marker: "private" } });
  const ticket = await issue(a),
    other = await issue(b);
  const selection = {
    requestId: randomUUID(),
    operation: "bootstrap" as const,
    bootstrapDescriptor: {
      serverUrl: "https://armada.example",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: ticket.enrolmentToken,
    },
  };
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, selection));
  await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, selection));
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  await denied(
    store.enqueueSandbox(a.owner, a.sandboxId, {
      ...selection,
      bootstrapDescriptor: { ...selection.bootstrapDescriptor, enrolmentToken: other.enrolmentToken },
    }),
  );
  await store.enqueueSandbox(a.owner, a.sandboxId, selection);
  const first = await store.poll(a.hostToken, a.installationId);
  expect(first?.operation).toBe("bootstrap");
  await authority.enrol(ticket.enrolmentToken);
  await store.enqueueSandbox(a.owner, a.sandboxId, selection);
  await denied(
    store.enqueueSandbox(a.owner, a.sandboxId, {
      ...selection,
      bootstrapDescriptor: {
        ...selection.bootstrapDescriptor,
        artifact: { ...selection.bootstrapDescriptor.artifact, bytes: 124 },
      },
    }),
  );
  expect(await store.poll(a.hostToken, a.installationId)).toEqual(first);
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, { ...selection, requestId: randomUUID() }));
});

test("stop commits runtime revocation once; cleanup retains the create deadline and ACKs only terminal transitions", async () => {
  const a = await boundFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
  const initial = await store.poll(a.hostToken, a.installationId);
  if (!initial) throw Error("missing create");
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  const ticket = await authority.issue({ sandboxId: a.sandboxId, ownerId: a.owner.userId, configuration: {} });
  const runtime = await authority.enrol(ticket.enrolmentToken);
  const stop = { requestId: randomUUID(), operation: "stop" as const };
  await store.enqueueSandbox(a.actor, a.sandboxId, stop);
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, stop));
  await store.enqueueSandbox(a.actor, a.sandboxId, stop);
  await store.enqueueSandbox(a.actor, a.sandboxId, { ...stop, requestId: randomUUID() });
  await expect(authority.withSession(runtime.runtimeToken, runtime.epoch, async () => true)).rejects.toThrow(
    "runtime_enrolment_denied",
  );
  const intent = (
    await db.query<{ status: string; lifecycle_generation: string; stop_requested_at: unknown }>(
      `select status,lifecycle_generation::text,stop_requested_at from sandboxes where id=$1`,
      [a.sandboxId],
    )
  ).rows[0];
  expect(intent?.status).toBe("stopping");
  expect(intent?.lifecycle_generation).toBe("2");
  expect(intent?.stop_requested_at).not.toBeNull();
  expect(
    (
      await db.query<{ runtime_hash: string | null }>(
        `select runtime_hash from runtime_enrolments where sandbox_id=$1`,
        [a.sandboxId],
      )
    ).rows[0]?.runtime_hash,
  ).toBeNull();
  await db.query(`update sandboxes set expires_at=now()-interval '1 second' where id=$1`, [a.sandboxId]);
  expect((await store.poll(a.hostToken, a.installationId))?.request).toEqual(initial.request);
  await denied(store.enqueueSandbox(a.actor, a.sandboxId, { requestId: randomUUID(), operation: "delete" }));
  // Recover an ACK already committed by an older server without its logical transition.
  await db.query(`update docker_host_jobs set outcome='completed',completed_at=now() where request_id=$1`, [
    stop.requestId,
  ]);
  await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "completed" });
  expect(
    (await db.query<{ status: string }>(`select status from sandboxes where id=$1`, [a.sandboxId])).rows[0]?.status,
  ).toBe("stopped");
  const followup = await store.poll(a.hostToken, a.installationId);
  if (!followup) throw Error("missing stop");
  await store.complete(a.hostToken, a.installationId, { requestId: followup.requestId, outcome: "completed" });
  const remove = { requestId: randomUUID(), operation: "delete" as const };
  await store.enqueueSandbox(a.actor, a.sandboxId, remove);
  expect((await store.poll(a.hostToken, a.installationId))?.request).toEqual(initial.request);
  await db.query(`update docker_host_jobs set outcome='completed',completed_at=now() where request_id=$1`, [
    remove.requestId,
  ]);
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
  const terminal = (
    await db.query<{ status: string; stopped_at: unknown; deleted_at: unknown }>(
      `select status,stopped_at,deleted_at from sandboxes where id=$1`,
      [a.sandboxId],
    )
  ).rows[0];
  expect(terminal?.status).toBe("deleted");
  expect(terminal?.stopped_at).not.toBeNull();
  expect(terminal?.deleted_at).not.toBeNull();
  await store.enqueueSandbox(a.owner, a.sandboxId, a.create);
  await denied(store.enqueueSandbox(a.owner, a.sandboxId, { ...a.create, requestId: randomUUID() }));
  expect(
    (await db.query<{ status: string }>(`select status from sandboxes where id=$1`, [a.sandboxId])).rows[0]?.status,
  ).toBe("deleted");
});
