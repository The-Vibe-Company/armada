import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  DOCKER_HOST_PROTOCOL,
  DOCKER_HOST_PROTOCOL_HEADER,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  type Sql,
} from "@armada/core";
import { decryptSecret, encryptSecret, OutputCollectionError } from "@armada/core/server";
import { canonicalDockerHostJob, type DockerHostJob } from "../../core/src/docker-host-job.ts";
import type { DockerHostPollResponse } from "../../core/src/docker-host-wire.ts";
import { DockerMachineError } from "../../core/src/docker-machine.ts";
import { type Api, type Executor, type State, type Store, tick } from "../../docker-host/src/daemon.ts";
import { createTurnDispatchJob } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { admitDockerDisk, DockerHostDraining } from "../src/docker-capacity.ts";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore, DockerHostDenied } from "../src/docker-host-store.ts";
import { createDockerMachineGenerationBindings } from "../src/docker-machine-bindings.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { SNAPSHOT_COLUMNS } from "../src/docker-snapshot-data.ts";
import { createResumeJob } from "../src/jobs/resume.ts";
import type { Job, JobKind } from "../src/jobs/runner.ts";
import { createStopJob } from "../src/jobs/stop.ts";
import { createJobsStore, JOBS_WAKE, recordResumeAuthority } from "../src/jobs/store.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createSandboxAccessServices } from "../src/sandbox-access-services.ts";
import { createFinishedDockerCleanup, requestSandboxFinish, selfFinishToken } from "../src/sandbox-finish.ts";
import { createSandboxOutputs, OUTPUTS_CAPTURE } from "../src/sandbox-outputs.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE } from "../src/wake-bus.ts";
import { queueMailboxStop, reportDockerExpiry, runDockerStop } from "./docker-stop.fixture.ts";
import { useMigratedDatabase } from "./migrated-database.ts";
import { publishedResponse } from "./published-response.ts";

const database = useMigratedDatabase();
const sql: Sql = {
  query: (query, params) => database().query(query, params),
  transaction: (work) => database().transaction((tx) => work({ query: (query, params) => tx.query(query, params) })),
};
const key = Buffer.alloc(32, 7).toString("base64");
const store = createDockerHostStore(sql, key);
async function fixture() {
  const db = database();
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
  return { actor, memberId, backupAdmin, ticket, installationId, ...host };
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
// Model already-persisted daemon work that predates sandbox bindings.
async function seedUnboundJob(hostId: string, job: DockerHostJob) {
  await sql.query("insert into public.docker_host_jobs(request_id,host_id,input_enc) values($1,$2,$3)", [
    job.requestId,
    hostId,
    await encryptSecret(canonicalDockerHostJob(job), key),
  ]);
}
async function denied(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(DockerHostDenied);
  await expect(work).rejects.toThrow("Docker host denied");
}

// Each case owns an independent security/durability contract at the actual SQL boundary.
test("current admin admission rejects members, cross-org access, and malformed requests", async () => {
  const db = database();
  const a = await fixture(),
    b = await fixture();
  await denied(store.issueRegistration({ ...a.actor, userId: a.memberId }));
  await denied(store.revoke(b.actor, a.hostId));
  await denied(store.poll("malformed", a.installationId));
  await denied(store.complete(a.hostToken, a.installationId, { requestId: "invalid", outcome: "failed" }));
  await db.query(`update public.members set role='member' where org_id=$1 and user_id=$2`, [
    a.actor.orgId,
    a.actor.userId,
  ]);
  await denied(store.revoke(a.actor, a.hostId));
});

test("registration is single-use, expires, and rechecks the issuing admin", async () => {
  const db = database();
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

test("registration reuse cancels only a fresh same-owner/org ticket and preserves existing machine authority", async () => {
  const db = database();
  const a = await fixture(),
    b = await fixture();
  await db.query(`update docker_hosts set name='existing office',last_seen_at=now()-interval '1 day' where id=$1`, [
    a.hostId,
  ]);
  const sameOrgTicket = await store.issueRegistration({ ...a.actor, userId: a.backupAdmin });
  const sameOrgOther = await store.exchangeRegistration(sameOrgTicket.registrationToken, randomUUID());
  const fresh = await store.issueRegistration(a.actor, "unused new name");
  const expired = await store.issueRegistration(a.actor);
  await db.query(`update docker_hosts set registration_expires_at=now()-interval '1 second' where id=$1`, [
    expired.hostId,
  ]);
  const revoked = await store.issueRegistration(a.actor);
  await store.revoke(a.actor, revoked.hostId);
  const revokedTargetTicket = await store.issueRegistration(a.actor);
  const revokedTarget = await store.exchangeRegistration(revokedTargetTicket.registrationToken, randomUUID());
  await store.revoke(a.actor, revokedTarget.hostId);
  for (const [token, hostId] of [
    [fresh.registrationToken, b.hostId],
    [fresh.registrationToken, sameOrgOther.hostId],
    [fresh.registrationToken, fresh.hostId],
    [fresh.registrationToken, revokedTarget.hostId],
    [fresh.registrationToken, randomUUID()],
    [fresh.registrationToken, "malformed"],
    ["malformed", a.hostId],
    [expired.registrationToken, a.hostId],
    [revoked.registrationToken, a.hostId],
    [a.ticket.registrationToken, a.hostId],
    [a.hostToken, a.hostId],
  ] as const)
    await denied(store.reuseRegistration(token, hostId));
  await db.query(`update members set role='member' where org_id=$1 and user_id=$2`, [a.actor.orgId, a.actor.userId]);
  await denied(store.reuseRegistration(fresh.registrationToken, a.hostId));
  await db.query(`update members set role='admin' where org_id=$1 and user_id=$2`, [a.actor.orgId, a.actor.userId]);
  const before = await db.query(`select * from docker_hosts where id=$1`, [a.hostId]);
  expect(await store.reuseRegistration(fresh.registrationToken, a.hostId)).toEqual({
    hostId: a.hostId,
    name: "existing office",
  });
  expect((await db.query(`select * from docker_hosts where id=$1`, [a.hostId])).rows).toEqual(before.rows);
  const canceled = await db.query<{ registration_hash: string | null; expired: boolean }>(
    `select registration_hash,registration_expires_at<=now() as expired from docker_hosts where id=$1`,
    [fresh.hostId],
  );
  expect(canceled.rows[0]).toEqual({ registration_hash: null, expired: true });
  await denied(store.exchangeRegistration(fresh.registrationToken, randomUUID()));
  await denied(store.reuseRegistration(fresh.registrationToken, a.hostId));
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  expect((await store.list(a.actor)).some((host) => host.id === fresh.hostId)).toBe(false);
});

test("host credentials bind installation, owner membership, and revocation", async () => {
  const db = database();
  const a = await fixture();
  const task = job();
  await seedUnboundJob(a.hostId, task);
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

test("poll redelivers oldest unfinished job; terminal ACKs are isolated and immutable", async () => {
  const db = database();
  const a = await fixture(),
    b = await fixture(),
    first = job(),
    second = { ...job(), operation: "stop" as const };
  await seedUnboundJob(a.hostId, first);
  await seedUnboundJob(a.hostId, second);
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

test("SQL persists only token hashes and denies user-JWT table/sequence access", async () => {
  const db = database();
  const a = await fixture();
  const host = await db.query<{ hash: string; registration_hash: string | null }>(
    `select hash,registration_hash from public.docker_hosts where id=$1`,
    [a.hostId],
  );
  expect(host.rows[0]?.hash).toBe(createHash("sha256").update(a.hostToken).digest("hex"));
  expect(host.rows[0]?.registration_hash).toBeNull();
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

async function boundFixture(
  registered?: Awaited<ReturnType<typeof fixture>>,
  placement?: { sandboxId: string; generation: string; expiresAt: number; image?: string; snapshotId?: string },
) {
  const db = database();
  const host = registered ?? (await fixture());
  const sandboxId = placement?.sandboxId ?? randomUUID();
  const generation =
    placement?.generation ??
    (await createDockerMachineGenerationBindings(sql, host).bind({ sandboxId, generation: 1 }));
  await db.query(
    `insert into public.sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
      docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at,effective_ttl_seconds,docker_snapshot_id)
     values($1,$2,$3,'docker',$4,'codex','starting',$5,$6,$7,$8,coalesce($9::timestamptz,now()+interval '1 hour'),3600,$10)`,
    [
      sandboxId,
      host.actor.orgId,
      host.memberId,
      `armada-${host.installationId}-${host.hostId}-${sandboxId}-${generation}`,
      host.hostId,
      host.installationId,
      generation,
      placement?.image ?? job().request.image,
      placement ? new Date(placement.expiresAt) : null,
      placement?.snapshotId ?? null,
    ],
  );
  const owner = { ...host.actor, userId: host.memberId };
  const create = { requestId: generation, operation: "create" as const };
  const request = {
    sandboxId,
    generation: 1,
    source: placement?.snapshotId
      ? { kind: "snapshot" as const, ref: placement.snapshotId }
      : { kind: "image" as const, ref: placement?.image ?? job().request.image },
    computeTtlSeconds: 3600,
    size: null,
  };
  return { ...host, sandboxId, generation, owner, create, request };
}

async function machineCreateFixture(
  registered?: Awaited<ReturnType<typeof fixture>>,
  image = job().request.image,
  snapshotId?: string,
) {
  const host = registered ?? (await fixture());
  const sandboxId = randomUUID();
  const bindings = createDockerMachineGenerationBindings(sql, host);
  const generation = await bindings.bind({ sandboxId, generation: 1 });
  const a = await boundFixture(host, {
    sandboxId,
    generation,
    expiresAt: Date.UTC(2099, 0, 1),
    image,
    ...(snapshotId === undefined ? {} : { snapshotId }),
  });
  const request = {
    sandboxId,
    generation: 1,
    source: { kind: "image" as const, ref: image },
    computeTtlSeconds: 3600,
    size: null,
  };
  return { ...a, request };
}

test("Docker stop refuses insufficient headroom before admitting a job", async () => {
  const { owner, sandboxId } = await machineCreateFixture();
  await sql.query("update public.sandboxes set lifecycle_generation=$2::bigint where id=$1", [
    sandboxId,
    String(Number.MAX_SAFE_INTEGER - 1),
  ]);
  await expect(store.enqueueStop(owner, sandboxId, randomUUID())).rejects.toMatchObject({
    name: "DockerHostUnavailable",
    cause: { message: "Sandbox lifecycle generation cannot be advanced safely." },
  });
  expect((await sql.query("select id from public.jobs where sandbox_id=$1 and kind='stop'", [sandboxId])).rows).toEqual(
    [],
  );
});

test("admitted Docker stop prevents a leased launch from dispatching new compute", async () => {
  const allocation = await machineCreateFixture();
  const jobs = createJobsStore(sql, key);
  const worker = randomUUID();
  const request = { ownerId: allocation.owner.userId, digest: "fixture" };
  await jobs.enqueue(
    "launch",
    allocation.sandboxId,
    1,
    randomUUID(),
    {},
    {
      orgId: allocation.owner.orgId,
      deadline: new Date(Date.UTC(2099, 0, 1)),
      maxAttempts: 2,
      request,
    },
  );
  const launch = (await jobs.claim("launch", worker, 30, 1))!;
  expect(await jobs.inspect(launch, worker)).toBe("dispatch");
  try {
    expect(await store.enqueueStop(allocation.owner, allocation.sandboxId, randomUUID())).toBeString();
    expect(await jobs.inspect(launch, worker)).toBe("reconcile");
    expect(await jobs.claim("stop", randomUUID(), 30, 1)).toBeUndefined();
  } finally {
    await sql.query("delete from jobs where sandbox_id=$1", [allocation.sandboxId]);
  }
});

test("an admitted stop refuses fresh Machine create before anything reaches the mailbox", async () => {
  const a = await machineCreateFixture();
  try {
    await store.enqueueStop(a.owner, a.sandboxId, randomUUID());
    await denied(store.submitMachineCreate(a.owner, a.request));
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  } finally {
    await sql.query("delete from jobs where sandbox_id=$1", [a.sandboxId]);
  }
});

test("Machine create replays one intent and recovers the authenticated container ID", async () => {
  const a = await machineCreateFixture();
  const create = () => store.submitMachineCreate(a.owner, a.request);
  await denied(store.submitMachineCreate(a.owner, { ...a.request, computeTtlSeconds: 300 }));
  const { faultingStore, failure } = failDockerJobCommit(a.generation, null);
  await expect(faultingStore.submitMachineCreate(a.owner, a.request)).rejects.toMatchObject({ cause: failure });
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  expect(await create()).toEqual({ kind: "pending" });
  expect(await create()).toEqual({ kind: "pending" });

  const delivered = await store.poll(a.hostToken, a.installationId);
  expect(delivered).toMatchObject({
    operation: "create",
    requestId: a.generation,
    request: { sandboxId: a.sandboxId, generation: a.generation, ttlSeconds: 3600 },
  });
  const machineId = "d".repeat(64);
  await store.complete(a.hostToken, a.installationId, {
    requestId: a.generation,
    outcome: "completed",
    machineId,
  });
  expect(await create()).toEqual({
    kind: "completed",
    machine: { sandboxId: a.sandboxId, generation: 1, machineId },
  });
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
});

async function machineStopFixture() {
  const a = await machineCreateFixture();
  await store.submitMachineCreate(a.owner, a.request);
  const machineId = "d".repeat(64);
  await store.complete(a.hostToken, a.installationId, {
    requestId: a.generation,
    outcome: "completed",
    machineId,
  });
  return { ...a, machine: { sandboxId: a.sandboxId, generation: a.request.generation, machineId } };
}

test("a fresh Docker Machine recovers allocation and confirms exact physical deletion from mailbox receipts", async () => {
  const a = await machineStopFixture();
  const adapter = () => store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  await store.poll(a.hostToken, a.installationId);
  expect(await adapter().observe(a.request)).toMatchObject({ kind: "present", machine: a.machine });
  expect(await adapter().create(a.request)).toEqual(a.machine);
  const removal = { ...a.machine, scope: "physical-only" as const };
  await denied(adapter().delete({ ...removal, machineId: "e".repeat(64) }));
  await expect(adapter().delete(removal)).rejects.toThrow("outcome is pending");
  const options = [undefined, false, undefined, undefined, null, null, [], null, true] as const;
  const delivery = await store.poll(a.hostToken, a.installationId, ...options);
  expect(delivery).toMatchObject({ operation: "deletePhysical", machineId: a.machine.machineId });
  await store.complete(a.hostToken, a.installationId, { requestId: delivery!.requestId, outcome: "completed" });
  await adapter().delete(removal);
  expect(await adapter().observe(a.machine)).toMatchObject({ kind: "absent" });
});

async function machineBootstrapFixture() {
  const a = await machineStopFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  const ticket = await authority.issue({ sandboxId: a.sandboxId, ownerId: a.owner.userId, configuration: {} });
  const adapter = store.machine({
    actor: a.owner,
    hostId: a.hostId,
    installationId: a.installationId,
    bootstrapDescriptor: {
      serverUrl: "https://armada.example",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: ticket.enrolmentToken,
    },
  });
  const bootstrap = { ...a.machine, bindingRef: createHash("sha256").update(ticket.enrolmentToken).digest("hex") };
  await expect(adapter.bootstrap(bootstrap)).rejects.toThrow("outcome is pending");
  return { ...a, adapter, bootstrap, enrol: () => authority.enrol(ticket.enrolmentToken) };
}

test("Docker stop takeover reuses the final snapshot and settles from the retained host receipt", async () => {
  const a = await machineBootstrapFixture();
  const boot = await store.poll(
    a.hostToken,
    a.installationId,
    undefined,
    false,
    undefined,
    undefined,
    null,
    null,
    [],
    null,
    false,
    false,
    false,
    true,
  );
  const session = await a.enrol();
  await store.complete(a.hostToken, a.installationId, { requestId: boot!.requestId, outcome: "completed" });
  const checkpoint = randomUUID();
  await sql.query(
    `insert into public.runtime_checkpoints(sandbox_id,epoch,request_id,watermark,completed_at)
     values($1,$2,$3,0,now())`,
    [a.sandboxId, session.epoch, checkpoint],
  );
  await store.enqueueStop(a.owner, a.sandboxId, checkpoint, { checkpoint });
  const jobs = createJobsStore(sql, key);
  let captures = 0;
  const reader = () => ({
    async listOutputEntries() {
      captures++;
      return [{ name: "last.txt", size: 1, revision: "1:2:3:4" }];
    },
    readOutputChunk: async () => new Uint8Array([42]),
  });
  const firstOwner = randomUUID();
  const first = (await jobs.claim("stop", firstOwner, 30, 1))!;
  const signal = new AbortController().signal;
  await expect(
    createStopJob(sql, key, reader).run(first, {
      signal,
      canDispatch: async (tx) => (await jobs.inspect(first, firstOwner, tx)) === "dispatch",
      async handoffGeneration() {
        throw new Error("interrupted after capture");
      },
    }),
  ).rejects.toThrow("interrupted after capture");
  const outputNames = () => sql.query("select name from sandbox_outputs where sandbox_id=$1", [a.sandboxId]);
  await sql.query("update public.jobs set lease_until=now()-interval '1 second' where id=$1", [first.id]);
  const owner = randomUUID();
  const job = (await jobs.claim("stop", owner, 30, 1))!;
  const handler = createStopJob(sql, key, reader);
  const context = {
    signal,
    canDispatch: async (tx?: Sql) => (await jobs.inspect(job, owner, tx)) === "dispatch",
    handoffGeneration: (handoff: Parameters<typeof jobs.handoffGeneration>[2]) =>
      jobs.handoffGeneration(job, owner, handoff),
  };
  expect(await handler.run(job, context)).toMatchObject({ status: "retry" });
  expect(captures).toBe(1);
  const stop = await store.poll(a.hostToken, a.installationId);
  await store.complete(a.hostToken, a.installationId, {
    requestId: stop!.requestId,
    outcome: "completed",
    machineId: a.machine.machineId,
  });
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "stopping" });
  await sql.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [
    a.owner.orgId,
    a.owner.userId,
  ]);
  let clock = 0;
  const controls = createDockerSandboxControls(sql, key, {
    timeoutMs: 1_000,
    clock: {
      now: () => clock,
      async wait(ms) {
        if (clock === 0) expect(await jobs.complete(job, owner, await handler.run(job, context))).toBe(true);
        clock += ms;
      },
    },
  });
  expect(
    await controls.invoke({ ...a.owner, via: "service", orgs: [{ orgId: a.owner.orgId, role: "admin" }] }, "stop", {
      id: a.sandboxId,
    }),
  ).toMatchObject({ handled: true, result: { status: "stopped" } });
  expect((await outputNames()).rows).toEqual([]);
  await sql.query(
    `select public.sandbox_transition(id,lifecycle_generation,array['stopped']::public.sandbox_status[],
      'starting','resume_admission','docker_resume_admitted','[]'::jsonb) from sandboxes where id=$1`,
    [a.sandboxId],
  );
  const publish = (await jobs.claim(OUTPUTS_CAPTURE, owner, 30, 1))!;
  const outputs = createSandboxOutputs(sql, key, async () => {
    throw new Error("unexpected provider read");
  });
  const result = await outputs.captureJob.run(publish, {
    signal,
    canDispatch: async () => (await jobs.inspect(publish, owner)) === "dispatch",
  });
  expect(await jobs.complete(publish, owner, result)).toBe(true);
  const chunks = await sql.query(
    "select o.name from sandbox_output_chunks c join sandbox_outputs o on o.transfer_id=c.transfer_id where o.sandbox_id=$1",
    [a.sandboxId],
  );
  expect(chunks.rows).toEqual([{ name: "last.txt" }]);
});

test.each(["exact absence", "legacy omission", "physical removal"] as const)(
  "Docker stop completion with %s",
  async (disposition) => {
    const provedAbsent = disposition === "exact absence";
    const a = await machineBootstrapFixture();
    const boot = await store.poll(
      a.hostToken,
      a.installationId,
      undefined,
      false,
      undefined,
      undefined,
      null,
      null,
      [],
      null,
      false,
      false,
      false,
      true,
    );
    const session = await a.enrol();
    await store.complete(a.hostToken, a.installationId, { requestId: boot!.requestId, outcome: "completed" });
    const checkpoint = randomUUID();
    await sql.query(
      `insert into public.runtime_checkpoints(sandbox_id,epoch,request_id,watermark,completed_at)
     values($1,$2,$3,0,now())`,
      [a.sandboxId, session.epoch, checkpoint],
    );
    await store.enqueueStop(a.owner, a.sandboxId, checkpoint, { checkpoint });
    const jobs = createJobsStore(sql, key);
    const owner = randomUUID();
    const job = (await jobs.claim("stop", owner, 30, 1))!;
    const handler = createStopJob(sql, key, () => ({
      async readOutputs() {
        throw new OutputCollectionError("output_limit");
      },
    }));
    const context = {
      signal: new AbortController().signal,
      canDispatch: async (tx?: Sql) => (await jobs.inspect(job, owner, tx)) === "dispatch",
      handoffGeneration: (handoff: Parameters<typeof jobs.handoffGeneration>[2]) =>
        jobs.handoffGeneration(job, owner, handoff),
    };
    expect(await handler.run(job, context)).toMatchObject({ status: "retry" });
    const stop = (await store.poll(a.hostToken, a.installationId))!;
    const route = createDockerHostRoutes(store, async () => ({ ok: false }));
    const report = (absentMachineId?: string) =>
      route(
        new Request("https://armada.example/api/docker-host/results", {
          method: "POST",
          headers: {
            authorization: `Bearer ${a.hostToken}`,
            [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          },
          body: JSON.stringify({
            installationId: a.installationId,
            requestId: stop.requestId,
            outcome: "completed",
            ...(absentMachineId ? { absentMachineId } : {}),
          }),
        }),
      );
    if (provedAbsent) expect((await report("f".repeat(64)))?.status).toBe(401);
    expect((await report(provedAbsent ? a.machine.machineId : undefined))?.status).toBe(200);
    if (disposition === "physical removal") {
      await expect(a.adapter.delete({ ...a.machine, scope: "physical-only" })).rejects.toThrow("outcome is pending");
      const removal = (await store.poll(
        a.hostToken,
        a.installationId,
        undefined,
        false,
        undefined,
        undefined,
        null,
        null,
        [],
        null,
        true,
      ))!;
      expect(removal.operation).toBe("deletePhysical");
      await store.complete(a.hostToken, a.installationId, { requestId: removal.requestId, outcome: "completed" });
    }
    const result = await handler.run(job, context);
    if (disposition === "physical removal")
      expect(result).toMatchObject({ status: "fail", reason: "stop_receipt_refused" });
    else expect(result.status).toBe(provedAbsent ? "done" : "retry");
    expect(await jobs.complete(job, owner, result)).toBe(true);
    expect(await lifecycle(a.sandboxId)).toMatchObject(
      provedAbsent
        ? {
            status: "failed",
            status_reason: "docker_stop_retention_lost",
            stopped_at: expect.anything(),
            stop_requested_at: null,
          }
        : { status: "stopping", stopped_at: null },
    );
    if (provedAbsent)
      expect(
        await createDockerSandboxControls(sql, key).invoke(
          { ...a.owner, via: "service", orgs: [{ orgId: a.owner.orgId, role: "admin" }] },
          "status",
          { id: a.sandboxId },
        ),
      ).toMatchObject({
        handled: true,
        result: {
          status: "failed",
          statusReason: "The Docker host confirmed the sandbox container is gone. This sandbox cannot resume.",
        },
      });
  },
);

test("only a daemon advertising Machine bootstrap replay receives a pending descriptor", async () => {
  const a = await machineBootstrapFixture();
  const route = createDockerHostRoutes(store, async () => {
    throw Error("Host poll used user auth");
  });
  const poll = async (capability: Record<string, string>) => {
    const response = await route(
      new Request("https://armada.example/api/docker-host/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.hostToken}`,
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          ...capability,
        },
        body: JSON.stringify({ installationId: a.installationId, version: "4.0.0" }),
      }),
    );
    expect(response?.status).toBe(200);
    const { job } = (await response!.json()) as DockerHostPollResponse;
    return job ? { operation: job.operation, generation: job.request.generation } : null;
  };
  expect(await store.mayHaveWork(a.hostToken, a.installationId, false, [], false)).toBe(false);
  expect(await poll({})).toBeNull();
  expect(await store.mayHaveWork(a.hostToken, a.installationId, false, [], false, false, true)).toBe(true);
  expect(await poll({ "x-armada-docker-host-machine-bootstrap": "1" })).toMatchObject({
    operation: "bootstrap",
    generation: a.generation,
  });
});

test("a replayed failed Machine bootstrap ACK preserves the enrolled runtime and reconciles bootstrap", async () => {
  const a = await machineBootstrapFixture();
  const requestId = (await store.poll(
    a.hostToken,
    a.installationId,
    undefined,
    false,
    undefined,
    undefined,
    null,
    null,
    [],
    null,
    false,
    false,
    false,
    true,
  ))!.requestId;
  await a.enrol();
  const enrolled = await lifecycle(a.sandboxId);
  expect(enrolled?.status).toBe("ready");
  const result = { requestId, outcome: "failed" as const };
  await store.complete(a.hostToken, a.installationId, result);
  await store.complete(a.hostToken, a.installationId, result);
  expect(await lifecycle(a.sandboxId)).toEqual(enrolled);
  await a.adapter.bootstrap(a.bootstrap);
  expect(await a.adapter.observe(a.machine)).toMatchObject({
    kind: "present",
    receipt: { operation: "bootstrap", bindingRef: a.bootstrap.bindingRef },
  });
});

test("Machine observation treats an expired allocation receipt as unknown even with a live host", async () => {
  const a = await machineStopFixture();
  await store.poll(a.hostToken, a.installationId);
  await database().query("update sandboxes set expires_at=now()-interval '1 second' where id=$1", [a.sandboxId]);
  const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  expect(await adapter.observe(a.machine)).toEqual({ kind: "unknown" });
});

test("the exact Machine allocation remains cleanup eligible after bootstrap failure advances the fence", async () => {
  const a = await machineBootstrapFixture();
  const startup = await store.poll(
    a.hostToken,
    a.installationId,
    undefined,
    false,
    undefined,
    undefined,
    null,
    null,
    [],
    null,
    false,
    false,
    false,
    true,
  );
  await store.complete(a.hostToken, a.installationId, { requestId: startup!.requestId, outcome: "failed" });
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "failed" });
  const removal = { ...a.machine, scope: "physical-and-retained" as const };
  await expect(a.adapter.delete(removal)).rejects.toThrow("outcome is pending");
  const cleanup = await store.poll(a.hostToken, a.installationId);
  expect(cleanup).toMatchObject({ operation: "delete", request: { generation: a.generation } });
  await store.complete(a.hostToken, a.installationId, { requestId: cleanup!.requestId, outcome: "completed" });
  await a.adapter.delete(removal);
});

test("Machine physical deletion can retry an uncertain result with a fresh durable intent", async () => {
  const a = await machineStopFixture();
  const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  const removal = { ...a.machine, scope: "physical-only" as const };
  const poll = () =>
    store.poll(a.hostToken, a.installationId, undefined, false, undefined, undefined, null, null, [], null, true);
  await expect(adapter.delete(removal)).rejects.toThrow("outcome is pending");
  const first = (await poll())!;
  await store.complete(a.hostToken, a.installationId, { requestId: first.requestId, outcome: "failed" });
  expect(await adapter.observe(a.machine)).toEqual({ kind: "unknown" });
  const { faultingStore, failure } = interruptDockerCommit(async (tx) => {
    const result = await tx.query(
      `select 1 from docker_host_jobs where bound_sandbox_id=$1 and bound_operation='deletePhysical' and outcome is null`,
      [a.sandboxId],
    );
    return result.rows.length > 0;
  });
  const faultingAdapter = faultingStore.machine({
    actor: a.owner,
    hostId: a.hostId,
    installationId: a.installationId,
  });
  await expect(faultingAdapter.delete(removal)).rejects.toMatchObject({ cause: failure });
  expect(await poll()).toBeNull();
  await expect(adapter.delete(removal)).rejects.toThrow("outcome is pending");
  const retry = (await poll())!;
  expect(retry).toMatchObject({ operation: "deletePhysical", machineId: a.machine.machineId });
  expect(retry.requestId).not.toBe(first.requestId);
  await expect(adapter.delete(removal)).rejects.toThrow("outcome is pending");
  expect(await poll()).toEqual(retry);
  await store.complete(a.hostToken, a.installationId, { requestId: retry.requestId, outcome: "completed" });
  await adapter.delete(removal);
  expect(await poll()).toBeNull();
});

test("host drain refuses new Machine physical deletion but allows full cleanup", async () => {
  const a = await machineStopFixture();
  const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  await database().query("update docker_hosts set draining_at=now() where id=$1", [a.hostId]);
  await expect(adapter.delete({ ...a.machine, scope: "physical-only" })).rejects.toBeInstanceOf(DockerHostDraining);
  await expect(adapter.delete({ ...a.machine, scope: "physical-and-retained" })).rejects.toThrow("outcome is pending");
});

test.each(["revocation", "physical removal", "failed physical removal"] as const)(
  "Machine stop recovers on takeover and fences %s",
  async (fence) => {
    const a = await machineStopFixture();
    const request = { ...a.machine, retain: true };
    await database().query("update sandboxes set status='stopping', lifecycle_generation=$2 where id=$1", [
      a.sandboxId,
      fence === "revocation" ? 2 : 1,
    ]);
    const first = store.machineCleanup(a.owner);
    await denied(first.stop({ ...request, generation: 2 }));
    await denied(first.stop({ ...request, machineId: "e".repeat(64) }));
    const interrupted = interruptDockerCommit(
      async (tx) =>
        (
          await tx.query("select 1 from docker_host_jobs where bound_sandbox_id=$1 and bound_operation='stop'", [
            a.sandboxId,
          ])
        ).rows.length > 0,
    );
    await expect(interrupted.faultingStore.machineCleanup(a.owner).stop(request)).rejects.toMatchObject({
      cause: interrupted.failure,
    });
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();

    await expect(first.stop(request)).rejects.toThrow("outcome is unknown");
    const pending = await store.poll(a.hostToken, a.installationId);
    expect(pending).toMatchObject({ operation: "stop", request: { sandboxId: a.sandboxId, generation: a.generation } });
    const requestId = pending!.requestId;
    const successor = createDockerHostStore(sql, key).machineCleanup(a.owner);
    expect(await successor.observe(a.machine)).toEqual({ kind: "unknown" });
    await expect(successor.stop(request)).rejects.toThrow("outcome is unknown");
    await denied(successor.stop({ ...request, retain: false }));
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(requestId);

    const result = { requestId, outcome: "completed" as const, machineId: a.machine.machineId };
    await denied(store.complete(a.hostToken, randomUUID(), result));
    await denied(store.complete(a.hostToken, a.installationId, { ...result, machineId: "e".repeat(64) }));
    const interruptedReceipt = failDockerJobCommit(requestId, "completed");
    await expect(
      interruptedReceipt.faultingStore.complete(a.hostToken, a.installationId, result),
    ).rejects.toMatchObject({
      cause: interruptedReceipt.failure,
    });
    expect(await successor.observe(a.machine)).toEqual({ kind: "unknown" });
    await store.complete(a.hostToken, a.installationId, result);
    await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed" });
    const retained = {
      sandboxId: a.sandboxId,
      generation: a.machine.generation,
      kind: "container" as const,
      ref: result.machineId,
    };
    expect(await successor.stop(request)).toEqual(retained);
    await denied(successor.stop({ ...request, retain: false }));
    expect(await successor.observe(a.machine)).toEqual({
      kind: "present",
      machine: a.machine,
      phase: "stopped",
      receipt: { operation: "stop", retained },
    });
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
    const status = await database().query("select status from sandboxes where id=$1", [a.sandboxId]);
    expect(status.rows).toEqual([{ status: "stopping" }]);
    if (fence === "revocation") await store.revoke(a.actor, a.hostId);
    else {
      await database().query("update sandboxes set status='failed' where id=$1", [a.sandboxId]);
      const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
      await expect(adapter.delete({ ...a.machine, scope: "physical-only" })).rejects.toThrow("outcome is pending");
      const { requestId } = (await store.poll(
        a.hostToken,
        a.installationId,
        undefined,
        false,
        undefined,
        undefined,
        null,
        null,
        [],
        null,
        true,
      ))!;
      await store.complete(a.hostToken, a.installationId, {
        requestId,
        outcome: fence === "failed physical removal" ? "failed" : "completed",
      });
    }
    expect(await successor.observe(a.machine)).toEqual({ kind: "unknown" });
  },
);

test("Machine non-retaining stop confirms removal after an ID-less stop acknowledgement", async () => {
  const a = await machineStopFixture();
  const adapter = store.machineCleanup(a.owner);
  const request = { ...a.machine, retain: false };
  await expect(adapter.stop(request)).rejects.toThrow("outcome is unknown");
  const stop = await store.poll(a.hostToken, a.installationId);
  await store.complete(a.hostToken, a.installationId, { requestId: stop!.requestId, outcome: "completed" });
  expect(await adapter.observe(a.machine)).toEqual({ kind: "unknown" });
  await expect(adapter.stop(request)).rejects.toThrow("outcome is unknown");
  const removal = await store.poll(a.hostToken, a.installationId);
  expect(removal?.operation).toBe("delete");
  await store.complete(a.hostToken, a.installationId, { requestId: removal!.requestId, outcome: "completed" });
  expect(await adapter.stop(request)).toBeNull();
  await denied(adapter.stop({ ...request, retain: true }));
  expect(await adapter.observe(a.machine)).toEqual({ kind: "absent", receipt: { operation: "delete" } });
});

test("Machine create freezes a snapshot from the admitted host installation", async () => {
  const host = await fixture();
  const db = database();
  const snapshotId = randomUUID();
  const image = `sha256:${"c".repeat(64)}`;
  await store.poll(host.hostToken, host.installationId);
  await db.query(
    `insert into docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,
     request_hash,actor_epoch,issuer_epoch,generation,base_image,status,image_id,build_expires_at)
     values($1,$2,$3,$4,$5,'machine-source','private','{}', $6,1,1,$7,$8,'ready',$9,now()+interval '1 hour')`,
    [
      snapshotId,
      host.actor.orgId,
      host.memberId,
      host.hostId,
      host.installationId,
      "b".repeat(64),
      randomUUID(),
      job().request.image,
      image,
    ],
  );
  const a = await machineCreateFixture(host, image, snapshotId);
  await denied(store.submitMachineCreate(a.owner, { ...a.request, source: { kind: "image", ref: image } }));
  await store.submitMachineCreate(a.owner, { ...a.request, source: { kind: "snapshot", ref: snapshotId } });
  expect(await store.poll(a.hostToken, a.installationId)).toMatchObject({
    operation: "create",
    request: { image, snapshot: { id: snapshotId, ownerId: a.owner.userId, visibility: "private" } },
  });
});

test("Machine create does not infer identity from an ID-less receipt", async () => {
  const a = await machineCreateFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await store.complete(a.hostToken, a.installationId, { requestId: a.generation, outcome: "completed" });
  expect(await store.submitMachineCreate(a.owner, a.request)).toEqual({ kind: "unknown" });
});

test("a stale Machine create does not dispatch or fail the current generation", async () => {
  const a = await machineCreateFixture();
  await store.submitMachineCreate(a.owner, a.request);
  expect(await store.poll(a.hostToken, a.installationId)).toHaveProperty("requestId", a.generation);
  const db = database();
  await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [a.sandboxId]);

  await denied(store.submitMachineCreate(a.owner, a.request));
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.generation });
  await store.cleaned(a.hostToken, a.installationId, { requestId: a.generation });
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  await store.complete(a.hostToken, a.installationId, { requestId: a.generation, outcome: "failed" });
  const sandbox = await db.query("select status from sandboxes where id=$1", [a.sandboxId]);
  expect(sandbox.rows).toEqual([{ status: "starting" }]);
});

test("retiring a host cancels its stale Machine create without failing a newer startup", async () => {
  const a = await machineCreateFixture();
  await store.submitMachineCreate(a.owner, a.request);
  const db = database();
  await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [a.sandboxId]);

  await store.revoke(a.actor, a.hostId);
  const { rows } = await db.query(
    `select s.status,j.outcome,j.cancelled_at is not null as cancelled
     from sandboxes s join docker_host_jobs j on j.bound_sandbox_id=s.id where j.request_id=$1`,
    [a.generation],
  );
  expect(rows).toEqual([{ status: "starting", outcome: "failed", cancelled: true }]);
});

async function prepareRestore(
  registered?: Awaited<ReturnType<typeof fixture>>,
  useSnapshot = false,
  bindTarget = true,
) {
  const host = registered ?? (await fixture());
  const db = database();
  const bindings = createDockerMachineGenerationBindings(sql, host);
  const sandboxId = randomUUID();
  const predecessor = await bindings.bind({ sandboxId, generation: 1 });
  const generation = bindTarget ? await bindings.bind({ sandboxId, generation: 2 }) : randomUUID();
  const expiresAt = Date.UTC(2099, 0, 1);
  const snapshot = useSnapshot
    ? { id: randomUUID(), ownerId: host.memberId, visibility: "private" as const }
    : undefined;
  const image = snapshot ? `sha256:${"c".repeat(64)}` : job().request.image;
  if (snapshot) {
    await store.poll(host.hostToken, host.installationId);
    await db.query(
      `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,
       request_hash,actor_epoch,issuer_epoch,generation,base_image,status,image_id,build_expires_at)
       values($1,$2,$3,$4,$5,'restore-source','private','{}'::jsonb,$6,1,1,$7,$8,'ready',$9,now()+interval '1 hour')`,
      [
        snapshot.id,
        host.actor.orgId,
        snapshot.ownerId,
        host.hostId,
        host.installationId,
        "b".repeat(64),
        randomUUID(),
        job().request.image,
        image,
      ],
    );
  }
  const a = await boundFixture(host, {
    sandboxId,
    generation: predecessor,
    expiresAt,
    image,
    ...(snapshot && { snapshotId: snapshot.id }),
  });
  await store.submitMachineCreate(a.owner, a.request);
  await store.complete(a.hostToken, a.installationId, {
    requestId: a.create.requestId,
    outcome: "completed",
    machineId: "a".repeat(64),
  });
  await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [sandboxId]);
  const request = {
    sandboxId: a.sandboxId,
    generation,
    image,
    expiresAt,
    ttlSeconds: 3600,
    ...(snapshot && { snapshot }),
  };
  const restore = {
    requestId: generation,
    operation: "restore" as const,
    request,
    predecessor: { request: { ...request, generation: predecessor }, machineId: "a".repeat(64) },
  };
  const cleanupId = randomUUID();
  const cleanup = { operation: "stop", request: restore.predecessor.request };
  const putIntent = async (requestId: string, operation: string, input: object) =>
    db.query(
      `insert into docker_host_jobs(request_id,host_id,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,input_enc)
       select $1,$2,$3,user_id,epoch,$4,$5 from mcp_actor_epochs where org_id=$6 and user_id=$7`,
      [
        requestId,
        a.hostId,
        a.sandboxId,
        operation,
        await encryptSecret(JSON.stringify(input), key),
        a.owner.orgId,
        a.owner.userId,
      ],
    );
  await putIntent(cleanupId, "stop", { bound: 1, job: cleanup });
  const runnerJobId = await createJobsStore(sql, key).enqueue(
    "resume",
    sandboxId,
    2,
    randomUUID(),
    {},
    {
      orgId: a.owner.orgId,
      deadline: new Date(expiresAt - 60_000),
      maxAttempts: 2,
    },
  );
  const credential = randomUUID();
  const turn = randomUUID();
  const sealed = await encryptSecret("fixture", key);
  await db.query("insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)", [
    credential,
    a.owner.userId,
    sealed,
  ]);
  await db.query("update public.sandboxes set credential_id=$2,credential_version=1 where id=$1", [
    a.sandboxId,
    credential,
  ]);
  await db.query(
    `insert into public.account_turn_queue
       (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,
        conversation_id,state,dispatch_generation)
     select $1,$2,$3,user_id,org_id,epoch,1,'fixture',$6,'first','dispatching',1
       from public.mcp_actor_epochs where user_id=$4 and org_id=$5`,
    [a.sandboxId, turn, credential, a.owner.userId, a.owner.orgId, sealed],
  );
  if (!(await recordResumeAuthority(sql, a.sandboxId, 2, turn, new Date(expiresAt).toISOString(), {})))
    throw new Error("Missing Docker resume authority.");
  const enqueueRestore = async (
    mailbox = store,
    overrides: Partial<Parameters<ReturnType<typeof store.machine>["resume"]>[0]> = {},
  ) => {
    const {
      rows: [claim],
    } = await sql.query<Job>(
      `update jobs set state='leased',lease_owner=$2,lease_epoch=lease_epoch+1,lease_until='infinity'
       where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
      [runnerJobId, randomUUID()],
    );
    if (!claim) throw Error("Missing restore runner.");
    const adapter = mailbox.machine({
      actor: a.owner,
      hostId: a.hostId,
      installationId: a.installationId,
      restoreClaim: claim,
    });
    try {
      return await adapter.resume({
        sandboxId,
        generation: 2,
        size: null,
        computeTtlSeconds: request.ttlSeconds,
        predecessor: { kind: "container", sandboxId, generation: 1, ref: restore.predecessor.machineId },
        ...overrides,
      });
    } finally {
      await sql.query("update jobs set state='queued',lease_owner=null,lease_until=null where id=$1", [runnerJobId]);
    }
  };
  const poll = (running: string[] = [], supportsRestore = true, hostStore = store, bootstrap = false) =>
    hostStore.poll(
      a.hostToken,
      a.installationId,
      undefined,
      false,
      undefined,
      undefined,
      null,
      null,
      running,
      null,
      false,
      supportsRestore,
      false,
      bootstrap,
    );
  return { ...a, restore, runnerJobId, enqueueRestore, cleanupId, poll, putIntent, credential };
}

async function restoreFixture() {
  const a = await prepareRestore();
  await expect(a.enqueueRestore()).rejects.toThrow("outcome is pending");
  return a;
}

test.each(["explicit replay", "queued send", "ordinary retained stop"] as const)(
  "Docker %s admits one shared resume and pins the checkpoint",
  async (scenario) => {
    const a = await prepareRestore(undefined, false, false);
    const requestId = randomUUID();
    await sql.query("delete from public.jobs where sandbox_id=$1", [a.sandboxId]);
    await sql.query(
      `update public.sandboxes set status=case when $2::boolean then 'ready'::public.sandbox_status else 'stopped'::public.sandbox_status end,
        status_reason=case when not $2::boolean then 'idle_paused' end,
        stopped_at=case when not $2::boolean then now() end,lifecycle_generation=1,model='gpt-5',reasoning_effort='high' where id=$1`,
      [a.sandboxId, scenario === "ordinary retained stop"],
    );
    await sql.query("insert into public.runtime_enrolments (sandbox_id,lifecycle_generation,epoch) values($1,1,$2)", [
      a.sandboxId,
      scenario === "ordinary retained stop" ? 2 : 1,
    ]);
    await sql.query(
      `insert into public.runtime_checkpoints (sandbox_id,epoch,request_id,watermark,completed_at)
       values($1,1,$2,0,now())`,
      [a.sandboxId, randomUUID()],
    );
    if (scenario === "ordinary retained stop") {
      await sql.query("insert into runtime_checkpoints (sandbox_id,epoch,request_id) values($1,2,$2)", [
        a.sandboxId,
        randomUUID(),
      ]);
    }
    const unavailable = async () => {
      throw Error("Admission must only enqueue the shared job.");
    };
    const enrolments = createRuntimeEnrolments(sql, key);
    let session: Awaited<ReturnType<typeof enrolments.enrol>>;
    const conversation = randomUUID();
    await sql.query("update sandboxes set conversation_ids=array[$2::text] where id=$1", [a.sandboxId, conversation]);
    const promptId = randomUUID();
    const runtimeClock = {
      now: Date.now,
      async wait() {
        const { command } = await commands.next(session.runtimeToken, session.epoch);
        if (command?.op !== "health" && command?.op !== "prompt") throw Error("No resume health or prompt command.");
        await commands.complete(session.runtimeToken, session.epoch, {
          epoch: session.epoch,
          requestId: command.requestId,
          status: 200,
          body: {
            version: 1,
            requestId: command.requestId,
            result:
              command.op === "health"
                ? {
                    ready: true,
                    generation: session.epoch,
                    restoredFrom: { epoch: "1", watermark: 0, conversationId: conversation },
                  }
                : { promptId, conversationId: conversation, status: "queued" },
          },
        });
      },
    };
    const commands = createRuntimeCommands(enrolments, key, runtimeClock);
    const queue = createAccountTurnQueue(sql, key);
    const resume = createResumeJob({
      sql,
      key,
      commands,
      turns: queue,
      provider: unavailable,
      prepare: unavailable,
      docker: {
        async prepareResume() {
          return {
            serverUrl: "https://armada.example",
            artifact: { sha256: "b".repeat(64), bytes: 123 },
            cacheDir: "/tmp",
            configuration: {},
          };
        },
      },
      async prepareMcp() {
        return undefined;
      },
      async restoreScopedAccess() {},
    });
    const caller = {
      userId: a.owner.userId,
      orgs: [{ orgId: a.owner.orgId, role: "member" as const }],
      via: "service" as const,
    };
    const jobs = createJobsStore(sql, key);
    const run = async (kind: string, handler: JobKind) => {
      const owner = randomUUID();
      const job = await jobs.claim(kind, owner, 30, 8);
      if (!job || job.sandbox_id !== a.sandboxId) throw Error(`Missing ${kind} job.`);
      const result = await handler.run(job, {
        signal: new AbortController().signal,
        canDispatch: async (tx) => (await jobs.inspect(job, owner, tx)) === "dispatch",
        handoffGeneration: (handoff) => jobs.handoffGeneration(job, owner, handoff),
      });
      expect(await jobs.complete(job, owner, result)).toBe(true);
      await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1 and kind=$2", [a.sandboxId, kind]);
      return result.status;
    };
    await sql.query("delete from account_turn_queue where sandbox_id=$1", [a.sandboxId]);
    await sql.query("update docker_hosts set daemon_protocol=$2,restore_recovery_supported=true where id=$1", [
      a.hostId,
      DOCKER_HOST_PROTOCOL,
    ]);
    await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "failed" });
    if (scenario === "ordinary retained stop") {
      await store.enqueueStop(a.owner, a.sandboxId, randomUUID());
      await runDockerStop(sql, key, a.sandboxId);
      const stop = await a.poll();
      if (stop?.operation !== "stop") throw Error("Missing ordinary stop job.");
      await store.complete(a.hostToken, a.installationId, {
        requestId: stop.requestId,
        outcome: "completed",
        machineId: "a".repeat(64),
      });
      expect(await runDockerStop(sql, key, a.sandboxId)).toMatchObject({ status: "done" });
    }
    const controls = createDockerSandboxControls(sql, key, {
      sendEnabled: true,
      wakeResume: resume.wake,
      resume: resume.resumeDocker,
      clock: runtimeClock,
    });
    const dispatch = createTurnDispatchJob(sql, key, async (actor, input, claim) => {
      const result = await controls.invoke(actor, "send", { ...input }, claim ? { claim } : {});
      if (!result.handled) throw Error("Docker sandbox was not handled.");
      return result.result;
    });
    const input = { id: a.sandboxId, request_id: requestId, prompt: "Continue" };
    let receipts: Promise<unknown> | undefined;
    if (scenario === "queued send") {
      await queue.accept(caller, input);
      expect(await run("turn_dispatch", dispatch)).toBe("retry");
    } else {
      const admitted = Promise.withResolvers<void>();
      const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, admitted.resolve);
      try {
        const invoke = () => controls.invoke(caller, "resume", { id: a.sandboxId, request_id: requestId });
        receipts = Promise.all([invoke(), invoke()]);
        await Promise.race([admitted.promise, receipts]);
      } finally {
        unsubscribe();
      }
    }
    expect(await run("resume", resume.handler)).toBe("retry");
    const restore = await a.poll();
    if (restore?.operation !== "restore") throw Error("Missing Docker restore job.");
    await store.complete(a.hostToken, a.installationId, {
      requestId: restore.requestId,
      outcome: "completed",
      machineId: "c".repeat(64),
    });
    expect(await run("resume", resume.handler)).toBe("retry");
    const boot = await a.poll([], true, store, true);
    if (boot?.operation !== "bootstrap") throw Error("Missing restored bootstrap job.");
    session = await enrolments.enrol(boot.bootstrap.enrolmentToken);
    if (scenario === "ordinary retained stop") expect(session.configuration).not.toHaveProperty("restoreCheckpoint");
    else
      expect(session.configuration).toMatchObject({
        restoreCheckpoint: { epoch: "1", watermark: 0, conversationId: conversation },
      });
    expect(await run("resume", resume.handler)).toBe("done");
    runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
    if (receipts) {
      expect(await receipts).toEqual(Array(2).fill({ handled: true, result: { id: a.sandboxId, status: "ready" } }));
    } else {
      expect(await run("turn_dispatch", dispatch)).toBe("done");
      expect(await queue.accept(caller, input)).toMatchObject({ promptId });
      expect(
        (
          await sql.query(
            "select request_id from runtime_commands where sandbox_id=$1 and starts_with(request_id,'docker_prompt_')",
            [a.sandboxId],
          )
        ).rows,
      ).toEqual([{ request_id: `docker_prompt_${requestId}` }]);
    }
    expect(await lifecycle(a.sandboxId)).toMatchObject({
      lifecycle_generation: scenario === "ordinary retained stop" ? "3" : "2",
    });
    expect(
      (await sql.query("select count(*)::int as total from jobs where kind='resume' and sandbox_id=$1", [a.sandboxId]))
        .rows,
    ).toEqual([{ total: 1 }]);
  },
);

test("an admitted stop refuses fresh restore mailbox work", async () => {
  const a = await prepareRestore();
  await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "failed" });
  try {
    expect(await store.enqueueStop(a.owner, a.sandboxId, randomUUID())).toBeString();
    await denied(a.enqueueRestore());
    expect(await a.poll()).toBeNull();
  } finally {
    await sql.query("delete from jobs where sandbox_id=$1", [a.sandboxId]);
  }
});

test.each(["stop", "delete"] as const)(
  "queued %s reconciles a delivered restore before using a placement",
  async (operation) => {
    const a = await restoreFixture();
    await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "failed" });
    expect(await a.poll()).toEqual(a.restore);
    const requestId = randomUUID();
    if (operation === "stop") {
      expect(await store.enqueueStop(a.owner, a.sandboxId, requestId)).toBeString();
      expect(await runDockerStop(sql, key, a.sandboxId)).toMatchObject({ status: "retry", unattempted: true });
    } else {
      await sql.query("update sandboxes set status='failed', lifecycle_generation=3 where id=$1", [a.sandboxId]);
      await expect(store.enqueueCleanup(a.owner, a.sandboxId, { operation, requestId })).rejects.toThrow();
    }
    await store.complete(a.hostToken, a.installationId, {
      requestId: a.restore.requestId,
      outcome: "completed",
      machineId: "c".repeat(64),
    });
    if (operation === "stop") await runDockerStop(sql, key, a.sandboxId);
    else await store.enqueueCleanup(a.owner, a.sandboxId, { operation, requestId });
    const cleanup = await a.poll();
    expect(cleanup).toMatchObject({ operation, request: { generation: a.restore.request.generation } });
  },
);

test.each(["active", "revoked"])(
  "a lost restore pickup with an empty daemon ledger reconciles with %s host authority",
  async (authority) => {
    const a = await restoreFixture();
    await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "failed" });
    expect(await a.poll()).toEqual(a.restore);
    await store.enqueueStop(a.owner, a.sandboxId, randomUUID());
    expect(await runDockerStop(sql, key, a.sandboxId)).toMatchObject({ status: "retry", unattempted: true });
    const jobs = createJobsStore(sql, key);
    const worker = randomUUID();
    const {
      rows: [resumed],
    } = await sql.query<Job>(
      `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity'
       where id=$1 returning id,sandbox_id,generation::text,kind,lease_epoch::text`,
      [a.runnerJobId, worker],
    );
    if (!resumed) throw Error("Missing restore runner.");
    expect(
      await jobs.complete(resumed, worker, {
        status: "fail",
        reason: "resume_dispatch_ended",
        outcome: { checkpoint: {} },
      }),
    ).toBe(true);
    const route = createDockerHostRoutes(store, async () => {
      throw Error("Unexpected caller authentication.");
    });
    const poll = async (recover: boolean) => {
      const response = await route(
        new Request("https://armada.example/api/docker-host/poll", {
          method: "POST",
          headers: {
            authorization: `Bearer ${a.hostToken}`,
            [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
            "x-armada-docker-host-restore": "1",
            ...(recover ? { "x-armada-docker-host-restore-recovery": "1" } : {}),
          },
          body: JSON.stringify({ installationId: a.installationId, version: "13.0.0" }),
        }),
      );
      if (!response?.ok) throw Error("Docker poll failed.");
      return (await response.json()) as DockerHostPollResponse;
    };
    if (authority === "revoked") await store.revoke(a.actor, a.hostId);
    else expect(await poll(false)).not.toHaveProperty("restoreRecovery");
    const recovery = await poll(true);
    expect(recovery.restoreRecovery).toEqual(a.restore);
    let saved: State = {
      server: "https://armada.example",
      hostId: a.hostId,
      installationId: a.installationId,
      hostToken: a.hostToken,
      receipts: [],
    };
    const ledger: Store = {
      async load() {
        return structuredClone(saved);
      },
      async save(state) {
        saved = structuredClone(state);
      },
    };
    const unexpected = async () => {
      throw Error("Recovery must only inspect.");
    };
    await tick(
      ledger,
      {
        register: unexpected,
        poll: async () => recovery,
        async result(_state, receipt) {
          expect(saved.receipts).toContainEqual(receipt);
          if (!receipt.outcome) throw Error("Missing durable outcome.");
          await store.complete(a.hostToken, a.installationId, {
            requestId: receipt.requestId,
            outcome: receipt.outcome,
          });
        },
      },
      {
        create: unexpected,
        restore: unexpected,
        delete: unexpected,
        stop: unexpected,
        stopIfExpired: async () => false,
        async reconcileRestore(request, predecessor) {
          expect({ request, predecessor }).toEqual({ request: a.restore.request, predecessor: a.restore.predecessor });
          return null;
        },
      },
    );
    expect(await store.restoreRecoveryForHost(a.hostToken, a.installationId, [])).toBeUndefined();
    if (authority === "active") {
      expect(await runDockerStop(sql, key, a.sandboxId)).toMatchObject({ status: "done" });
      expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "stopped" });
    }
  },
);

test("the current runner declines a completed restore receipt without a physical ID", async () => {
  const a = await restoreFixture();
  const {
    rows: [claim],
  } = await database().query<Job>(
    `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [a.runnerJobId, randomUUID()],
  );
  if (!claim) throw new Error("Missing fixture runner claim.");
  const { requestId } = a.restore;
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed" });
  await expect(store.attachMachineRestore(a.owner, claim)).rejects.toBeInstanceOf(DockerHostDenied);
  const { rows } = await database().query("select docker_generation from sandboxes where id=$1", [a.sandboxId]);
  expect(rows).toEqual([{ docker_generation: a.restore.predecessor.request.generation }]);
});

test("the current runner attaches only a completed Docker restore and can recover an interrupted handoff", async () => {
  const a = await prepareRestore(undefined, false, false);
  const db = database();
  const {
    rows: [claim],
  } = await db.query<Job>(
    `update jobs set state='leased',lease_owner=$2,lease_epoch=2,lease_until='infinity',attempts=2
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [a.runnerJobId, randomUUID()],
  );
  if (!claim) throw new Error("Missing fixture runner claim.");
  const resume = (hostStore = store, restoreClaim = claim) =>
    hostStore
      .machine({
        actor: a.owner,
        hostId: a.hostId,
        installationId: a.installationId,
        restoreClaim,
      })
      .resume({
        sandboxId: a.sandboxId,
        generation: 2,
        size: null,
        computeTtlSeconds: a.restore.request.ttlSeconds,
        predecessor: {
          sandboxId: a.sandboxId,
          generation: 1,
          kind: "container",
          ref: a.restore.predecessor.machineId,
        },
      });
  const machineId = "c".repeat(64);
  const machine = { sandboxId: a.sandboxId, generation: Number(claim.generation), machineId };
  const current = async () =>
    (
      await db.query(
        "select status, lifecycle_generation::text, docker_generation, provider_sandbox_id from sandboxes where id=$1",
        [a.sandboxId],
      )
    ).rows[0];
  const predecessor = await current();
  const target = { sandboxId: a.sandboxId, generation: 2 };
  const submitFault = interruptDockerCommit(async (tx) =>
    Boolean(await createDockerMachineGenerationBindings(tx, a).lookup(target)),
  );
  await expect(resume(submitFault.faultingStore)).rejects.toMatchObject({ cause: submitFault.failure });
  expect(await createDockerMachineGenerationBindings(sql, a).lookup(target)).toBeUndefined();
  const restoreReceipts = () =>
    db.query("select request_id from docker_host_jobs where bound_sandbox_id=$1 and bound_operation='restore'", [
      a.sandboxId,
    ]);
  expect((await restoreReceipts()).rows).toEqual([]);

  await expect(resume()).rejects.toMatchObject({ outcome: "pending" });
  await expect(resume()).rejects.toMatchObject({ outcome: "pending" });
  const delivered = await a.poll([a.cleanupId]);
  if (delivered?.operation !== "restore") throw new Error("Missing Docker restore delivery.");
  const { requestId } = delivered;
  expect((await restoreReceipts()).rows).toEqual([{ request_id: requestId }]);
  expect(delivered.request.generation).toBe(requestId);
  expect(delivered.predecessor).toEqual(a.restore.predecessor);
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed", machineId });
  await expect(store.attachMachineRestore(a.owner, { ...claim, lease_epoch: "1" })).rejects.toBeInstanceOf(
    DockerHostDenied,
  );
  await expect(store.attachMachineRestore(a.owner, { ...claim, generation: "1" })).rejects.toBeInstanceOf(
    DockerHostDenied,
  );

  await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "completed" });
  const { faultingStore, failure } = interruptDockerCommit(async (tx) => {
    const result = await tx.query("select 1 from sandboxes where id=$1 and docker_generation=$2", [
      a.sandboxId,
      requestId,
    ]);
    return result.rows.length > 0;
  });
  await expect(resume(faultingStore)).rejects.toMatchObject({ cause: failure });
  expect(await current()).toEqual(predecessor);
  const {
    rows: [successor],
  } = await db.query<Job>(
    `update jobs set lease_owner=$2,lease_epoch=lease_epoch+1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [claim.id, randomUUID()],
  );
  if (!successor) throw new Error("Missing successor lease.");
  await denied(resume());
  expect(await resume(store, successor)).toEqual(machine);
  await expect(resume(store, successor)).resolves.toEqual(machine);
  expect(await current()).toEqual({
    status: "starting",
    lifecycle_generation: claim.generation,
    docker_generation: requestId,
    provider_sandbox_id: `armada-${a.installationId}-${a.hostId}-${a.sandboxId}-${requestId}`,
  });

  await database().query("update jobs set state='done',lease_until=null,lease_owner=null where id=$1", [claim.id]);
  const stopId = randomUUID();
  await queueMailboxStop(sql, key, a.owner, a.sandboxId, stopId);
  await expect(a.poll()).resolves.toEqual({
    operation: "stop",
    requestId: stopId,
    request: delivered.request,
  });
});

test("restore enqueue rolls back on interruption and freezes one intent per target generation", async () => {
  const a = await prepareRestore();
  const { faultingStore, failure } = failDockerJobCommit(a.restore.requestId, null);
  await expect(a.enqueueRestore(faultingStore)).rejects.toMatchObject({ cause: failure });
  await expect(a.poll([a.cleanupId])).resolves.toBeNull();
  await expect(a.enqueueRestore()).rejects.toThrow("outcome is pending");
  await expect(a.enqueueRestore()).rejects.toThrow("outcome is pending");
  await expect(a.poll()).resolves.toEqual(a.restore);
  await denied(
    a.enqueueRestore(store, {
      predecessor: { kind: "container", sandboxId: a.sandboxId, generation: 1, ref: "b".repeat(64) },
    }),
  );
});

test("restore enqueue refuses stale generations, unbound predecessors and altered machine identity", async () => {
  const a = await prepareRestore();
  const predecessor = { kind: "container" as const, sandboxId: a.sandboxId, generation: 1, ref: "a".repeat(64) };
  await denied(a.enqueueRestore(store, { generation: 1 }));
  await denied(a.enqueueRestore(store, { predecessor: { ...predecessor, generation: 0 } }));
  await denied(a.enqueueRestore(store, { predecessor: { ...predecessor, ref: "b".repeat(64) } }));
  await expect(a.poll([a.cleanupId])).resolves.toBeNull();
});

test("malformed retired restore history does not prevent a new restore", async () => {
  const a = await prepareRestore();
  const retired = randomUUID();
  await a.putIntent(retired, "restore", { bound: 1, job: {}, lifecycleGeneration: "1" });
  await database().query("update docker_host_jobs set outcome='failed',completed_at=now() where request_id=$1", [
    retired,
  ]);
  await expect(a.enqueueRestore()).rejects.toThrow("outcome is pending");
  await expect(a.poll()).resolves.toEqual(a.restore);
});

test("restore enqueue preserves the frozen host-local snapshot binding", async () => {
  const a = await prepareRestore(undefined, true);
  await expect(a.enqueueRestore()).rejects.toThrow("outcome is pending");
  await expect(a.poll()).resolves.toEqual(a.restore);
});

test("a Docker host cannot pick up a restore after its pinned account is revoked", async () => {
  const a = await restoreFixture();
  await sql.query("update public.credentials set status='revoked' where id=$1", [a.credential]);
  expect(await store.pendingStartsForHost(a.hostToken, a.installationId, true)).toEqual([]);
  expect(await a.poll([a.cleanupId])).toBeNull();
});

test("an expired restore runner prevents redelivery but permits a late physical receipt", async () => {
  const a = await restoreFixture();
  expect(await a.poll()).toEqual(a.restore);
  await database().query("update jobs set deadline_at='-infinity' where id=$1", [a.runnerJobId]);
  await createJobsStore(sql, key).enqueue(
    "turn_dispatch",
    a.sandboxId,
    2,
    randomUUID(),
    {},
    {
      orgId: a.owner.orgId,
      deadline: new Date(Date.UTC(2098, 0, 1)),
      maxAttempts: 2,
    },
  );

  expect(await store.pendingStartsForHost(a.hostToken, a.installationId, true)).toEqual([]);
  expect(await a.poll([a.cleanupId])).toBeNull();
  const result = { requestId: a.restore.requestId, outcome: "completed" as const };
  const receipt = async () =>
    (
      await database().query(
        "select outcome, cancelled_at is not null as cancelled from docker_host_jobs where request_id=$1",
        [result.requestId],
      )
    ).rows;
  expect(await receipt()).toEqual([{ outcome: "failed", cancelled: true }]);
  await store.complete(a.hostToken, a.installationId, result);
  expect(await receipt()).toEqual([{ outcome: "completed", cancelled: false }]);
});

test("authenticated restore expiry waits for exact replacement identity before settling", async () => {
  const a = await restoreFixture();
  expect(await a.poll()).toEqual(a.restore);
  const expiry = { requestId: a.restore.requestId };
  await database().query("update jobs set deadline_at='-infinity' where id=$1", [a.runnerJobId]);
  expect(await store.expired(a.hostToken, a.installationId, expiry)).toBe(false);
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "starting", lifecycle_generation: "2" });
  await store.complete(a.hostToken, a.installationId, { ...expiry, outcome: "completed", machineId: "c".repeat(64) });
  const interrupted = failDockerObservationCommit(a.sandboxId, "docker_expiry_observed");
  await expect(
    reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry, interrupted.faultingSql),
  ).rejects.toThrow(interrupted.failure);
  await sql.query("update jobs set lease_until=clock_timestamp() where kind='stop' and state='leased'");
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "starting", lifecycle_generation: "2" });
  expect(await dockerJournal(a.sandboxId, "docker_expiry_observed")).toEqual([]);

  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry);
  expect(await store.expired(a.hostToken, a.installationId, expiry)).toBe(true);
  expect(await lifecycle(a.sandboxId)).toMatchObject({
    status: "stopped",
    status_reason: "expired",
    lifecycle_generation: "3",
  });
  expect(await dockerJournal(a.sandboxId, "docker_expiry_observed")).toEqual([
    { from_status: "starting", to_status: "stopped", generation: "3" },
  ]);
});

test.each(["none", "pending", "settled"] as const)(
  "authenticated restore expiry settles the attached replacement once (stop already admitted: %s)",
  async (stopAdmitted) => {
    const a = await restoreFixture();
    const {
      rows: [claim],
    } = await database().query<Job>(
      `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
      [a.runnerJobId, randomUUID()],
    );
    if (!claim) throw new Error("Missing fixture runner claim.");
    const expiry = { requestId: a.restore.requestId };
    expect(await a.poll()).toEqual(a.restore);
    await store.complete(a.hostToken, a.installationId, { ...expiry, outcome: "completed", machineId: "c".repeat(64) });
    await store.attachMachineRestore(a.owner, claim);
    await database().query("update jobs set state='done',lease_until=null,lease_owner=null where id=$1", [claim.id]);

    if (stopAdmitted !== "none") {
      const stop = await queueMailboxStop(sql, key, a.owner, a.sandboxId, randomUUID());
      if (stopAdmitted === "settled") {
        expect(await store.expired(a.hostToken, a.installationId, expiry)).toBe(false);
        await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "completed" });
        expect(await store.expired(a.hostToken, a.installationId, expiry)).toBe(false);
        await reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry);
        expect(await store.expired(a.hostToken, a.installationId, expiry)).toBe(true);
        expect((await lifecycle(a.sandboxId))?.stop_requested_at).not.toBeNull();
        return;
      }
    }
    const before =
      stopAdmitted === "pending"
        ? { status: "stopping", lifecycle_generation: "3" }
        : { status: "starting", lifecycle_generation: "2" };
    const stoppedGeneration = stopAdmitted === "pending" ? "4" : "3";
    expect(await lifecycle(a.sandboxId)).toMatchObject(before);

    const interrupted = failDockerObservationCommit(a.sandboxId, "docker_expiry_observed");
    await expect(
      reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry, interrupted.faultingSql),
    ).rejects.toThrow(interrupted.failure);
    await sql.query("update jobs set lease_until=clock_timestamp() where kind='stop' and state='leased'");
    expect(await lifecycle(a.sandboxId)).toMatchObject(before);

    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry);
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry);
    expect(await lifecycle(a.sandboxId)).toMatchObject({
      status: "stopped",
      status_reason: "expired",
      lifecycle_generation: stoppedGeneration,
    });
    expect(await dockerJournal(a.sandboxId, "docker_expiry_observed")).toEqual([
      { from_status: before.status, to_status: "stopped", generation: stoppedGeneration },
    ]);
  },
);

test("retention cleanup settles an attached restore after expiry with atomic rollback and idempotent replay", async () => {
  const a = await restoreFixture();
  const {
    rows: [claim],
  } = await database().query<Job>(
    `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [a.runnerJobId, randomUUID()],
  );
  if (!claim) throw new Error("Missing fixture runner claim.");
  const { requestId } = a.restore;
  const cleanup = { requestId, cleanupReason: "disk_pressure" as const };
  expect(await a.poll()).toEqual(a.restore);
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed", machineId: "c".repeat(64) });
  await denied(store.cleaned(a.hostToken, a.installationId, cleanup));
  await store.attachMachineRestore(a.owner, claim);
  await database().query("update jobs set state='done',lease_until=null,lease_owner=null where id=$1", [claim.id]);
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId });

  const { faultingStore, failure } = failDockerObservationCommit(a.sandboxId, cleanup.cleanupReason);
  await expect(faultingStore.cleaned(a.hostToken, a.installationId, cleanup)).rejects.toMatchObject({
    cause: failure,
  });
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "stopped", lifecycle_generation: "3" });
  expect(await dockerJournal(a.sandboxId, cleanup.cleanupReason)).toEqual([]);

  await store.cleaned(a.hostToken, a.installationId, cleanup);
  await store.cleaned(a.hostToken, a.installationId, cleanup);
  expect(await lifecycle(a.sandboxId)).toMatchObject({
    status: "deleted",
    status_reason: "disk_pressure",
    lifecycle_generation: "4",
  });
  expect(await dockerJournal(a.sandboxId, cleanup.cleanupReason)).toEqual([
    { from_status: "stopped", to_status: "deleted", generation: "4" },
  ]);
});

test.each(["cleanup", "expiry", "outputs", "completion"] as const)(
  "late predecessor %s settles after restore attachment without changing the replacement",
  async (callback) => {
    const a = await restoreFixture();
    const {
      rows: [claim],
    } = await database().query<Job>(
      `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
       where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
      [a.runnerJobId, randomUUID()],
    );
    if (!claim) throw new Error("Missing fixture runner claim.");
    const { requestId } = a.restore;
    await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed", machineId: "c".repeat(64) });
    await store.attachMachineRestore(a.owner, claim);
    const before = await lifecycle(a.sandboxId);
    const report = (installationId: string, id = a.create.requestId) => {
      switch (callback) {
        case "cleanup":
          return store.cleaned(a.hostToken, installationId, { requestId: id });
        case "expiry":
          return store.expired(a.hostToken, installationId, { requestId: id });
        case "outputs":
          return store.retainedOutputs(a.hostToken, installationId, id, null, new AbortController().signal);
        case "completion":
          return store.complete(a.hostToken, installationId, { requestId: id, outcome: "failed", retained: true });
      }
    };
    const id = callback === "completion" ? a.cleanupId : a.create.requestId;
    await denied(report(randomUUID(), id));
    if (callback === "completion") {
      const { faultingStore, failure } = interruptDockerCommit(async (tx) => {
        const result = await tx.query("select 1 from docker_host_jobs where request_id=$1 and outcome='failed'", [id]);
        return result.rows.length > 0;
      });
      await expect(
        faultingStore.complete(a.hostToken, a.installationId, { requestId: id, outcome: "failed", retained: true }),
      ).rejects.toMatchObject({ cause: failure });
      const receipt = async () =>
        (await database().query("select outcome from docker_host_jobs where request_id=$1", [id])).rows[0];
      expect(await receipt()).toEqual({ outcome: null });
      await report(a.installationId, id);
      expect(await receipt()).toEqual({ outcome: "failed" });
    }
    await expect(report(a.installationId, id)).resolves.toBe(callback === "outputs" ? 204 : undefined);
    expect(await lifecycle(a.sandboxId)).toEqual(before);
  },
);

test("poll retires obsolete work without fencing a delayed physical completion", async () => {
  const a = await restoreFixture();
  const {
    rows: [claim],
  } = await database().query<Job>(
    `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [a.runnerJobId, randomUUID()],
  );
  if (!claim) throw new Error("Missing fixture runner claim.");
  expect(await a.poll([a.cleanupId])).toEqual(a.restore);
  const { requestId } = a.restore;
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed", machineId: "c".repeat(64) });
  await store.attachMachineRestore(a.owner, claim);
  const before = await lifecycle(a.sandboxId);

  const receipt = async () =>
    (
      await database().query(
        "select outcome,cancelled_at is not null as cancelled from docker_host_jobs where request_id=$1",
        [a.cleanupId],
      )
    ).rows[0];
  const { faultingStore, failure } = interruptDockerCommit(async (tx) => {
    const result = await tx.query("select 1 from docker_host_jobs where request_id=$1 and cancelled_at is not null", [
      a.cleanupId,
    ]);
    return result.rows.length > 0;
  });
  await expect(a.poll([], true, faultingStore)).rejects.toMatchObject({ cause: failure });
  expect(await receipt()).toEqual({ outcome: null, cancelled: false });
  expect(await a.poll()).toBeNull();
  expect(await receipt()).toEqual({ outcome: "failed", cancelled: true });
  const result = { requestId: a.cleanupId, outcome: "completed" as const };
  await store.complete(a.hostToken, a.installationId, result);
  await store.complete(a.hostToken, a.installationId, result);
  expect(await receipt()).toEqual({ outcome: "completed", cancelled: false });
  expect(await lifecycle(a.sandboxId)).toEqual(before);
});

test("an unattached restore output probe does not read the archive before custody is known", async () => {
  const a = await restoreFixture();
  await a.poll();
  expect(await store.expired(a.hostToken, a.installationId, { requestId: a.restore.requestId })).toBe(false);
  const signal = new AbortController().signal;
  const outputs = (token: string, installation: string, body: ReadableStream<Uint8Array> | null) =>
    store.retainedOutputs(token, installation, a.restore.requestId, body, signal);
  await denied(outputs(a.hostToken, randomUUID(), null));
  expect(await outputs(a.hostToken, a.installationId, null)).toBe(204);
  const archive = new ReadableStream<Uint8Array>(
    {
      pull() {
        throw new Error("Pre-handoff restore output must not be read");
      },
    },
    { highWaterMark: 0 },
  );
  expect(await outputs(a.hostToken, a.installationId, archive)).toBe(204);
});

test("restore work is gated and stays eligible behind an excluded predecessor cleanup", async () => {
  const a = await restoreFixture();
  const excluded = [a.cleanupId];
  const supportsRestore = true;
  const probe = (running: string[], supports: boolean) =>
    store.mayHaveWork(a.hostToken, a.installationId, false, running, false, supports);
  expect(await probe([], false)).toBe(false);
  const route = createDockerHostRoutes(store, async () => {
    throw Error("Host poll used user auth");
  });
  const pollRoute = async (capability: string, running: string[]) => {
    const response = await route(
      new Request("https://armada.example/api/docker-host/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.hostToken}`,
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          "x-armada-docker-host-restore": capability,
          "x-armada-docker-host-restore-recovery": "1",
        },
        body: JSON.stringify({ installationId: a.installationId, version: "4.0.0", running }),
      }),
    );
    expect(response?.status).toBe(200);
    return response?.json();
  };
  expect(await pollRoute("1, 1", [])).toMatchObject({ job: null, pendingStarts: [] });
  expect(await probe(excluded, supportsRestore)).toBe(true);
  const unrelated = job();
  await seedUnboundJob(a.hostId, unrelated);
  expect(await a.poll(excluded)).toEqual(unrelated);
  await store.complete(a.hostToken, a.installationId, { requestId: unrelated.requestId, outcome: "completed" });
  expect(await pollRoute("1", excluded)).toMatchObject({
    job: a.restore,
    pendingStarts: [a.restore.request, a.restore.predecessor.request].map(({ sandboxId, generation }) => ({
      sandboxId,
      generation,
    })),
  });
  expect(await a.poll([a.restore.requestId])).toBeNull();
});

test("the daemon recovers pending restores and drains unrelated work with a full poll exclusion budget", async () => {
  const host = await fixture();
  const pairs: Awaited<ReturnType<typeof restoreFixture>>[] = [];
  for (let index = 0; index < 13; index++) {
    const pair = await prepareRestore(host);
    const { requestId, ...job } = pair.restore;
    await pair.putIntent(requestId, "restore", {
      bound: 1,
      job,
      lifecycleGeneration: "2",
      runnerJobId: pair.runnerJobId,
    });
    pairs.push(pair);
  }

  let state: State = {
    server: "https://armada.example",
    installationId: host.installationId,
    hostId: host.hostId,
    hostToken: host.hostToken,
    receipts: [],
  };
  const ledger: Store = {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
  const completed: string[] = [];
  let lastExclusions: string[] | undefined;
  const api: Api = {
    async register() {
      throw new Error("Unexpected registration");
    },
    async poll(_state, options) {
      lastExclusions = options?.running;
      return { job: await pairs[0]!.poll(lastExclusions), held: true };
    },
    async result(_state, receipt) {
      if (!receipt.outcome) throw new Error("Missing terminal outcome");
      await store.complete(host.hostToken, host.installationId, {
        requestId: receipt.requestId,
        outcome: receipt.outcome,
      });
      if (receipt.outcome === "completed") completed.push(receipt.requestId);
    },
  };
  const attempted = new Set<string>();
  const executor: Executor = {
    async create() {},
    async stop() {},
    async delete() {},
    async stopIfExpired() {},
    async restore({ generation }) {
      if (!attempted.has(generation)) {
        attempted.add(generation);
        throw new DockerMachineError("docker_failed");
      }
    },
  };
  const now = () => Date.UTC(2026, 0, 1);
  const deferUncertain = new Set<string>();
  for (const { restore } of pairs) {
    await expect(tick(ledger, api, executor, false, now, { waitSeconds: 20, deferUncertain })).rejects.toThrow(
      DockerMachineError,
    );
    deferUncertain.add(restore.requestId);
  }
  expect(new Set(state.receipts.map(({ requestId }) => requestId))).toEqual(deferUncertain);
  expect(state.receipts.every(({ outcome }) => !outcome)).toBe(true);

  const live = [job(), job(), job()];
  for (const active of live) await seedUnboundJob(host.hostId, active);
  const running = new Set(live.map(({ requestId }) => requestId));
  const restoreConflicts = new Map(pairs.map(({ cleanupId, restore }) => [cleanupId, restore.requestId]));
  const unrelated = job();
  await seedUnboundJob(host.hostId, unrelated);
  const drain = () => tick(ledger, api, executor, false, now, { waitSeconds: 20, running, restoreConflicts });

  expect(await drain()).toBe("worked");
  expect(lastExclusions).toEqual([...running, ...restoreConflicts.keys()]);
  expect(lastExclusions).toHaveLength(16);
  expect(completed).toEqual([unrelated.requestId]);
  for (let index = 0; index < pairs.length * 2; index++) expect(await drain()).toBe("worked");
  const expected = [unrelated.requestId, ...pairs.flatMap(({ restore, cleanupId }) => [restore.requestId, cleanupId])];
  expect(completed).toEqual(expected);
});

test("the authenticated allocation result route preserves the exact create ID across replay", async () => {
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  const route = createDockerHostRoutes(store, async () => ({ ok: false }));
  const machineId = "a".repeat(64);
  const receipt = { installationId: a.installationId, requestId: a.create.requestId, outcome: "completed" };
  const post = async (body: unknown) =>
    (
      await route(
        new Request("https://armada.example/api/docker-host/results", {
          method: "POST",
          headers: {
            authorization: `Bearer ${a.hostToken}`,
            [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          },
          body: JSON.stringify(body),
        }),
      )
    )?.status;
  expect(await post({ ...receipt, machineId })).toBe(200);
  expect(await post({ ...receipt, machineId: "short" })).toBe(400);
  expect(await post({ ...receipt, outcome: "failed", machineId })).toBe(400);
  expect(await post({ ...receipt, installationId: randomUUID(), machineId })).toBe(401);
  expect(await post({ ...receipt, machineId })).toBe(200);
  expect(await post(receipt)).toBe(200);
  expect(await post({ ...receipt, machineId: "b".repeat(64) })).toBe(401);
  expect(
    (
      await database().query("select outcome,result_machine_id from docker_host_jobs where request_id=$1", [
        receipt.requestId,
      ])
    ).rows,
  ).toEqual([{ outcome: "completed", result_machine_id: machineId }]);
});

test("restore dispatch cancels stale intent and reconciles a late physical receipt", async () => {
  const a = await restoreFixture();
  const db = database();
  await db.query("update sandboxes set lifecycle_generation=3 where id=$1", [a.sandboxId]);
  expect(await store.pendingStartsForHost(a.hostToken, a.installationId, true)).toEqual([]);
  const { faultingStore, failure } = failDockerJobCommit(a.restore.requestId, "failed");
  await expect(a.poll([a.cleanupId], true, faultingStore)).rejects.toMatchObject({ cause: failure });
  expect(await a.poll([a.cleanupId])).toBeNull();
  const result = { requestId: a.restore.requestId, outcome: "completed" as const, machineId: "c".repeat(64) };
  const lostReceipt = failDockerJobCommit(result.requestId, result.outcome);
  await expect(lostReceipt.faultingStore.complete(a.hostToken, a.installationId, result)).rejects.toMatchObject({
    cause: lostReceipt.failure,
  });
  expect(
    (await db.query("select outcome,result_machine_id from docker_host_jobs where request_id=$1", [result.requestId]))
      .rows,
  ).toEqual([{ outcome: "failed", result_machine_id: null }]);
  await store.complete(a.hostToken, a.installationId, result);
  await store.complete(a.hostToken, a.installationId, result);
  expect(
    (await db.query("select result_machine_id from docker_host_jobs where request_id=$1", [result.requestId])).rows,
  ).toEqual([{ result_machine_id: result.machineId }]);
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: result.requestId });
  await denied(store.complete(a.hostToken, a.installationId, { requestId: result.requestId, outcome: "failed" }));
  expect(await store.pendingStartsForHost(a.hostToken, a.installationId, true)).toEqual([]);
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "starting" });
});

test.each(["pending", "completed"] as const)(
  "predecessor receipts cannot retire a %s restore's target",
  async (phase) => {
    const a = await restoreFixture();
    expect(await a.poll()).toEqual(a.restore);
    if (phase === "completed")
      await store.complete(a.hostToken, a.installationId, { requestId: a.restore.requestId, outcome: "completed" });
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.create.requestId });
    await store.cleaned(a.hostToken, a.installationId, { requestId: a.cleanupId });
    expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "starting", lifecycle_generation: "2" });
    if (phase === "pending") expect(await a.poll()).toEqual(a.restore);

    await database().query("update sandboxes set status='stopping' where id=$1", [a.sandboxId]);
    await store.complete(a.hostToken, a.installationId, { requestId: a.cleanupId, outcome: "completed" });
    expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "stopping", lifecycle_generation: "2" });
    const receipt = await database().query("select outcome from docker_host_jobs where request_id=$1", [a.cleanupId]);
    expect(receipt.rows).toEqual([{ outcome: "completed" }]);
  },
);

test("an older restore cannot fence a predecessor receipt for a generation with no restore intent", async () => {
  const a = await restoreFixture();
  await database().query("update sandboxes set lifecycle_generation=3 where id=$1", [a.sandboxId]);
  expect(await a.poll([a.cleanupId])).toBeNull();

  const bindings = createDockerMachineGenerationBindings(sql, a);
  await bindings.bind({ sandboxId: a.sandboxId, generation: 3 });
  await store.cleaned(a.hostToken, a.installationId, { requestId: a.cleanupId });

  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "deleted", lifecycle_generation: "4" });
});

test.each(["target", "predecessor", "ciphertext"] as const)(
  "a restore with a mismatched %s cannot block a predecessor cleanup receipt",
  async (mismatch) => {
    const a = await restoreFixture();
    const { requestId, ...job } = a.restore;
    const generation = randomUUID();
    const intent = {
      ...job,
      request: mismatch === "target" ? { ...job.request, generation } : job.request,
      predecessor:
        mismatch === "predecessor"
          ? { ...job.predecessor, request: { ...job.predecessor.request, generation } }
          : job.predecessor,
    };
    const input =
      mismatch === "ciphertext"
        ? new Uint8Array(32)
        : await encryptSecret(
            JSON.stringify({ bound: 1, job: intent, lifecycleGeneration: "2", runnerJobId: a.runnerJobId }),
            key,
          );
    await database().query("update docker_host_jobs set input_enc=$2 where request_id=$1", [requestId, input]);

    await store.cleaned(a.hostToken, a.installationId, { requestId: a.cleanupId });
    expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "deleted", lifecycle_generation: "3" });
  },
);

test("a malformed restore intent does not hide unrelated work", async () => {
  const a = await restoreFixture();
  const db = database();
  await db.query("update docker_host_jobs set input_enc=$2 where request_id=$1", [
    a.restore.requestId,
    await encryptSecret("{", key),
  ]);
  const unrelated = job();
  await seedUnboundJob(a.hostId, unrelated);
  expect(await a.poll()).toEqual(unrelated);
  expect(await store.pendingStartsForHost(a.hostToken, a.installationId, true)).toEqual([]);
  await store.complete(a.hostToken, a.installationId, { requestId: unrelated.requestId, outcome: "completed" });
  expect(await a.poll([a.cleanupId])).toBeNull();
  const outcome = await db.query("select outcome from docker_host_jobs where request_id=$1", [a.restore.requestId]);
  expect(outcome.rows).toEqual([{ outcome: "failed" }]);
});

function interruptDockerCommit(written: (tx: Sql) => Promise<boolean>) {
  const failure = new Error("Docker transaction interrupted before commit");
  const faultingSql: Sql = {
    query: sql.query,
    transaction: (work) =>
      database().transaction(async (tx) => {
        const scoped: Sql = { query: (query, params) => tx.query(query, params) };
        const result = await work(scoped);
        if (await written(scoped)) throw failure;
        return result;
      }),
  };
  return { faultingStore: createDockerHostStore(faultingSql, key), faultingSql, failure };
}

function failDockerJobCommit(requestId: string, outcome: "completed" | "failed" | null) {
  return interruptDockerCommit(async (tx) => {
    const result = await tx.query(
      `select 1 from docker_host_jobs where request_id=$1 and outcome is not distinct from $2::text`,
      [requestId, outcome],
    );
    return result.rows.length > 0;
  });
}

test("physical deletion rechecks its lifecycle fence, while late receipts record only physical facts", async () => {
  const db = database();
  const a = await machineStopFixture();
  await db.query("update sandboxes set status='failed' where id=$1", [a.sandboxId]);
  const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  const removal = { ...a.machine, scope: "physical-only" as const };
  await denied(adapter.delete({ ...removal, generation: 2 }));
  await expect(adapter.delete(removal)).rejects.toThrow("outcome is pending");
  const poll = (mailbox = store) =>
    mailbox.poll(a.hostToken, a.installationId, undefined, false, undefined, undefined, null, null, [], null, true);
  const deletion = (await poll())!;
  expect(deletion).toMatchObject({ operation: "deletePhysical", machineId: removal.machineId });
  await denied(store.cleaned(a.hostToken, a.installationId, { requestId: deletion.requestId }));
  await db.query(`update sandboxes set lifecycle_generation=2 where id=$1`, [a.sandboxId]);
  const { faultingStore, failure } = failDockerJobCommit(deletion.requestId, "failed");
  await expect(poll(faultingStore)).rejects.toMatchObject({ cause: failure });
  const receipt = () =>
    db.query(
      `select j.outcome,j.cancelled_at,s.status,s.lifecycle_generation::text as generation,s.docker_generation from docker_host_jobs j
       join sandboxes s on s.id=j.bound_sandbox_id where j.request_id=$1`,
      [deletion.requestId],
    );
  expect((await receipt()).rows).toEqual([
    { outcome: null, cancelled_at: null, status: "failed", generation: "2", docker_generation: a.generation },
  ]);
  expect(await poll()).toBeNull();
  expect((await receipt()).rows).toEqual([
    {
      outcome: "failed",
      cancelled_at: expect.anything(),
      status: "failed",
      generation: "2",
      docker_generation: a.generation,
    },
  ]);
  const result = { requestId: deletion.requestId, outcome: "completed" as const };
  await denied(store.complete(a.hostToken, randomUUID(), result));
  await store.complete(a.hostToken, a.installationId, result);
  await store.complete(a.hostToken, a.installationId, result);
  await denied(store.complete(a.hostToken, a.installationId, { ...result, outcome: "failed" }));
  expect((await receipt()).rows).toEqual([
    { outcome: "completed", cancelled_at: null, status: "failed", generation: "2", docker_generation: a.generation },
  ]);
});

test("uninstall cancels pending optional physical deletion even without a capable poll", async () => {
  const db = database();
  const a = await machineStopFixture();
  const adapter = store.machine({ actor: a.owner, hostId: a.hostId, installationId: a.installationId });
  await db.query(`update sandboxes set status='deleted',deleted_at=now() where id=$1`, [a.sandboxId]);
  await expect(adapter.delete({ ...a.machine, scope: "physical-only" })).rejects.toThrow("outcome is pending");
  const {
    rows: [deletion],
  } = await db.query<{ request_id: string }>(
    "select request_id from docker_host_jobs where bound_sandbox_id=$1 and bound_operation='deletePhysical'",
    [a.sandboxId],
  );
  if (!deletion) throw Error("Missing physical removal intent.");
  const { faultingStore, failure } = failDockerJobCommit(deletion.request_id, "failed");
  await expect(faultingStore.unregister(a.hostToken, a.installationId)).rejects.toMatchObject({ cause: failure });
  const state = () =>
    db.query(
      `select j.outcome,j.cancelled_at,h.draining_at,h.revoked_at from docker_host_jobs j
        join docker_hosts h on h.id=j.host_id where j.request_id=$1`,
      [deletion.request_id],
    );
  expect((await state()).rows).toEqual([{ outcome: null, cancelled_at: null, draining_at: null, revoked_at: null }]);
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  expect((await state()).rows).toEqual([
    { outcome: "failed", cancelled_at: expect.anything(), draining_at: null, revoked_at: expect.anything() },
  ]);
});

// The migrated SQL boundary owns binding, actor fencing, lifecycle intent and capabilities.
test("bound member admission derives immutable machine fields and cannot redirect or adopt mailbox IDs", async () => {
  const db = database();
  const a = await boundFixture(),
    b = await boundFixture();
  await denied(store.submitMachineCreate(a.actor, a.request)); // admin is not the private owner
  await denied(store.submitMachineCreate(b.owner, a.request));
  await denied(store.submitMachineCreate(a.owner, { ...a.request, sandboxId: randomUUID() }));
  await denied(store.submitMachineCreate(a.owner, { ...a.request, source: { kind: "image", ref: "other-image" } }));
  await store.submitMachineCreate(a.owner, a.request);
  await createDockerHostStore(sql, key).submitMachineCreate(a.owner, a.request);
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
  await denied(store.submitMachineCreate(a.owner, { ...a.request, generation: 2 }));
  await db.query(`update sandboxes set status='ready',expires_at=now()+interval '2 hours' where id=$1`, [a.sandboxId]);
  await store.submitMachineCreate(a.owner, a.request);
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
});

test("poll retires stale actor grants without starving authorized cleanup; ACK remains a machine fact", async () => {
  const db = database();
  for (const change of ["demotion", "removal", "rejoin"] as const) {
    const a = await boundFixture();
    await db.query(`update members set role='admin' where org_id=$1 and user_id=$2`, [a.owner.orgId, a.owner.userId]);
    await store.submitMachineCreate(a.owner, a.request);
    await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
    const stale = { requestId: randomUUID(), operation: "stop" as const };
    await store.enqueueCleanup(a.owner, a.sandboxId, stale);
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
    await queueMailboxStop(sql, key, a.actor, a.sandboxId, stop.requestId);
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
  await store.submitMachineCreate(b.owner, b.request);
  expect((await store.poll(b.hostToken, b.installationId))?.requestId).toBe(b.create.requestId);
  await db.query(`delete from members where org_id=$1 and user_id=$2`, [b.owner.orgId, b.owner.userId]);
  await store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "completed" });
  await store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "completed" });
  await denied(store.complete(b.hostToken, b.installationId, { requestId: b.create.requestId, outcome: "failed" }));
  expect(
    (await db.query<{ status: string }>(`select status from sandboxes where id=$1`, [b.sandboxId])).rows[0]?.status,
  ).toBe("starting");
});

test.each(["launch", "account", "runtime", "revoked runtime", "revoked issuer"] as const)(
  "idle-only stop checks %s work",
  async (queue) => {
    const db = database();
    const a = await machineStopFixture();
    await db.query("update public.sandboxes set status='ready' where id=$1", [a.sandboxId]);
    const turn = randomUUID();
    const sealed = await encryptSecret("queued turn", key);
    if (queue === "launch") {
      await db.query(
        `insert into public.jobs(kind,sandbox_id,org_id,generation,idem_key,request_owner_id,request_digest,state,deadline_at,max_attempts,payload_enc,outcome)
         values('launch',$1,$2,1,$3,$4,$5,'queued',now()+interval '1 hour',1,$6,'{"docker_actor_epoch":"1"}'::jsonb)`,
        [
          a.sandboxId,
          a.owner.orgId,
          JSON.stringify(["request", a.owner.orgId, "launch", a.owner.userId, JSON.stringify(["docker", a.sandboxId])]),
          a.owner.userId,
          "a".repeat(64),
          sealed,
        ],
      );
    } else if (queue === "account") {
      const credential = randomUUID();
      await db.query(
        "insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)",
        [credential, a.owner.userId, sealed],
      );
      await db.query(
        `insert into public.account_turn_queue
        (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id)
       values($1,$2,$3,$4,$5,1,1,$6,$7,'first')`,
        [a.sandboxId, turn, credential, a.owner.userId, a.owner.orgId, "a".repeat(64), sealed],
      );
    }
    if (queue === "runtime" || queue === "revoked runtime" || queue === "revoked issuer") {
      await db.query(
        `insert into public.runtime_enrolments(sandbox_id,lifecycle_generation,epoch,runtime_hash,docker_issuer_fence)
       select id,lifecycle_generation,1,encode(sha256(uuid_send(id)),'hex'),$2
       from public.sandboxes where id=$1`,
        [a.sandboxId, `${a.actor.userId}:1`],
      );
      await db.query(
        "insert into public.runtime_commands(sandbox_id,request_id,epoch,request_enc) values($1,$2,1,$3)",
        [a.sandboxId, turn, sealed],
      );
    }
    const stop = { requestId: randomUUID(), operation: "stop" as const };
    if (queue === "revoked runtime") {
      await db.query("update public.runtime_enrolments set runtime_hash=null where sandbox_id=$1", [a.sandboxId]);
      await store.enqueueStop(a.owner, a.sandboxId, stop.requestId, { idleSequence: "0" });
      return;
    }
    if (queue === "revoked issuer") {
      await db.query("update public.mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
        a.actor.orgId,
        a.actor.userId,
      ]);
      await store.enqueueStop(a.owner, a.sandboxId, stop.requestId, { idleSequence: "0" });
      return;
    }
    await denied(store.enqueueStop(a.owner, a.sandboxId, stop.requestId, { idleSequence: "0" }));
    expect(
      (await db.query("select status,stop_requested_at from public.sandboxes where id=$1", [a.sandboxId])).rows,
    ).toEqual([{ status: "ready", stop_requested_at: null }]);
    expect(
      (await db.query("select 1 from public.docker_host_jobs where request_id=$1", [stop.requestId])).rows,
    ).toEqual([]);
    if (queue === "runtime") {
      await db.query(
        "update public.runtime_commands set request_id='outputs_9999999999999_sample' where sandbox_id=$1 and request_id=$2",
        [a.sandboxId, turn],
      );
      await store.enqueueStop(a.owner, a.sandboxId, stop.requestId, { idleSequence: "0" });
      return;
    }
    await queueMailboxStop(sql, key, a.owner, a.sandboxId, stop.requestId);
  },
);

test("stop commits runtime revocation once; cleanup retains the create deadline and ACKs only terminal transitions", async () => {
  const db = database();
  const a = await boundFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  await store.submitMachineCreate(a.owner, a.request);
  const initial = await store.poll(a.hostToken, a.installationId);
  if (!initial) throw Error("missing create");
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  const ticket = await authority.issue({ sandboxId: a.sandboxId, ownerId: a.owner.userId, configuration: {} });
  const runtime = await authority.enrol(ticket.enrolmentToken);
  const stop = { requestId: randomUUID(), operation: "stop" as const };
  const { faultingSql, failure } = failDockerJobCommit(stop.requestId, null);
  const before = await lifecycle(a.sandboxId);
  await expect(queueMailboxStop(faultingSql, key, a.actor, a.sandboxId, stop.requestId)).rejects.toThrow(failure);
  expect(await lifecycle(a.sandboxId)).toEqual(before);
  expect(await dockerJournal(a.sandboxId, "docker_stop_admitted")).toEqual([]);
  await queueMailboxStop(sql, key, a.actor, a.sandboxId, stop.requestId);
  await denied(queueMailboxStop(sql, key, a.owner, a.sandboxId, stop.requestId));
  await queueMailboxStop(sql, key, a.actor, a.sandboxId, stop.requestId);
  await queueMailboxStop(sql, key, a.actor, a.sandboxId, randomUUID());
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
  expect(await dockerJournal(a.sandboxId, "docker_stop_admitted")).toEqual([
    { from_status: before?.status, to_status: "stopping", generation: "2" },
  ]);

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
  await denied(store.enqueueCleanup(a.actor, a.sandboxId, { requestId: randomUUID(), operation: "delete" }));
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
  await store.enqueueCleanup(a.actor, a.sandboxId, remove);
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
  await denied(store.submitMachineCreate(a.owner, a.request));
  expect(
    (await db.query<{ status: string }>(`select status from sandboxes where id=$1`, [a.sandboxId])).rows[0]?.status,
  ).toBe("deleted");
});

async function seedHistoricalBootstrap(a: Awaited<ReturnType<typeof boundFixture>>, enrolmentToken: string) {
  const create = await sql.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
    "select input_enc from docker_host_jobs where request_id=$1",
    [a.create.requestId],
  );
  const { job } = JSON.parse(await decryptSecret(create.rows[0]!.input_enc, key));
  const requestId = randomUUID();
  const input = {
    bound: 1,
    job: {
      operation: "bootstrap",
      request: job.request,
      bootstrap: {
        serverUrl: "https://armada.example",
        artifact: { sha256: "b".repeat(64), bytes: 123 },
        enrolmentToken,
      },
    },
  };
  await sql.query(
    `insert into docker_host_jobs(request_id,host_id,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,input_enc)
     select $2,host_id,bound_sandbox_id,bound_actor_id,bound_actor_epoch,'bootstrap',$3
     from docker_host_jobs where request_id=$1`,
    [a.create.requestId, requestId, await encryptSecret(JSON.stringify(input), key)],
  );
  return requestId;
}

async function boundStartup(operation: "create" | "bootstrap") {
  const a = await boundFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  await store.submitMachineCreate(a.owner, a.request);
  const ticket = await authority.issue({ sandboxId: a.sandboxId, ownerId: a.owner.userId, configuration: {} });
  let startup = a.create as { requestId: string; operation: "create" | "bootstrap" };
  if (operation === "bootstrap") {
    await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
    startup = { requestId: await seedHistoricalBootstrap(a, ticket.enrolmentToken), operation };
  }
  const runtime = await authority.enrol(ticket.enrolmentToken);
  return { ...a, startup, authority, runtime };
}
async function lifecycle(sandboxId: string) {
  const db = database();
  return (
    await db.query<{
      status: string;
      status_reason: string | null;
      lifecycle_generation: string;
      stopped_at: unknown;
      stop_requested_at: unknown;
      deleted_at: unknown;
    }>(
      `select status,status_reason,lifecycle_generation::text,stopped_at,stop_requested_at,deleted_at
       from sandboxes where id=$1`,
      [sandboxId],
    )
  ).rows[0];
}

function failDockerObservationCommit(sandboxId: string, code: string) {
  return interruptDockerCommit(async (tx) => {
    const result = await tx.query("select 1 from public.sandbox_transitions where sandbox_id=$1 and code=$2", [
      sandboxId,
      code,
    ]);
    return result.rows.length > 0;
  });
}

async function dockerJournal(sandboxId: string, code: string) {
  return (
    await database().query(
      "select from_status,to_status,generation::text from public.sandbox_transitions where sandbox_id=$1 and code=$2",
      [sandboxId, code],
    )
  ).rows;
}

test("host-confirmed frozen expiry fences runtime once, survives owner removal and admits cleanup", async () => {
  const db = database();
  for (const operation of ["create", "bootstrap"] as const) {
    const a = await boundStartup(operation);
    // SQL's deadline is still in the future: the host's physical observation,
    // not the server clock or the actor's current grant, is authoritative.
    await db.query(`delete from members where org_id=$1 and user_id=$2`, [a.owner.orgId, a.owner.userId]);
    const before = await lifecycle(a.sandboxId);
    const expiry = { requestId: a.startup.requestId };
    if (operation === "create") {
      const { faultingSql, failure } = failDockerObservationCommit(a.sandboxId, "docker_expiry_observed");
      await expect(reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry, faultingSql)).rejects.toThrow(
        failure,
      );
      await sql.query("update jobs set lease_until=clock_timestamp() where kind='stop' and state='leased'");
      expect(await lifecycle(a.sandboxId)).toEqual(before);
      expect(await dockerJournal(a.sandboxId, "docker_expiry_observed")).toEqual([]);
    }
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, expiry);
    const stopped = await lifecycle(a.sandboxId);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.status_reason).toBe("expired");
    expect(stopped?.stopped_at).not.toBeNull();
    expect(stopped?.stop_requested_at).not.toBeNull();
    expect(Number(stopped?.lifecycle_generation)).toBe(Number(before?.lifecycle_generation) + 1);
    await expect(a.authority.withSession(a.runtime.runtimeToken, a.runtime.epoch, async () => true)).rejects.toThrow(
      "runtime_enrolment_denied",
    );
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
    expect(await lifecycle(a.sandboxId)).toEqual(stopped);
    expect(await dockerJournal(a.sandboxId, "docker_expiry_observed")).toEqual([
      { from_status: before?.status, to_status: "stopped", generation: stopped?.lifecycle_generation },
    ]);

    // An unacknowledged startup must not be replayed after the terminal fact.
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
    expect(await lifecycle(a.sandboxId)).toEqual(stopped);
    const remove = { requestId: randomUUID(), operation: "delete" as const };
    await store.enqueueCleanup(a.actor, a.sandboxId, remove);
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(remove.requestId);
    await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
    const deleted = await lifecycle(a.sandboxId);
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.deleted_at).not.toBeNull();
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
    expect(await lifecycle(a.sandboxId)).toEqual(deleted);
  }
});

async function stoppedOutputArchive() {
  const bytes = Buffer.from(
    await new Bun.Archive({ "outputs/": "", "outputs/late.txt": "after the live sample" }).bytes(),
  );
  // Bun.Archive emits a regular entry for the root key. Make it a ustar directory.
  bytes[156] = 53;
  bytes.fill(32, 148, 156);
  const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return bytes;
}

test("a complete stopped Docker archive replaces the live sample, while a truncated copy leaves it intact", async () => {
  const a = await boundStartup("create");
  await database().query(
    `insert into sandbox_outputs(sandbox_id,name,digest,size,content_enc) values($1,'previous.txt',$2,3,$3)`,
    [a.sandboxId, createHash("sha256").update("old").digest("hex"), await encryptSecret("b2xk", key)],
  );
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
  const route = createDockerHostRoutes(store, async () => {
    throw Error("Host upload used user auth");
  });
  const upload = (body?: Uint8Array<ArrayBuffer>) =>
    route(
      new Request("https://armada.example/api/docker-host/retained-outputs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.hostToken}`,
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
          "x-armada-installation-id": a.installationId,
          "x-armada-request-id": a.startup.requestId,
          ...(body ? { "content-type": "application/x-tar" } : {}),
        },
        ...(body ? { body } : {}),
      }),
    );
  const names = async () =>
    (
      await database().query<{ name: string }>("select name from sandbox_outputs where sandbox_id=$1", [a.sandboxId])
    ).rows.map(({ name }) => name);
  const archive = await stoppedOutputArchive();
  expect((await upload())?.status).toBe(202);
  expect((await upload(archive.subarray(0, 1536)))?.status).toBe(503);
  expect(await names()).toEqual(["previous.txt"]);
  expect((await upload(archive))?.status).toBe(204);
  expect(await names()).toEqual(["late.txt"]);
  const chunk = (
    await database().query<{ content_enc: Uint8Array<ArrayBuffer> }>(
      `select c.content_enc from sandbox_output_chunks c join sandbox_outputs o on c.transfer_id=o.transfer_id
       where o.sandbox_id=$1 and o.name='late.txt'`,
      [a.sandboxId],
    )
  ).rows[0];
  if (!chunk) throw Error("missing encrypted output");
  expect(Buffer.from(await decryptSecret(chunk.content_enc, key), "base64").toString()).toBe("after the live sample");
  expect((await upload())?.status).toBe(204);
});

test("an attached Docker restore can publish the replacement's retained outputs", async () => {
  const a = await restoreFixture();
  const {
    rows: [claim],
  } = await database().query<Job>(
    `update jobs set state='leased',lease_owner=$2,lease_epoch=1,lease_until='infinity',attempts=1
     where id=$1 returning id,sandbox_id,generation::text,lease_epoch::text`,
    [a.runnerJobId, randomUUID()],
  );
  if (!claim) throw new Error("Missing fixture runner claim.");
  const { requestId } = a.restore;
  expect(await a.poll()).toEqual(a.restore);
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed", machineId: "c".repeat(64) });
  await store.attachMachineRestore(a.owner, claim);
  await database().query("update jobs set state='done',lease_until=null,lease_owner=null where id=$1", [claim.id]);
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId });
  const signal = new AbortController().signal;
  const outputs = (body: ReadableStream<Uint8Array> | null) =>
    store.retainedOutputs(a.hostToken, a.installationId, requestId, body, signal);

  expect(await outputs(null)).toBe(202);
  expect(await outputs(new Response(await stoppedOutputArchive()).body)).toBe(204);
  expect((await database().query("select name from sandbox_outputs where sandbox_id=$1", [a.sandboxId])).rows).toEqual([
    { name: "late.txt" },
  ]);
  expect(await outputs(null)).toBe(204);
});

test("a mixed-release replica sees and can supersede a Docker upload before publication", async () => {
  const a = await boundStartup("create");
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
  const db = database();
  let transactions = 0;
  const probeAndAdmissionTransactions = 2;
  const uploading = createDockerHostStore(
    {
      query: sql.query,
      async transaction(work) {
        const result = await db.transaction((tx) => work({ query: (query, params) => tx.query(query, params) }));
        if (++transactions === probeAndAdmissionTransactions) {
          const legacy = await db.query(
            `update sandboxes set outputs_checked_at=outputs_checked_at + interval '1 microsecond'
             where id=$1 and outputs_checked_at is not null returning id`,
            [a.sandboxId],
          );
          expect(legacy.rows).toHaveLength(1);
        }
        return result;
      },
    },
    key,
  );
  const archive = await stoppedOutputArchive();
  const upload = (target: typeof store) =>
    target.retainedOutputs(
      a.hostToken,
      a.installationId,
      a.startup.requestId,
      new Response(archive).body,
      new AbortController().signal,
    );
  await expect(upload(uploading)).rejects.toBeInstanceOf(OutputCollectionError);
  expect((await db.query("select 1 from sandbox_outputs where sandbox_id=$1", [a.sandboxId])).rows).toHaveLength(0);
  expect(await upload(store)).toBe(204);
  expect(
    (
      await db.query(
        `select 1 from sandboxes where id=$1 and outputs_retained_generation=lifecycle_generation
        and outputs_published_scan=outputs_checked_at`,
        [a.sandboxId],
      )
    ).rows,
  ).toHaveLength(1);
});

test("stopped Docker output admission refuses application-secret taint before reading", async () => {
  const a = await boundStartup("create");
  await database().query("update sandboxes set application_secret_tainted=true where id=$1", [a.sandboxId]);
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
  expect(
    await store.retainedOutputs(a.hostToken, a.installationId, a.startup.requestId, null, new AbortController().signal),
  ).toBe(204);
});

test("expiry accepts only this installation's bound frozen startup machine, never arbitrary mailbox claims", async () => {
  const db = database();
  const a = await boundFixture(),
    b = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  const before = await lifecycle(a.sandboxId);
  await denied(store.expired(b.hostToken, b.installationId, { requestId: a.create.requestId }));
  await denied(store.expired(a.hostToken, randomUUID(), { requestId: a.create.requestId }));
  await denied(store.expired(a.hostToken, a.installationId, { requestId: randomUUID() }));
  const legacy = job();
  await seedUnboundJob(a.hostId, legacy);
  await denied(store.expired(a.hostToken, a.installationId, { requestId: legacy.requestId }));
  const stop = { requestId: randomUUID(), operation: "stop" as const };
  await queueMailboxStop(sql, key, a.actor, a.sandboxId, stop.requestId);
  await denied(store.expired(a.hostToken, a.installationId, { requestId: stop.requestId }));
  // Keep this identity/expiry test independent of cleanup priority; a failed stop is not a physical ACK.
  await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "failed" });
  // A stale generation and a corrupted frozen frame must not transition the target.
  const original = (
    await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
      `select input_enc from docker_host_jobs where request_id=$1`,
      [a.create.requestId],
    )
  ).rows[0];
  if (!original) throw Error("missing bound create");
  const { encryptSecret } = await import("@armada/core/server");
  const envelope = JSON.parse(await decryptSecret(original.input_enc, key));
  for (const request of [
    { ...envelope.job.request, generation: randomUUID() },
    { ...envelope.job.request, expiresAt: undefined },
    { ...envelope.job.request, sandboxId: b.sandboxId },
  ]) {
    await db.query(`update docker_host_jobs set input_enc=$2 where request_id=$1`, [
      a.create.requestId,
      await encryptSecret(JSON.stringify({ ...envelope, job: { ...envelope.job, request } }), key),
    ]);
    const current = await lifecycle(a.sandboxId);
    await denied(store.expired(a.hostToken, a.installationId, { requestId: a.create.requestId }));
    // Neither pending admission nor repair of an old failed ACK may let a
    // malformed identity fail the logical machine or block ordinary queue work.
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
    expect(await lifecycle(a.sandboxId)).toEqual(current);
    const later = await boundFixture(a);
    await store.submitMachineCreate(later.owner, later.request);
    await db.query(`update docker_host_jobs set outcome='failed',completed_at=now() where request_id=$1`, [
      later.create.requestId,
    ]);
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(legacy.requestId);
    expect(await lifecycle(a.sandboxId)).toEqual(current);
    expect((await lifecycle(later.sandboxId))?.status).toBe("failed");
    await db.query(`update docker_host_jobs set outcome=null,completed_at=null where request_id=$1`, [
      a.create.requestId,
    ]);
  }
  expect(before?.stopped_at).toBeNull();
  expect((await lifecycle(a.sandboxId))?.stopped_at).toBeNull();
});

async function failureJournal(sandboxId: string) {
  return (
    await database().query(
      `select from_status,actor,code,generation::text from public.sandbox_transitions
       where sandbox_id=$1 and to_status='failed'`,
      [sandboxId],
    )
  ).rows;
}

test.each(["create", "bootstrap"] as const)(
  "failed %s startup ACK or rejected admission fails logical startup without claiming a physical stop",
  async (operation) => {
    const db = database();
    for (const failure of ["ack", "historical-ack", "expiry", "removed-actor"] as const) {
      const a = await boundStartup(operation);
      const before = await lifecycle(a.sandboxId);
      if (failure === "ack")
        await store.complete(a.hostToken, a.installationId, { requestId: a.startup.requestId, outcome: "failed" });
      else {
        if (failure === "historical-ack")
          await db.query(`update docker_host_jobs set outcome='failed',completed_at=now() where request_id=$1`, [
            a.startup.requestId,
          ]);
        else if (failure === "expiry")
          await db.query(`update sandboxes set expires_at=now()-interval '1 second' where id=$1`, [a.sandboxId]);
        else await db.query(`delete from members where org_id=$1 and user_id=$2`, [a.owner.orgId, a.owner.userId]);
        expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
      }
      const failed = await lifecycle(a.sandboxId);
      if (!failed) throw Error("missing failed sandbox");
      expect(failed.status).toBe("failed");
      expect(failed?.status_reason).toBe("Docker sandbox startup failed. Check the host and retry with a new request.");
      expect(failed?.stopped_at).toBeNull();
      expect(Number(failed?.lifecycle_generation)).toBe(Number(before?.lifecycle_generation) + 1);
      await expect(a.authority.withSession(a.runtime.runtimeToken, a.runtime.epoch, async () => true)).rejects.toThrow(
        "runtime_enrolment_denied",
      );
      if (failure === "historical-ack") expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
      else await store.complete(a.hostToken, a.installationId, { requestId: a.startup.requestId, outcome: "failed" });
      expect(await lifecycle(a.sandboxId)).toEqual(failed);
      expect(await failureJournal(a.sandboxId)).toEqual([
        {
          from_status: before?.status,
          actor: "docker_host",
          code: "docker_startup_failed",
          generation: String(failed.lifecycle_generation),
        },
      ]);
      // Only a subsequent physical fact may populate stopped_at; failed is retained.
      const stop = { requestId: randomUUID(), operation: "stop" as const };
      await queueMailboxStop(sql, key, a.actor, a.sandboxId, stop.requestId);
      expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(stop.requestId);
      await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "completed" });
      const physicallyStopped = await lifecycle(a.sandboxId);
      if (!physicallyStopped) throw Error("missing failed sandbox");
      expect(physicallyStopped.status).toBe("failed");
      expect(physicallyStopped.stopped_at).not.toBeNull();
      expect(physicallyStopped.lifecycle_generation).toBe(failed.lifecycle_generation);
      await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
      expect(await lifecycle(a.sandboxId)).toEqual({ ...physicallyStopped, stop_requested_at: expect.anything() });
      const remove = { requestId: randomUUID(), operation: "delete" as const };
      await store.enqueueCleanup(a.actor, a.sandboxId, remove);
      await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
      expect((await lifecycle(a.sandboxId))?.status).toBe("deleted");
    }
  },
);

test("a host that could not fetch the image fails the sandbox in plain words; a reason never rides on success", async () => {
  for (const operation of ["create", "bootstrap"] as const) {
    const a = await boundStartup(operation);
    const startup = { requestId: a.startup.requestId };
    await denied(
      store.complete(a.hostToken, a.installationId, { ...startup, outcome: "completed", reason: "image_unavailable" }),
    );
    await store.complete(a.hostToken, a.installationId, { ...startup, outcome: "failed", reason: "image_unavailable" });
    const failed = await lifecycle(a.sandboxId);
    expect(failed?.status).toBe("failed");
    // Only a create fetches the image; another operation's reason is not believed.
    expect(failed?.status_reason).toBe(
      operation === "create"
        ? DOCKER_IMAGE_UNAVAILABLE_MESSAGE
        : "Docker sandbox startup failed. Check the host and retry with a new request.",
    );
  }
});

test("a disk-floor refusal rolls back with its journal and preserves its actionable reason on replay", async () => {
  const a = await boundStartup("create");
  const receipt = { requestId: a.startup.requestId, outcome: "failed", reason: "disk_full" } as const;
  const before = await lifecycle(a.sandboxId);
  const db = database();
  await db.query(
    "alter table public.sandbox_transitions add constraint refuse_startup_journal check (code <> 'docker_startup_failed') not valid",
  );
  try {
    await expect(store.complete(a.hostToken, a.installationId, receipt)).rejects.toMatchObject({
      cause: { constraint: "refuse_startup_journal" },
    });
    expect(await lifecycle(a.sandboxId)).toEqual(before);
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(receipt.requestId);
  } finally {
    await db.query("alter table public.sandbox_transitions drop constraint refuse_startup_journal");
  }
  await store.complete(a.hostToken, a.installationId, receipt);
  expect((await lifecycle(a.sandboxId))?.status_reason).toContain("10 GB floor");
});

test("a failed startup receipt cannot replace durable stop intent", async () => {
  const a = await boundStartup("create");
  await queueMailboxStop(sql, key, a.actor, a.sandboxId, randomUUID());
  const stopping = await lifecycle(a.sandboxId);
  expect(stopping?.status).toBe("stopping");
  await store.complete(a.hostToken, a.installationId, { requestId: a.startup.requestId, outcome: "failed" });
  expect(await lifecycle(a.sandboxId)).toEqual(stopping);
  expect(await failureJournal(a.sandboxId)).toEqual([]);
});

// Real migrated mailbox/ACK flow protects drain order and lost-revocation-response recovery.
test("uninstall drains a pre-cutover allocation through stop/delete ACKs before idempotent revocation", async () => {
  const placement = { sandboxId: randomUUID(), generation: randomUUID(), expiresAt: Date.UTC(2099, 0, 1) };
  const a = await boundFixture(undefined, placement);
  const requestId = randomUUID();
  const create = {
    operation: "create",
    request: { ...placement, image: job().request.image, ttlSeconds: 3600 },
  };
  await sql.query(
    `insert into docker_host_jobs(request_id,host_id,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,input_enc)
     select $1,$2,$3,user_id,epoch,'create',$4 from mcp_actor_epochs where org_id=$5 and user_id=$6`,
    [
      requestId,
      a.hostId,
      a.sandboxId,
      await encryptSecret(JSON.stringify({ bound: 1, job: create }), key),
      a.owner.orgId,
      a.owner.userId,
    ],
  );
  expect(await store.poll(a.hostToken, a.installationId)).toMatchObject({ ...create, requestId });
  await store.complete(a.hostToken, a.installationId, { requestId, outcome: "completed" });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
  const stop = await store.poll(a.hostToken, a.installationId, "2.27.0");
  expect(stop?.operation).toBe("stop");
  if (!stop) throw new Error("Missing stop");
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
  expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(stop.requestId);
  const stopReceipt = { requestId: stop.requestId, outcome: "completed" as const };
  const { faultingStore, failure } = failDockerJobCommit(stop.requestId, "completed");
  await expect(faultingStore.complete(a.hostToken, a.installationId, stopReceipt)).rejects.toMatchObject({
    cause: failure,
  });
  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "stopping", stopped_at: null });
  expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(stop.requestId);
  await store.complete(a.hostToken, a.installationId, stopReceipt);
  expect(await lifecycle(a.sandboxId)).toMatchObject({
    status: "stopped",
    stopped_at: expect.anything(),
    stop_requested_at: null,
  });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
  const remove = await store.poll(a.hostToken, a.installationId);
  expect(remove?.operation).toBe("delete");
  if (!remove) throw new Error("Missing delete");
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
  expect(
    (
      await database().query(
        `select from_status, to_status, actor, code from public.sandbox_transitions where sandbox_id=$1 order by id`,
        [a.sandboxId],
      )
    ).rows,
  ).toEqual([
    { from_status: "starting", to_status: "stopping", actor: "owner", code: "docker_stop_admitted" },
    { from_status: "stopping", to_status: "stopped", actor: "lifecycle_runner", code: "docker_stop_completed" },
    { from_status: "stopped", to_status: "deleted", actor: "delete_job", code: "docker_delete_completed" },
  ]);
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  await denied(store.poll(a.hostToken, a.installationId));
  await denied(store.unregister(a.hostToken, randomUUID()));
});

test("host drain waits for a delete admitted after the drain snapshot", async () => {
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "failed" });
  const remove = { requestId: randomUUID(), operation: "delete" as const };
  let interleave = true;
  const draining = createDockerHostStore(
    {
      ...sql,
      async transaction(work) {
        const result = await sql.transaction!(work);
        if (interleave) {
          interleave = false;
          await store.enqueueCleanup(a.owner, a.sandboxId, remove);
        }
        return result;
      },
    },
    key,
  );

  expect(await draining.unregister(a.hostToken, a.installationId)).toBe(false);
  expect(await store.poll(a.hostToken, a.installationId)).toMatchObject(remove);
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
});

test("a completed Docker delete proves exit and journals deletion of a failed sandbox", async () => {
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "failed" });
  const failed = await lifecycle(a.sandboxId);
  expect(failed).toMatchObject({ status: "failed", stopped_at: null });

  const remove = { requestId: randomUUID(), operation: "delete" as const };
  await store.enqueueCleanup(a.owner, a.sandboxId, remove);
  const deleteReceipt = { requestId: remove.requestId, outcome: "completed" as const };
  const db = database();
  await db.query(
    "alter table public.sandbox_transitions add constraint refuse_delete_journal check (code <> 'docker_delete_completed') not valid",
  );
  try {
    await expect(store.complete(a.hostToken, a.installationId, deleteReceipt)).rejects.toMatchObject({
      cause: { constraint: "refuse_delete_journal" },
    });
    expect(await lifecycle(a.sandboxId)).toEqual(failed);
    expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(remove.requestId);
  } finally {
    await db.query("alter table public.sandbox_transitions drop constraint refuse_delete_journal");
  }
  await store.complete(a.hostToken, a.installationId, deleteReceipt);

  expect(await lifecycle(a.sandboxId)).toMatchObject({ status: "deleted", stopped_at: expect.anything() });
  expect(
    (
      await database().query(
        `select from_status, to_status, generation::text from public.sandbox_transitions where sandbox_id=$1 and to_status='deleted'`,
        [a.sandboxId],
      )
    ).rows,
  ).toEqual([{ from_status: "failed", to_status: "deleted", generation: String(failed?.lifecycle_generation) }]);
});

test("a completed uninstall ends the drain, so its snapshots report the revoked host instead of a retry", async () => {
  const db = database();
  const a = await boundFixture(),
    snapshotId = randomUUID();
  await db.query(
    `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,request_hash,actor_epoch,issuer_epoch,generation,base_image,status,image_id,build_expires_at)
     values($1,$2,$3,$4,$5,'retired-ready','private','{}'::jsonb,$6,1,1,$7,'example/worker@sha256:${"a".repeat(64)}','ready',$8,now()+interval '1 hour')`,
    [
      snapshotId,
      a.actor.orgId,
      a.actor.userId,
      a.hostId,
      a.installationId,
      "b".repeat(64),
      randomUUID(),
      `sha256:${"c".repeat(64)}`,
    ],
  );
  await store.submitMachineCreate(a.owner, a.request);
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
  const stop = await store.poll(a.hostToken, a.installationId);
  if (stop?.operation !== "stop") throw new Error("Missing stop");
  await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "completed" });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
  const remove = await store.poll(a.hostToken, a.installationId);
  if (remove?.operation !== "delete") throw new Error("Missing delete");
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  // The uninstall completed: the host is revoked and no longer draining, so its snapshot is not "Host draining".
  expect((await store.list(a.actor)).find((host) => host.id === a.hostId)?.state).toBe("revoked");
  expect(
    (await db.query<{ draining_at: unknown }>("select draining_at from public.docker_hosts where id=$1", [a.hostId]))
      .rows[0]?.draining_at,
  ).toBeNull();
  expect(
    (
      await db.query<{ host_draining: boolean }>(
        `select ${SNAPSHOT_COLUMNS} from public.docker_snapshots s join public.docker_hosts h on h.id=s.host_id where s.id=$1`,
        [snapshotId],
      )
    ).rows[0]?.host_draining,
  ).toBe(false);
});

test("retention cleanup authenticates the bound host and permanently fences runtime idempotently", async () => {
  const a = await boundStartup("bootstrap");
  await denied(store.cleaned(a.hostToken, randomUUID(), { requestId: a.startup.requestId }));
  await denied(store.cleaned(a.hostToken, a.installationId, { requestId: randomUUID() }));
  const before = await lifecycle(a.sandboxId);
  const cleanup = { requestId: a.startup.requestId, cleanupReason: "disk_pressure" as const };
  const { faultingStore, failure } = failDockerObservationCommit(a.sandboxId, cleanup.cleanupReason);
  await expect(faultingStore.cleaned(a.hostToken, a.installationId, cleanup)).rejects.toMatchObject({
    cause: failure,
  });
  expect(await lifecycle(a.sandboxId)).toEqual(before);
  expect(await dockerJournal(a.sandboxId, cleanup.cleanupReason)).toEqual([]);
  await store.cleaned(a.hostToken, a.installationId, cleanup);
  const deleted = await lifecycle(a.sandboxId);
  expect(deleted?.status).toBe("deleted");
  expect(deleted?.status_reason).toBe("disk_pressure");
  await expect(a.authority.withSession(a.runtime.runtimeToken, a.runtime.epoch, async () => true)).rejects.toThrow(
    "runtime_enrolment_denied",
  );
  await store.cleaned(a.hostToken, a.installationId, { requestId: a.startup.requestId });
  expect(await lifecycle(a.sandboxId)).toEqual(deleted);
  expect(Number(deleted?.lifecycle_generation)).toBe(Number(before?.lifecycle_generation) + 1);
  expect(await dockerJournal(a.sandboxId, "disk_pressure")).toEqual([
    { from_status: before?.status, to_status: "deleted", generation: deleted?.lifecycle_generation },
  ]);
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
});

test("runtime self completion needs no child access and retries failed stop/delete without retaining its home", async () => {
  const db = database();
  const a = await boundStartup("bootstrap");
  await store.complete(a.hostToken, a.installationId, { requestId: a.startup.requestId, outcome: "completed" });
  await db.query("update public.sandboxes set status='ready' where id=$1", [a.sandboxId]);
  const finishState = async () =>
    (
      await db.query<{ lifecycle_generation: number; stop_generation: number }>(
        `select status, status_reason, preservation_note, lifecycle_generation, stop_generation, stop_requested_at
         from public.sandboxes where id=$1`,
        [a.sandboxId],
      )
    ).rows[0];
  const finishJournal = async () =>
    (
      await db.query(
        `select from_status, to_status, generation, code from public.sandbox_transitions
         where sandbox_id=$1 and actor='finish'`,
        [a.sandboxId],
      )
    ).rows;
  const initial = (await finishState())!;
  for (const [statement, expected] of [
    ["public.sandbox_transition(", { message: "Injected finish failure" }],
    [
      "select * from public.docker_host_jobs where request_id",
      { message: "Docker host unavailable", cause: { message: "Injected finish failure" } },
    ],
  ] as const) {
    await expect(
      sql.transaction!((tx) =>
        requestSandboxFinish(
          {
            query: (query, params) => {
              if (query.includes(statement)) throw new Error("Injected finish failure");
              return tx.query(query, params);
            },
          },
          key,
          a.sandboxId,
          a.owner.userId,
        ),
      ),
    ).rejects.toMatchObject(expected);
    expect(await finishState()).toEqual(initial);
    expect(await finishJournal()).toEqual([]);
    expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
  }
  const generation = (
    await db.query<{ mcp_generation: number }>("select mcp_generation from public.sandboxes where id=$1", [a.sandboxId])
  ).rows[0]!.mcp_generation;
  const token = selfFinishToken(key, {
    sandboxId: a.sandboxId,
    ownerId: a.owner.userId,
    epoch: a.runtime.epoch,
    generation,
  });
  const services = createSandboxAccessServices({
    sql,
    encryptionKey: key,
    scopedMcpUrl: "https://armada.example/api/v1/orchestrator-tools/mcp",
    // This stand-in runtime never answers; output capture has its own tests (docker-outputs).
    outputs: { reader: () => ({}) },
    providers: {
      resolve: async () => {
        throw Error("No provider I/O on self report");
      },
    },
    connections: undefined,
  });
  const response = await services.scopedToolsRoute(
    new Request("https://armada.example/api/v1/orchestrator-tools/finish", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    }),
  );
  expect(response?.status).toBe(200);
  const report = (await response?.json()) as { result: { preservationNote: string } };
  expect(publishedResponse("orchestrator-tools/finish").safeParse(report).success).toBe(true);
  expect(report.result.preservationNote).toContain("Unpushed Git work is not preserved");
  const stopping = (await finishState())!;
  expect(Number(stopping.lifecycle_generation)).toBe(Number(initial.lifecycle_generation) + 1);
  expect(stopping.stop_generation).toBe(initial.stop_generation);
  expect(await finishJournal()).toEqual([
    {
      from_status: "ready",
      to_status: "stopping",
      generation: stopping.lifecycle_generation,
      code: "agent_finished",
    },
  ]);
  const stop = await store.poll(a.hostToken, a.installationId);
  expect(stop?.operation).toBe("stop");
  if (!stop) throw Error("Missing stop");
  await store.complete(a.hostToken, a.installationId, { requestId: stop.requestId, outcome: "failed" });
  const retry = createFinishedDockerCleanup(sql, key);
  expect(await retry.reconcileOne(new AbortController().signal)).toBe(true);
  const retryStop = await store.poll(a.hostToken, a.installationId);
  expect(retryStop?.operation).toBe("stop");
  if (!retryStop) throw Error("Missing retry stop");
  // A racing host expiry must not cancel the explicit immediate-cleanup intent.
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
  expect((await lifecycle(a.sandboxId))?.status_reason).toBe("agent_finished");
  await store.complete(a.hostToken, a.installationId, { requestId: retryStop.requestId, outcome: "completed" });
  const remove = await store.poll(a.hostToken, a.installationId);
  expect(remove?.operation).toBe("delete");
  if (!remove) throw Error("Missing immediate cleanup");
  await store.complete(a.hostToken, a.installationId, { requestId: retryStop.requestId, outcome: "completed" });
  expect((await store.poll(a.hostToken, a.installationId))?.requestId).toBe(remove.requestId);
  await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "failed" });
  // Persistent retry deadline prevents a hot loop; fake the DB clock at the decision boundary.
  expect(await retry.reconcileOne(new AbortController().signal)).toBe(false);
  await db.query("update public.sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [a.sandboxId]);
  expect(await retry.reconcileOne(new AbortController().signal)).toBe(true);
  const retryDelete = await store.poll(a.hostToken, a.installationId);
  expect(retryDelete?.operation).toBe("delete");
  if (!retryDelete) throw Error("Missing retry delete");
  await store.complete(a.hostToken, a.installationId, { requestId: retryDelete.requestId, outcome: "completed" });
  const saved = (
    await db.query<{ status: string; preservation_note: string }>(
      "select status,preservation_note from public.sandboxes where id=$1",
      [a.sandboxId],
    )
  ).rows[0];
  expect(saved?.status).toBe("deleted");
  expect(saved?.preservation_note).toBe(report.result.preservationNote);
  expect(await store.poll(a.hostToken, a.installationId)).toBeNull();
});

test("a draining host is listed as draining, not online, and stays draining however old the drain is", async () => {
  const db = database();
  const a = await fixture();
  await store.poll(a.hostToken, a.installationId, "2.48.0");
  expect((await store.list(a.actor)).find((host) => host.id === a.hostId)?.state).toBe("online");
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [a.hostId]);
  expect((await store.list(a.actor)).find((host) => host.id === a.hostId)?.state).toBe("draining");
  // A drain has no deadline: an interrupted uninstall keeps the host out of placement until it completes.
  await db.query(`update public.docker_hosts set draining_at=now()-interval '2 hours' where id=$1`, [a.hostId]);
  expect((await store.list(a.actor)).find((host) => host.id === a.hostId)?.state).toBe("draining");
});

test("retention belongs to the adding member and reports physical cleanup deadlines, not server estimates", async () => {
  const db = database();
  const a = await fixture();
  await denied(store.setRetention({ ...a.actor, userId: a.backupAdmin }, a.hostId, 0));
  await db.query("update members set role='member' where org_id=$1 and user_id=$2", [a.actor.orgId, a.actor.userId]);
  await expect(store.setRetention(a.actor, a.hostId, 0)).resolves.toEqual({ retentionSeconds: 0 });
  const deadline = "2026-11-20T12:00:00.000Z";
  expect(
    await store.retentionForHost(a.hostToken, a.installationId, { retentionSeconds: 86400, nextCleanupAt: deadline }),
  ).toEqual({ hostId: a.hostId, retentionSeconds: 0 });
  let host = (await store.list(a.actor)).find((h) => h.id === a.hostId)!;
  expect(host.retentionSeconds).toBe(86400);
  expect(host.nextCleanupAt).toBeNull();
  await store.retentionForHost(a.hostToken, a.installationId, { retentionSeconds: 0, nextCleanupAt: deadline });
  host = (await store.list(a.actor)).find((h) => h.id === a.hostId)!;
  expect(host.nextCleanupAt).toBe(deadline);
  await store.setRetention(a.actor, a.hostId, 3600);
  expect((await store.list(a.actor)).find((h) => h.id === a.hostId)!.nextCleanupAt).toBeNull();
  expect(() => store.setRetention(a.actor, a.hostId, -1)).toThrow();
});

test("reported Docker filesystem bytes gate new reservations below 10 GB and unknown older hosts stay compatible", async () => {
  const a = await fixture();
  for (const diskFreeBytes of [null, 10_000_000_000, 0, 9_999_999_999]) {
    await store.poll(
      a.hostToken,
      a.installationId,
      "2.48.0",
      false,
      undefined,
      undefined,
      diskFreeBytes,
      diskFreeBytes,
    );
    expect((await store.list(a.actor))[0]?.diskFreeBytes).toBe(diskFreeBytes);
    expect((await store.list(a.actor))[0]?.stoppedSandboxBytes).toBe(diskFreeBytes);
    const admission = admitDockerDisk(sql, a.hostId);
    if (diskFreeBytes !== null && diskFreeBytes < 10_000_000_000)
      await expect(admission).rejects.toThrow("10 GB floor");
    else await expect(admission).resolves.toBeUndefined();
  }
});

test("retired registrants retain only bound reconciliation and admin cleanup", async () => {
  const db = database();
  for (const retired of ["removed", "revoked"] as const) {
    const a = await boundStartup("bootstrap");
    await store.complete(a.hostToken, a.installationId, { requestId: a.startup.requestId, outcome: "completed" });
    if (retired === "removed") {
      await db.query("delete from members where org_id=$1 and user_id=$2", [a.actor.orgId, a.actor.userId]);
    } else {
      await store.revoke(a.actor, a.hostId);
    }
    await denied(store.poll(a.hostToken, a.installationId));
    // The HTTP poll composes these policy endpoints around mailbox delivery.
    await expect(
      store.retentionForHost(a.hostToken, a.installationId, { retentionSeconds: 86400, nextCleanupAt: null }),
    ).resolves.toEqual({ hostId: a.hostId, retentionSeconds: undefined });
    await expect(store.limitsForHost(a.hostToken, a.installationId)).resolves.toBeUndefined();
    await denied(store.expired(a.hostToken, randomUUID(), { requestId: a.startup.requestId }));
    await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.startup.requestId });
    expect((await lifecycle(a.sandboxId))?.status).toBe("stopped");
    const remove = { requestId: randomUUID(), operation: "delete" as const };
    await store.enqueueCleanup({ userId: a.backupAdmin, orgId: a.actor.orgId }, a.sandboxId, remove);
    expect((await store.poll(a.hostToken, a.installationId))?.operation).toBe("delete");
    await store.complete(a.hostToken, a.installationId, { requestId: remove.requestId, outcome: "completed" });
    await store.cleaned(a.hostToken, a.installationId, { requestId: a.startup.requestId });
    expect((await lifecycle(a.sandboxId))?.status).toBe("deleted");
    expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  }
});

test("revoking a host retires a queued create without claiming physical cleanup and releases its capacity slot", async () => {
  const db = database();
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  expect((await store.list(a.actor))[0]?.running).toBe(1);
  await store.revoke(a.actor, a.hostId);
  const failed = await lifecycle(a.sandboxId);
  expect(failed?.status).toBe("failed");
  expect(failed?.status_reason).toBe(DOCKER_LAUNCH_FAILURE_MESSAGES.hostUnavailable);
  // Revocation is server intent, never proof that the machine stopped.
  expect(failed?.stopped_at).toBeNull();
  expect(failed?.deleted_at).toBeNull();
  expect(Number(failed?.lifecycle_generation)).toBeGreaterThan(1);
  expect((await store.list(a.actor))[0]?.running).toBe(0);
  expect(
    (
      await db.query<{ outcome: string; cancelled_at: unknown }>(
        "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
        [a.create.requestId],
      )
    ).rows[0],
  ).toMatchObject({ outcome: "failed" });
  expect(
    (
      await db.query<{ cancelled_at: unknown }>("select cancelled_at from docker_host_jobs where request_id=$1", [
        a.create.requestId,
      ])
    ).rows[0]?.cancelled_at,
  ).not.toBeNull();
  // The retired startup cannot be retried on the revoked host.
  await denied(store.submitMachineCreate(a.owner, a.request));
  await denied(store.poll(a.hostToken, a.installationId));
});

test("a late completed create ACK after cancellation restores the reservation instead of losing compute", async () => {
  const db = database();
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await store.revoke(a.actor, a.hostId);
  expect((await store.list(a.actor))[0]?.running).toBe(0);
  // The host may have executed the job before the revoke fenced its next poll.
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  expect(
    (
      await db.query<{ outcome: string; cancelled_at: unknown }>(
        "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
        [a.create.requestId],
      )
    ).rows[0],
  ).toEqual({ outcome: "completed", cancelled_at: null });
  expect((await store.list(a.actor))[0]?.running).toBe(1);
  // The sandbox stays failed until a physical fact proves the machine stopped;
  // the restored reservation is what keeps capacity honest in the meantime.
  expect((await lifecycle(a.sandboxId))?.status).toBe("failed");
  expect((await lifecycle(a.sandboxId))?.stopped_at).toBeNull();
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.create.requestId });
  expect((await store.list(a.actor))[0]?.running).toBe(0);
  expect((await lifecycle(a.sandboxId))?.stopped_at).not.toBeNull();
});

test("a cancelled job's first host receipt is terminal and a later conflicting receipt is denied", async () => {
  const db = database();
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await store.revoke(a.actor, a.hostId);
  // The host reports the machine fact it actually observed: the create failed.
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "failed" });
  expect(
    (
      await db.query<{ outcome: string; cancelled_at: unknown }>(
        "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
        [a.create.requestId],
      )
    ).rows[0],
  ).toEqual({ outcome: "failed", cancelled_at: null });
  // A duplicate or late completed receipt must not rewrite the first terminal fact.
  await denied(store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" }));
  expect(
    (
      await db.query<{ outcome: string; cancelled_at: unknown }>(
        "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
        [a.create.requestId],
      )
    ).rows[0],
  ).toEqual({ outcome: "failed", cancelled_at: null });
  // A failed create is not physical proof the container stopped, so its slot
  // stays reserved until a stop/delete/expiry fact releases it.
  expect((await store.list(a.actor))[0]?.running).toBe(1);
  await reportDockerExpiry(sql, key, a.hostToken, a.installationId, { requestId: a.create.requestId });
  expect((await store.list(a.actor))[0]?.running).toBe(0);
});

test("a cancelled snapshot build rejects a late completed receipt instead of claiming an unpublished image", async () => {
  const db = database();
  const a = await fixture();
  const snapshotId = randomUUID(),
    ownerId = a.memberId,
    generation = randomUUID(),
    requestId = randomUUID();
  await db.query(
    `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,
      request_hash,actor_epoch,issuer_epoch,generation,base_image,build_expires_at,status)
     values($1,$2,$3,$4,$5,'queued-build','private','{}'::jsonb,$6,1,1,$7,$8,now()+interval '1 hour','building')`,
    [
      snapshotId,
      a.actor.orgId,
      ownerId,
      a.hostId,
      a.installationId,
      "a".repeat(64),
      generation,
      `example/worker@sha256:${"a".repeat(64)}`,
    ],
  );
  const job = {
    requestId,
    operation: "buildSnapshot" as const,
    request: {
      sandboxId: snapshotId,
      generation,
      image: `example/worker@sha256:${"a".repeat(64)}`,
      ttlSeconds: 3600,
    },
    build: {
      id: snapshotId,
      ownerId,
      visibility: "private" as const,
      config: {},
      token: "fixture-token",
      armadaVersion: "2.49.6",
    },
  };
  await db.query(
    `insert into public.docker_host_jobs(request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,
      bound_actor_epoch,bound_operation,snapshot_id) values($1,$2,$3,null,$4,1,'buildSnapshot',$5)`,
    [requestId, a.hostId, await encryptSecret(JSON.stringify({ bound: 1, job }), key), ownerId, snapshotId],
  );
  await store.revoke(a.actor, a.hostId);
  await denied(
    store.complete(a.hostToken, a.installationId, {
      requestId,
      outcome: "completed",
      imageId: `sha256:${"b".repeat(64)}`,
    }),
  );
  expect(
    (
      await db.query<{ outcome: string; cancelled_at: unknown }>(
        "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
        [requestId],
      )
    ).rows[0],
  ).toEqual({ outcome: "failed", cancelled_at: expect.anything() });
  expect(
    (
      await db.query<{ status: string; image_id: string | null }>(
        "select status,image_id from docker_snapshots where id=$1",
        [snapshotId],
      )
    ).rows[0],
  ).toEqual({ status: "failed", image_id: null });
});

test("removing the host owner retires queued startup before the denied poll", async () => {
  const db = database();
  const a = await boundFixture();
  await store.submitMachineCreate(a.owner, a.request);
  await db.query("delete from members where org_id=$1 and user_id=$2", [a.actor.orgId, a.actor.userId]);
  await denied(store.poll(a.hostToken, a.installationId));
  const failed = await lifecycle(a.sandboxId);
  expect(failed?.status).toBe("failed");
  expect(await failureJournal(a.sandboxId)).toEqual([
    {
      from_status: "starting",
      actor: "docker_host",
      code: "docker_host_retired",
      generation: String(failed?.lifecycle_generation),
    },
  ]);
  expect(failed?.status_reason).toBe(DOCKER_LAUNCH_FAILURE_MESSAGES.hostUnavailable);
  expect(failed?.stopped_at).toBeNull();
  expect((await store.list({ ...a.actor, userId: a.backupAdmin }))[0]?.running).toBe(0);
});

test("revocation rolls back queued startups, snapshot and mailbox cancellation together before commit", async () => {
  const db = database();
  const a = await boundFixture();
  const second = await boundFixture(a);
  await store.submitMachineCreate(a.owner, a.request);
  await store.submitMachineCreate(second.owner, second.request);
  const snapshotId = randomUUID(),
    ownerId = a.memberId,
    generation = randomUUID(),
    requestId = randomUUID();
  await db.query(
    `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,
      request_hash,actor_epoch,issuer_epoch,generation,base_image,build_expires_at,status)
     values($1,$2,$3,$4,$5,'queued-build','private','{}'::jsonb,$6,1,1,$7,$8,now()+interval '1 hour','building')`,
    [
      snapshotId,
      a.actor.orgId,
      ownerId,
      a.hostId,
      a.installationId,
      "a".repeat(64),
      generation,
      `example/worker@sha256:${"a".repeat(64)}`,
    ],
  );
  const job = {
    requestId,
    operation: "buildSnapshot" as const,
    request: {
      sandboxId: snapshotId,
      generation,
      image: `example/worker@sha256:${"a".repeat(64)}`,
      ttlSeconds: 3600,
    },
    build: {
      id: snapshotId,
      ownerId,
      visibility: "private" as const,
      config: {},
      token: "fixture-token",
      armadaVersion: "2.49.6",
    },
  };
  await db.query(
    `insert into public.docker_host_jobs(request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,
      bound_actor_epoch,bound_operation,snapshot_id) values($1,$2,$3,null,$4,1,'buildSnapshot',$5)`,
    [requestId, a.hostId, await encryptSecret(JSON.stringify({ bound: 1, job }), key), ownerId, snapshotId],
  );
  const { faultingStore, failure } = failDockerJobCommit(a.create.requestId, "failed");
  await expect(faultingStore.revoke(a.actor, a.hostId)).rejects.toMatchObject({ cause: failure });
  for (const startup of [a, second]) {
    expect((await lifecycle(startup.sandboxId))?.status).toBe("starting");
    expect(await failureJournal(startup.sandboxId)).toEqual([]);
  }
  expect(
    (
      await db.query(`select count(*)::int as pending from docker_host_jobs where host_id=$1 and outcome is null`, [
        a.hostId,
      ])
    ).rows[0],
  ).toEqual({ pending: 3 });
  expect((await db.query("select status from docker_snapshots where id=$1", [snapshotId])).rows[0]).toEqual({
    status: "building",
  });
  expect((await db.query("select revoked_at from docker_hosts where id=$1", [a.hostId])).rows[0]).toEqual({
    revoked_at: null,
  });

  await store.revoke(a.actor, a.hostId);
  for (const startup of [a, second]) {
    expect((await lifecycle(startup.sandboxId))?.status).toBe("failed");
    expect(await failureJournal(startup.sandboxId)).toHaveLength(1);
  }
  expect(
    (
      await db.query<{ status: string; failure_reason: string | null }>(
        "select status,failure_reason from docker_snapshots where id=$1",
        [snapshotId],
      )
    ).rows[0],
  ).toEqual({ status: "failed", failure_reason: "Host retired before snapshot publication." });
  const saved = (
    await db.query<{ outcome: string; cancelled_at: unknown }>(
      "select outcome,cancelled_at from docker_host_jobs where request_id=$1",
      [requestId],
    )
  ).rows[0];
  expect(saved?.outcome).toBe("failed");
  expect(saved?.cancelled_at).not.toBeNull();
});

test("unregistering with a queued snapshot build persists the retirement reason the constraint admits", async () => {
  const db = database();
  const a = await fixture(),
    snapshotId = randomUUID();
  await db.query(
    `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,request_hash,actor_epoch,issuer_epoch,generation,base_image,build_expires_at)
     values($1,$2,$3,$4,$5,'retired-build','private','{}'::jsonb,$6,1,1,$7,'example/worker@sha256:${"a".repeat(64)}',now()+interval '1 hour')`,
    [snapshotId, a.actor.orgId, a.actor.userId, a.hostId, a.installationId, "b".repeat(64), randomUUID()],
  );
  await db.query("delete from members where org_id=$1 and user_id=$2", [a.actor.orgId, a.actor.userId]);
  expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  expect(
    (
      await db.query<{ status: string; failure_reason: string }>(
        "select status,failure_reason from public.docker_snapshots where id=$1",
        [snapshotId],
      )
    ).rows[0],
  ).toEqual({ status: "failed", failure_reason: "Host retired before snapshot publication." });
});

test("retirement cancels undispatchable startup without claiming physical cleanup", async () => {
  const db = database();
  for (const retired of ["removed", "revoked"] as const) {
    const a = await boundFixture();
    await store.submitMachineCreate(a.owner, a.request);
    if (retired === "removed") {
      await db.query("delete from members where org_id=$1 and user_id=$2", [a.actor.orgId, a.actor.userId]);
    } else {
      await store.revoke(a.actor, a.hostId);
    }
    expect(await store.unregister(a.hostToken, a.installationId)).toBe(false);
    expect((await lifecycle(a.sandboxId))?.status).not.toBe("deleted");
    await store.cleaned(a.hostToken, a.installationId, { requestId: a.create.requestId });
    // Active registrants may have admitted a stop during drain; acknowledge it.
    const cleanup = await db.query<{ request_id: string }>(
      "select request_id from docker_host_jobs where host_id=$1 and outcome is null",
      [a.hostId],
    );
    for (const job of cleanup.rows)
      await store.complete(a.hostToken, a.installationId, { requestId: job.request_id, outcome: "completed" });
    expect(await store.unregister(a.hostToken, a.installationId)).toBe(true);
  }
});

test("poll reports every generation with pending start intent, and per-generation deadlines persist", async () => {
  const db = database();
  const a = await boundFixture();
  const second = await boundFixture(a);
  // Both creates are acknowledged; the second sandbox is then stopped and resumed.
  await store.submitMachineCreate(a.owner, a.request);
  await store.submitMachineCreate(a.owner, second.request);
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  await store.complete(a.hostToken, a.installationId, { requestId: second.create.requestId, outcome: "completed" });
  const stop = { requestId: randomUUID(), operation: "stop" as const };
  await queueMailboxStop(sql, key, a.owner, second.sandboxId, stop.requestId);
  // Resume admission sets the sandbox starting, then issues a fresh ticket and enqueues.
  await db.query("update public.sandboxes set status='starting',stopped_at=null,stop_requested_at=null where id=$1", [
    second.sandboxId,
  ]);
  const ticket = await (await import("../src/runtime-enrolment.ts"))
    .createRuntimeEnrolments(sql, key, {
      allowDockerIssue: true,
    })
    .issue({ sandboxId: second.sandboxId, ownerId: second.owner.userId, configuration: {} });
  await seedHistoricalBootstrap(second, ticket.enrolmentToken);
  // Cleanup is served first, but the resume behind it is still reported as pending intent.
  expect((await store.poll(a.hostToken, a.installationId))?.operation).toBe("stop");
  expect(await store.pendingStartsForHost(a.hostToken, a.installationId)).toEqual([
    { sandboxId: second.sandboxId, generation: second.generation },
  ]);
  // A host-reported per-generation deadline is persisted against that generation, not the host clock.
  const deadline = "2026-11-20T12:00:00.000Z";
  await store.retentionForHost(a.hostToken, a.installationId, {
    retentionSeconds: 3600,
    nextCleanupAt: deadline,
    deadlines: [{ sandboxId: a.sandboxId, generation: a.generation, deadline }],
  });
  const saved = await db.query<{ docker_retention_deadline: Date | string | null }>(
    "select docker_retention_deadline from public.sandboxes where id=$1",
    [a.sandboxId],
  );
  expect(new Date(saved.rows[0]!.docker_retention_deadline!).toISOString()).toBe(deadline);
  const other = await db.query<{ docker_retention_deadline: Date | string | null }>(
    "select docker_retention_deadline from public.sandboxes where id=$1",
    [second.sandboxId],
  );
  expect(other.rows[0]!.docker_retention_deadline).toBeNull();
});

test("a host that reports no obligation clears its stale per-generation deadline", async () => {
  const db = database();
  const a = await boundFixture();
  const deadline = "2026-11-20T12:00:00.000Z";
  await store.retentionForHost(a.hostToken, a.installationId, {
    retentionSeconds: 3600,
    nextCleanupAt: deadline,
    deadlines: [{ sandboxId: a.sandboxId, generation: a.generation, deadline }],
  });
  expect(
    (await db.query("select docker_retention_deadline from public.sandboxes where id=$1", [a.sandboxId])).rows[0],
  ).toMatchObject({ docker_retention_deadline: expect.anything() });
  // The host resumed or lost the obligation; it reports an empty set (not undefined).
  await store.retentionForHost(a.hostToken, a.installationId, {
    retentionSeconds: 3600,
    nextCleanupAt: null,
    deadlines: [],
  });
  expect(
    (await db.query("select docker_retention_deadline from public.sandboxes where id=$1", [a.sandboxId])).rows[0],
  ).toEqual({ docker_retention_deadline: null });
});

// #2560: the host's own facts date a Docker launch; a ticket issued before the host acts records no machine start.
test("docker launch stages come from host pickup and create ACK, not from ticket issuance", async () => {
  const a = await boundFixture();
  const { createRuntimeEnrolments } = await import("../src/runtime-enrolment.ts");
  const stages = async () =>
    (
      await database().query<{ activation: string; stage: string }>(
        "select activation::text,stage from public.sandbox_launch_stages where sandbox_id=$1 order by stage",
        [a.sandboxId],
      )
    ).rows.map((row) => `${row.activation}:${row.stage}`);
  expect(await stages()).toEqual(["1:accepted"]);
  await store.submitMachineCreate(a.owner, a.request);
  expect(await stages()).toEqual(["1:accepted"]);
  expect((await store.poll(a.hostToken, a.installationId))?.operation).toBe("create");
  expect(await stages()).toEqual(["1:accepted", "1:provider_claimed"]);
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  expect(await stages()).toEqual(["1:accepted", "1:machine_started", "1:provider_claimed"]);
  // A later activation (resume) whose ticket is issued before the host restores the machine.
  await database().query("update public.sandboxes set status='stopped',stopped_at=now() where id=$1", [a.sandboxId]);
  await database().query("update public.sandboxes set status='starting',stopped_at=null where id=$1", [a.sandboxId]);
  await createRuntimeEnrolments(sql, key, { allowDockerIssue: true }).issue({
    sandboxId: a.sandboxId,
    ownerId: a.owner.userId,
    configuration: {},
  });
  expect((await stages()).filter((stage) => stage.startsWith("2:"))).toEqual(["2:accepted"]);
  // A replayed ACK of the launch's create job is idempotent and stays on the launch: it never dates the resume.
  await store.complete(a.hostToken, a.installationId, { requestId: a.create.requestId, outcome: "completed" });
  expect((await stages()).filter((stage) => stage.startsWith("2:"))).toEqual(["2:accepted"]);
  expect((await stages()).filter((stage) => stage.startsWith("1:"))).toEqual([
    "1:accepted",
    "1:machine_started",
    "1:provider_claimed",
  ]);
});

test("Docker Machine bindings survive a lost allocation reply and fence replacements by installation", async () => {
  const scope = { hostId: randomUUID(), installationId: randomUUID(), deploymentId: "test" };
  const predecessor = { sandboxId: randomUUID(), generation: 41 };
  const replacement = { ...predecessor, generation: 42 };
  const rollback = { ...predecessor, generation: 40 };
  await expect(
    database().transaction(async (tx) => {
      await createDockerMachineGenerationBindings(tx, scope).bind(rollback);
      throw new Error("Interrupted before commit");
    }),
  ).rejects.toThrow("Interrupted before commit");
  const bindings = createDockerMachineGenerationBindings(sql, scope);
  expect(await bindings.lookup(rollback)).toBeUndefined();

  const first = await database().transaction((tx) =>
    createDockerMachineGenerationBindings(tx, scope).bind(predecessor),
  );
  expect(await bindings.bind(predecessor)).toBe(first);
  const next = await bindings.bind(replacement);
  expect(next).not.toBe(first);
  expect(await bindings.lookup(predecessor)).toBe(first);
  expect(await bindings.lookup(replacement)).toBe(next);

  const other = createDockerMachineGenerationBindings(sql, { ...scope, installationId: randomUUID() });
  await expect(other.bind(replacement)).rejects.toThrow("bound to another host installation");
  expect(await other.lookup(replacement)).toBeUndefined();
});

test("Docker Machine inventory projects only exact scoped report bindings", async () => {
  const { hostId, installationId, hostToken } = await fixture();
  const serverUrl = "https://inventory.example.test/path";
  const deploymentId = `https://inventory.example.test/${hostId}/${installationId}`;
  const incarnation = { sandboxId: randomUUID(), generation: 23 };
  const generation = await createDockerMachineGenerationBindings(sql, { hostId, installationId }).bind(incarnation);
  const reported = {
    sandboxId: incarnation.sandboxId,
    generation,
    machineId: "a".repeat(64),
    createdAt: new Date(0),
    deploymentId,
    containerName: `armada-${installationId}-${hostId}-${incarnation.sandboxId}-${generation}`,
  };
  const unboundGeneration = randomUUID();
  const report = [
    { ...reported, deploymentId: "foreign" },
    { ...reported, containerName: "renamed" },
    {
      ...reported,
      generation: unboundGeneration,
      containerName: reported.containerName.replace(generation, unboundGeneration),
    },
    reported,
  ];

  const inventory = store.machineInventory(hostToken, installationId, serverUrl, report);
  expect(await Array.fromAsync(inventory.listInventory())).toEqual([
    { ...incarnation, machineId: reported.machineId, deploymentId, createdAt: reported.createdAt },
  ]);
});

test.each(["hostId", "installationId"] as const)(
  "Docker Machine inventory refuses a binding with a different %s even under rewritten report labels",
  async (scopeKey) => {
    const reporting = await fixture();
    const serverUrl = "https://inventory.example.test";
    const { hostId, installationId, hostToken } = reporting;
    const incarnation = { sandboxId: randomUUID(), generation: 23 };
    const bindings = createDockerMachineGenerationBindings(sql, { hostId, installationId, [scopeKey]: randomUUID() });
    const generation = await bindings.bind(incarnation);
    const inventory = store.machineInventory(hostToken, installationId, serverUrl, [
      {
        sandboxId: incarnation.sandboxId,
        generation,
        machineId: "a".repeat(64),
        createdAt: new Date(0),
        deploymentId: `${serverUrl}/${hostId}/${installationId}`,
        containerName: `armada-${installationId}-${hostId}-${incarnation.sandboxId}-${generation}`,
      },
    ]);
    expect(await Array.fromAsync(inventory.listInventory())).toEqual([]);
  },
);

test("Docker Machine inventory refuses credentials from a different installation", async () => {
  const { hostToken } = await fixture();
  const { installationId } = await fixture();
  const inventory = store.machineInventory(hostToken, installationId, "https://inventory.example.test", []);
  await denied(Array.fromAsync(inventory.listInventory()));
});

test("only the service role can read and insert Docker Machine bindings, and cannot rewrite them", async () => {
  const { rows } = await database().query(
    `select role, has_table_privilege(role,'public.docker_machine_bindings','SELECT') as readable,
            has_table_privilege(role,'public.docker_machine_bindings','INSERT') as insertable,
            has_table_privilege(role,'public.docker_machine_bindings','UPDATE,DELETE,TRUNCATE') as rewritable
     from unnest(array['anon','authenticated','service_role']) as roles(role) order by role`,
  );
  expect(rows).toEqual([
    { role: "anon", readable: false, insertable: false, rewritable: false },
    { role: "authenticated", readable: false, insertable: false, rewritable: false },
    { role: "service_role", readable: true, insertable: true, rewritable: false },
  ]);
});
