import { expect, test } from "bun:test";
import { ProviderError, type Sql, VaultError } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { retainedSandbox, sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { archivedBoat, runBoatStop } from "./boat-stop.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runClaimedStop } from "./stop-job.fixture.ts";
import { bunLikeSql, ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

// Lifecycle deadlines come from the database clock. Tests bound them with
// database clock samples taken around the write, never with the runner's clock.
async function databaseNowMs(sql: Sql): Promise<number> {
  const row = (await sql.query<{ ms: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms"))
    .rows[0];
  if (!row) throw Error("missing database clock sample");
  return row.ms;
}

function expectDeadlineWithin(deadline: number, before: number, after: number, ttlSeconds: number) {
  expect(deadline).toBeGreaterThanOrEqual(Math.floor(before) + ttlSeconds * 1000);
  expect(deadline).toBeLessThanOrEqual(Math.ceil(after) + ttlSeconds * 1000);
}

// Private Docker reservations have their own mailbox/local TTL owner, not a full
// Provider adapter. The generic worker must neither claim nor diagnose them.
test("private Docker reservations remain untouched while the generic lifecycle reconciles a coexisting Boat candidate", async () => {
  const { db, people } = await sharedDatabase();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const actor = { userId: people.owner, orgId: people.org };
  const hosts = createDockerHostStore(sql, ENCRYPTION_KEY);
  const registration = await hosts.issueRegistration({ userId: people.admin, orgId: people.org });
  const host = await hosts.exchangeRegistration(registration.registrationToken, crypto.randomUUID());
  const credential = (
    await db.query<{ id: string }>(
      `select id from public.credentials where scope='org' and owner_id=$1 and kind='openai'`,
      [people.org],
    )
  ).rows[0];
  if (!credential) throw Error("missing model account");
  const docker = await createDockerSandboxService(sql).reserve(actor, {
    requestId: crypto.randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId: credential.id,
    credentialVersion: 1,
  });
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const boatId = crypto.randomUUID();
  await db.query(
    `insert into public.sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status)
     values($1,'boat','bx_23456789',$2,$3,$4,'claude','running')`,
    [boatId, golden.id, people.org, people.owner],
  );
  // Docker is the oldest due candidate: omitting the exclusion really claims it.
  await db.query(`update public.sandboxes set reconcile_after=now()-interval '2 minutes' where id=$1`, [docker.id]);
  await db.query(`update public.sandboxes set reconcile_after=now()-interval '1 minute' where id=$1`, [boatId]);
  const readDocker = async () =>
    (
      await db.query(
        `select status,reconcile_lease,reconcile_lease_until,reconcile_after,lifecycle_generation,
     stop_requested_at,last_observed_at,lifecycle_error from public.sandboxes where id=$1`,
        [docker.id],
      )
    ).rows[0];
  const before = await readDocker(),
    resolutions: string[] = [];
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async (_input: Request | string | URL) =>
      Response.json({ ok: true, sandbox: retainedSandbox() })) as typeof fetch,
  });
  const worker = createSandboxLifecycle(sql, async (id) => {
    resolutions.push(id);
    if (id === docker.id) throw Error("Private Docker has no generic golden-backed provider");
    return provider;
  });
  expect(await worker.reconcileOne()).toBe(true);
  expect(resolutions).toEqual([boatId]);
  expect((await db.query(`select status from public.sandboxes where id=$1`, [boatId])).rows[0]).toEqual({
    status: "stopped",
  });
  expect(await readDocker()).toEqual(before);
  expect(await worker.reconcileOne()).toBe(false);
  expect(await readDocker()).toEqual(before);
  await worker.drain();

  const readHistory = (userId: string) =>
    db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
      return (await tx.query("select sandbox_id, from_status, to_status, actor, code from sandbox_transitions")).rows;
    });
  expect(await readHistory(people.owner)).toEqual([
    {
      sandbox_id: boatId,
      from_status: "running",
      to_status: "stopped",
      actor: "reconciler",
      code: "provider_stopped",
    },
  ]);
  expect(await readHistory(people.admin)).toEqual([]);
});

test("an expired observation lease cannot publish a delayed terminal result", async () => {
  const { db, people } = await sharedDatabase();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let lifecycle: ReturnType<typeof createSandboxLifecycle> | undefined;
  let tick: Promise<boolean> | undefined;
  try {
    const sql = bunLikeSql(db);
    const store = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    }).sandboxes;
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const id = crypto.randomUUID();
    await store.insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "running",
      model: "test",
      reasoningEffort: "medium",
      effectiveTtlSeconds: 3600,
    });
    const before = (await db.query("select status,stopped_at,last_observed_at from sandboxes where id=$1", [id]))
      .rows[0];
    let observations = 0;
    const methods: string[] = [];
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (_input: Request | string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        observations++;
        return Response.json({
          ok: true,
          sandbox: observations === 1 ? retainedSandbox() : sandbox({ state: "running" }),
        });
      }) as typeof fetch,
    });
    let hold = true;
    lifecycle = createSandboxLifecycle(
      {
        ...sql,
        transaction: async (work) => {
          // Queue final publication before it acquires a connection.
          if (hold) {
            hold = false;
            publishing.resolve();
            await release.promise;
          }
          return sql.transaction!(work);
        },
      },
      async () => provider,
    );
    const controller = new AbortController();
    tick = lifecycle.reconcileOne(controller.signal);
    await publishing.promise;
    controller.abort();
    await db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [id]);
    release.resolve();
    expect(await tick).toBe(true);
    expect(
      (await db.query("select status,stopped_at,last_observed_at from sandboxes where id=$1", [id])).rows[0],
    ).toEqual(before);
    // The next owner can reclaim the expired lease and take a fresh observation.
    expect(await lifecycle.reconcileOne()).toBe(true);
    const current = (
      await db.query<{ status: string; stopped_at: unknown; last_observed_at: unknown }>(
        "select status,stopped_at,last_observed_at from sandboxes where id=$1",
        [id],
      )
    ).rows[0];
    expect(current?.status).toBe("running");
    expect(current?.stopped_at).toBeNull();
    expect(current?.last_observed_at).not.toBeNull();
    expect(methods).toEqual(["GET", "GET"]);
  } finally {
    release.resolve();
    await Promise.allSettled([tick]);
    await lifecycle?.drain();
  }
});

for (const step of ["transition", "metadata", "lease expiry", "extension cleanup"] as const) {
  test(`terminal settlement rolls back on ${step}`, async () => {
    const { db, people } = await sharedDatabase();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const id = crypto.randomUUID();
    await db.query(
      `insert into public.sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,boat_runtime)
       values($1,'boat','bx_23456789',$2,$3,$4,'claude','running',$5)`,
      [id, golden.id, people.org, people.owner, step === "extension cleanup"],
    );
    const base = bunLikeSql(db);
    const jobId =
      step === "extension cleanup"
        ? await createJobsStore(base, ENCRYPTION_KEY).enqueue("boat_runtime_extend", id, 1, id, null, {
            orgId: people.org,
            maxAttempts: 3,
            deadline: new Date("2099-01-01"),
          })
        : null;
    if (jobId)
      await db.query("insert into public.boat_runtime_extension_state(sandbox_id,pending_job_id) values($1,$2)", [
        id,
        jobId,
      ]);
    const sql: Sql = {
      ...base,
      transaction: (work) =>
        base.transaction!((tx) =>
          work({
            async query<T>(query: string, params?: unknown[]) {
              if (step === "transition" && query.includes("from public.sandbox_transition(")) {
                throw new Error("injected transition failure");
              }
              if (query.includes("last_observed_at=case")) {
                if (step === "metadata") throw new Error("injected metadata failure");
                if (step === "lease expiry") {
                  await tx.query("update public.sandboxes set reconcile_lease_until='-infinity' where id=$1", [id]);
                }
              }
              const result = await tx.query<T>(query, params);
              if (step === "extension cleanup" && query.startsWith("update public.boat_runtime_extension_state"))
                throw new Error("injected extension cleanup failure");
              return result;
            },
          }),
        ),
    };
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (_input: Request | string | URL) =>
        Response.json({ ok: true, sandbox: retainedSandbox() })) as typeof fetch,
    });
    const lifecycle = createSandboxLifecycle(sql, async () => provider);

    if (step === "lease expiry") expect(await lifecycle.reconcileOne()).toBe(true);
    else await expect(lifecycle.reconcileOne()).rejects.toThrow(`injected ${step} failure`);
    expect(
      (
        await db.query(
          `select status,stopped_at,last_observed_at,reconcile_lease is not null as claimed
           from public.sandboxes where id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ status: "running", stopped_at: null, last_observed_at: null, claimed: true }]);
    expect((await db.query("select id from public.sandbox_transitions where sandbox_id=$1", [id])).rows).toEqual([]);
    if (jobId)
      expect(
        (await db.query("select pending_job_id from public.boat_runtime_extension_state where sandbox_id=$1", [id]))
          .rows,
      ).toEqual([{ pending_job_id: jobId }]);
  });
}

// Primary regression owner: actual SDK HTTP decoding plus migrated SQL persistence.
for (const outcome of [
  "external-stop",
  "invalid-stop-time",
  "snapshot-pending",
  "snapshot-owner-removed",
  "expired",
  "expired-external-stop",
  "unconfirmed",
  "stop-error",
  "stale",
  "manual-stop",
] as const) {
  const waitingForRetention = outcome === "invalid-stop-time" || outcome === "snapshot-pending";
  const externalStop = outcome === "external-stop" || waitingForRetention || outcome === "snapshot-owner-removed";
  const validStoppedAt = "2026-11-11T00:00:00.000Z";
  test(`lifecycle reconciles Boat ${outcome} without deleting retained data`, async () => {
    const { db, people } = await sharedDatabase();

    const sql = bunLikeSql(db);
    const data = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const id = crypto.randomUUID();
    await data.sandboxes.insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "running",
      model: "test",
      reasoningEffort: "medium",
      requestedTtlSeconds: 60,
      effectiveTtlSeconds: 60,
    });
    if (outcome === "manual-stop") await db.query("update sandboxes set status='stopping' where id=$1", [id]);
    if (!externalStop && outcome !== "manual-stop" && outcome !== "stale")
      await db.query("update sandboxes set expires_at=now()-interval '1 second' where id=$1", [id]);
    const requests: string[] = [];
    let stopped = false;
    const provider = createBoatProvider({
      apiKey: "test-only-key",
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/stop")) {
          if (outcome === "stop-error")
            return Response.json({ error: { code: "unavailable", message: "test failure" } }, { status: 503 });
          stopped = outcome !== "unconfirmed";
          return Response.json({ ok: true });
        }
        if (request.method === "POST") return Response.json({ ok: true });
        if (outcome === "stale")
          await db.query(
            "update sandboxes set lifecycle_generation=lifecycle_generation+1,status='running' where id=$1",
            [id],
          );
        if (new URL(request.url).pathname.endsWith("/conversations"))
          return Response.json({
            ok: true,
          });
        if (outcome === "snapshot-owner-removed")
          await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
        return Response.json({
          ok: true,
          sandbox:
            stopped || externalStop || outcome === "expired-external-stop"
              ? retainedSandbox({
                  stoppedAt: outcome === "invalid-stop-time" ? "not-a-date" : validStoppedAt,
                  snapshotVerifiedAt: validStoppedAt,
                  ...(outcome === "snapshot-pending" || outcome === "snapshot-owner-removed"
                    ? { lastSnapshotStatus: "in_progress" }
                    : {}),
                })
              : sandbox({ state: "running" }),
        });
      }) as typeof fetch,
    });
    const readStopIntent = async () =>
      (
        await db.query<{
          status: string;
          stop_requested_at: Date | null;
          stop_generation: number;
          lifecycle_generation: number;
          provider_sandbox_id: string;
        }>(
          `select status,stop_requested_at,stop_generation,lifecycle_generation,provider_sandbox_id
             from sandboxes where id=$1`,
          [id],
        )
      ).rows[0];
    const before = waitingForRetention ? await readStopIntent() : undefined;
    const worker = createSandboxLifecycle(sql, async () => provider);
    if (outcome === "snapshot-pending") {
      const fault = new Error("injected pending-retention settlement failure");
      for (const boundary of ["transition", "retry update", "commit"]) {
        const faultingSql: Sql = {
          query: sql.query,
          transaction: (work) =>
            db.transaction(async (tx) => {
              await work({
                query: (statement, args) => {
                  if (
                    (boundary === "transition" && statement.includes("public.sandbox_transition(")) ||
                    (boundary === "retry update" && statement.includes("last_observed_at=case"))
                  )
                    throw fault;
                  return tx.query(statement, args);
                },
              });
              if (boundary === "commit") throw fault;
              throw Error("fault did not run at the expected boundary");
            }),
        };
        await expect(createSandboxLifecycle(faultingSql, async () => provider).reconcileOne()).rejects.toBe(fault);
        expect(await readStopIntent()).toEqual(before);
        expect((await db.query("select id from sandbox_transitions where sandbox_id=$1", [id])).rows).toEqual([]);
        await db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [id]);
      }
    }
    if (outcome === "expired") {
      const before = await readStopIntent();
      for (const boundary of ["transition", "commit"]) {
        let injected = false;
        const faultingSql: Sql = {
          query: sql.query,
          transaction: (work) =>
            db.transaction(async (tx) => {
              let admitted = false;
              const result = await work({
                query: (statement, args) => {
                  if (statement.includes("public.sandbox_transition(") && args?.[3] === "stopping") {
                    admitted = true;
                    if (boundary === "transition") {
                      injected = true;
                      throw new Error("injected stop transition failure");
                    }
                  }
                  return tx.query(statement, args);
                },
              });
              if (admitted && boundary === "commit") {
                injected = true;
                throw new Error("injected stop admission commit failure");
              }
              return result;
            }),
        };
        await expect(createSandboxLifecycle(faultingSql, async () => provider).reconcileOne()).rejects.toThrow(
          "injected stop",
        );
        expect(requests.some((request) => request.startsWith("POST"))).toBe(false);
        expect(injected).toBe(true);
        expect(await readStopIntent()).toEqual(before);
        expect((await db.query("select id from sandbox_transitions where sandbox_id=$1", [id])).rows).toEqual([]);
        await db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [id]);
      }
    }
    await worker.reconcileOne();

    if (["expired", "expired-external-stop", "manual-stop"].includes(outcome))
      expect(await runBoatStop(sql, archivedBoat())).toBe("done");
    if (outcome === "unconfirmed" || outcome === "stop-error")
      expect(await runBoatStop(sql, archivedBoat(false))).toBe("retry");
    const row = (
      await db.query<{
        status: string;
        lifecycle_error: string | null;
        effective_ttl_seconds: number;
        requested_ttl_seconds: number;
        usage_runtime_seconds: number | null;
        status_reason: string | null;
        stop_time_finite: boolean | null;
        provider_stop_retained: boolean | null;
      }>(
        "select *,isfinite(stopped_at) as stop_time_finite,stopped_at=$2::timestamptz as provider_stop_retained from sandboxes where id=$1",
        [id, validStoppedAt],
      )
    ).rows[0]!;
    expect(row.status).toBe(
      outcome === "external-stop" ||
        outcome === "expired" ||
        outcome === "expired-external-stop" ||
        outcome === "manual-stop"
        ? "stopped"
        : outcome === "stale" || outcome === "snapshot-owner-removed"
          ? "running"
          : "stopping",
    );
    expect(row.status_reason).toBe(
      ["expired", "expired-external-stop", "unconfirmed", "stop-error"].includes(outcome) ? "expired" : null,
    );
    expect(row.effective_ttl_seconds).toBe(60);
    expect(row.requested_ttl_seconds).toBe(60);
    if (outcome === "external-stop") expect(row.provider_stop_retained).toBe(true);
    if (outcome === "stale") {
      expect(await readStopIntent()).toMatchObject({ stop_requested_at: null, stop_generation: 0 });
      expect(requests.some((request) => request.startsWith("POST"))).toBe(false);
    }
    if (outcome === "snapshot-owner-removed" || outcome === "stale")
      expect((await db.query("select id from sandbox_transitions where sandbox_id=$1", [id])).rows).toEqual([]);
    if (waitingForRetention) {
      if (!before) throw Error("Missing sandbox before retention settlement");
      expect(row.stop_time_finite).toBeNull();
      const intent = await readStopIntent();
      expect(intent).toEqual({
        ...before,
        status: "stopping",
        stop_requested_at: expect.any(Date),
        stop_generation: 1,
      });
      expect(await worker.reconcileOne()).toBe(false);
      if (outcome === "snapshot-pending") {
        expect(
          (
            await db.query(
              "select isfinite(reconcile_after) and reconcile_after>now() as scheduled from sandboxes where id=$1",
              [id],
            )
          ).rows,
        ).toEqual([{ scheduled: true }]);
        await db.query("update sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [id]);
        expect(await worker.reconcileOne()).toBe(true);
        expect(await readStopIntent()).toEqual(intent);
      }
      expect(
        (
          await db.query(
            `select actor,code,generation,from_status,to_status from sandbox_transitions where sandbox_id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([
        {
          actor: "reconciler",
          code: "stop_requested",
          generation: before.lifecycle_generation,
          from_status: "running",
          to_status: "stopping",
        },
      ]);
      expect(row.lifecycle_error).toContain(
        outcome === "snapshot-pending" ? "snapshot is pending" : "no verified retained snapshot",
      );
    }
    if (outcome === "external-stop" || ["expired", "expired-external-stop", "manual-stop"].includes(outcome)) {
      expect(row.stop_time_finite).toBe(true);
      expect(row.usage_runtime_seconds).not.toBeNull();
      expect(row.usage_runtime_seconds!).toBeGreaterThanOrEqual(0);
    }
    expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(requests.some((r) => r.startsWith("POST"))).toBe(false);
  });
}

test("Boat reconciliation skips an older due candidate while its extension lease is live", async () => {
  const { db, people } = await sharedDatabase();
  const sql = bunLikeSql(db);
  const older = crypto.randomUUID();
  const newer = crypto.randomUUID();
  await db.query(
    `insert into public.sandboxes
      (id, provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status,
       lifecycle_generation, expires_at, boat_runtime, reconcile_after)
     select due.id, 'boat', due.binding, g.id, $3, $4, 'codex', 'running',
       2, 'infinity', true, now()-due.age
     from public.goldens g cross join (values
       ($1::uuid, 'bx_23456789', interval '2 minutes'),
       ($2::uuid, 'bx_2345678a', interval '1 minute')
     ) as due(id,binding,age) where g.name='shared'`,
    [older, newer, people.org, people.owner],
  );
  const jobs = createJobsStore(sql, ENCRYPTION_KEY);
  const kind = "boat_runtime_extend";
  const job = await jobs.enqueue(kind, older, 2, older, null, {
    orgId: people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01"),
  });
  expect((await jobs.claim(kind, crypto.randomUUID(), 3600, 1))?.id).toBe(job);
  const worker = createSandboxLifecycle(sql, async (id) =>
    createBoatProvider({
      apiKey: "test-key",
      fetch: (async (_input: Request | string | URL) =>
        Response.json({
          ok: true,
          sandbox: retainedSandbox({ id: id === older ? "bx_23456789" : "bx_2345678a" }),
        })) as typeof fetch,
    }),
  );
  const status = async (id: string) =>
    (await db.query<{ status: string }>("select status from public.sandboxes where id=$1", [id])).rows[0]?.status;
  expect(await worker.reconcileOne()).toBe(true);
  expect(await status(newer)).toBe("stopped");
  expect(await status(older)).toBe("running");
  await db.query("update public.jobs set lease_until='-infinity' where id=$1", [job]);
  expect(await worker.reconcileOne()).toBe(true);
  expect(await status(older)).toBe("stopped");
  await worker.drain();
});

for (const evidence of [
  "covered",
  "terminal-covered",
  "terminal-short",
  "short",
  "scoped-short",
  "unknown",
  "native",
  "superseded",
  "lost-observation-response",
  "lost-stop-response",
] as const) {
  test(`Boat reconciliation handles ${evidence} physical deadline evidence`, async () => {
    const { db, people } = await sharedDatabase();
    const id = crypto.randomUUID();
    const {
      rows: [binding],
    } = await db.query<{ expires_at: Date; lifecycle_generation: number }>(
      `insert into public.sandboxes
        (id, provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, expires_at, boat_runtime,
         visibility, access_owner_id)
       select $1, 'boat', 'bx_23456789', id, $2, $3, 'codex', 'running', now()+interval '1 hour', $4, 'private', $3
       from public.goldens where name='shared' returning expires_at,lifecycle_generation`,
      [id, people.org, people.owner, evidence !== "native"],
    );
    if (!binding) throw Error("Missing Boat sandbox.");
    const sql = bunLikeSql(db);
    const coveredDeadline = new Date(binding.expires_at.getTime() + 600_000);
    const shouldClear = evidence === "terminal-covered" || evidence === "lost-observation-response";
    const terminalJob = shouldClear || evidence === "terminal-short";
    const hasPendingJob = evidence === "covered" || evidence === "lost-stop-response" || terminalJob;
    let physicalDeadline = evidence === "covered" || shouldClear ? coveredDeadline : binding.expires_at;
    const pendingJobId = hasPendingJob
      ? await createJobsStore(sql, ENCRYPTION_KEY).enqueue(
          "boat_runtime_extend",
          id,
          binding.lifecycle_generation,
          id,
          null,
          { orgId: people.org, maxAttempts: 3, deadline: binding.expires_at },
        )
      : null;
    if (pendingJobId)
      await db.query("insert into public.boat_runtime_extension_state(sandbox_id,pending_job_id) values($1,$2)", [
        id,
        pendingJobId,
      ]);
    const failureReceipt = { reason: "deadline" };
    if (terminalJob)
      await db.query("update public.jobs set state='failed', outcome=$2::jsonb where id=$1", [
        pendingJobId,
        JSON.stringify(failureReceipt),
      ]);
    if (evidence === "scoped-short")
      await db.query(
        `insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
         values($1,'sandbox',$2,$3,$1,'ready')`,
        [id, people.org, people.owner],
      );
    let stops = 0;
    let stopped = false;
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/stop")) {
          stops++;
          if (evidence === "lost-stop-response" && stops === 1) throw Error("Injected lost stop response.");
          stopped = true;
          return Response.json({ ok: true });
        }
        if (evidence === "superseded")
          await db.query("update sandboxes set expires_at=expires_at-interval '30 minutes' where id=$1", [id]);
        return Response.json({
          ok: true,
          sandbox: stopped
            ? retainedSandbox()
            : sandbox({
                state: "running",
                archiveAfter: evidence === "unknown" || stops > 0 ? undefined : physicalDeadline.toISOString(),
              }),
        });
      }) as typeof fetch,
    });
    const workerSql: Sql =
      evidence === "lost-observation-response"
        ? {
            ...sql,
            query: async <T>(statement: string, args?: unknown[]) => {
              const result = await sql.query<T>(statement, args);
              if (statement.includes("insert into public.boat_runtime_extension_state"))
                throw Error("Injected lost observation write response.");
              return result;
            },
          }
        : sql;
    const worker = createSandboxLifecycle(workerSql, async () => provider);
    if (evidence === "short") await db.exec("set datestyle='German, DMY'");
    try {
      expect(await worker.reconcileOne()).toBe(true);
      await worker.drain();
    } finally {
      if (evidence === "short") await db.exec("reset datestyle");
    }

    const readSandbox = async () =>
      (
        await db.query(
          "select status, status_reason, expires_at, stop_requested_at, lifecycle_error from public.sandboxes where id=$1",
          [id],
        )
      ).rows[0];
    const readObservation = async () =>
      (
        await db.query(
          `select pending_job_id,observed_provider_id,observed_generation,observed_at,observed_expires_at
           from public.boat_runtime_extension_state where sandbox_id=$1`,
          [id],
        )
      ).rows;
    if (evidence === "lost-observation-response") {
      expect(stops).toBe(0);
      expect(await readSandbox()).toMatchObject({
        status: "running",
        expires_at: binding.expires_at,
        lifecycle_error: expect.stringContaining("Provider lifecycle observation unavailable"),
      });
      expect(await readObservation()).toMatchObject([{ pending_job_id: null, observed_expires_at: coveredDeadline }]);
      physicalDeadline = new Date(coveredDeadline.getTime() + 60_000);
      await db.query("update sandboxes set reconcile_after='-infinity' where id=$1", [id]);
      const successor = createSandboxLifecycle(sql, async () => provider);
      expect(await successor.reconcileOne()).toBe(true);
      await successor.drain();
      expect(await readSandbox()).toMatchObject({ lifecycle_error: null });
    }
    const shouldStop = ["short", "scoped-short", "terminal-short", "lost-stop-response"].includes(evidence);
    if (shouldStop) {
      expect(await readSandbox()).toMatchObject({ status: "stopping", stop_requested_at: expect.any(Date) });
      expect(await runBoatStop(sql, archivedBoat())).toBe("done");
    }
    const row = await readSandbox();
    expect(stops).toBe(0);
    expect(row).toMatchObject(
      shouldStop
        ? { status: "stopped", status_reason: "expired", expires_at: binding.expires_at }
        : {
            status: "running",
            status_reason: null,
            expires_at: evidence === "superseded" ? expect.any(Date) : binding.expires_at,
          },
    );
    expect(await readObservation()).toEqual(
      shouldStop || hasPendingJob
        ? [
            {
              pending_job_id: shouldClear || shouldStop ? null : pendingJobId,
              observed_provider_id: "bx_23456789",
              observed_generation: binding.lifecycle_generation,
              observed_at: expect.any(Date),
              observed_expires_at: physicalDeadline,
            },
          ]
        : [],
    );
    if (terminalJob)
      expect((await db.query("select state,outcome from public.jobs where id=$1", [pendingJobId])).rows).toEqual([
        { state: "failed", outcome: failureReceipt },
      ]);
  });
}

test("replicas lease one observation and resume admission fences old writes while retaining requested TTL", async () => {
  const { db, people } = await sharedDatabase();
  const gate = Promise.withResolvers<void>();
  let worker: ReturnType<typeof createSandboxLifecycle> | undefined;
  let first: Promise<boolean> | undefined;
  try {
    const sql = bunLikeSql(db);
    const data = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const id = crypto.randomUUID();
    await data.sandboxes.insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "running",
      model: "test",
      reasoningEffort: "medium",
      effectiveTtlSeconds: 90,
      requestedTtlSeconds: 90,
    });
    let entered: (() => void) | undefined;
    const observing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observations = 0;
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (_input: Request | string | URL, _init?: RequestInit) => {
        observations++;
        entered?.();
        await gate.promise;
        return Response.json({ ok: true, sandbox: retainedSandbox() });
      }) as typeof fetch,
    });
    worker = createSandboxLifecycle(sql, async () => provider);
    first = worker.reconcileOne();
    await observing;
    await worker.reconcileOne();
    expect(observations).toBe(1);
    await expect(
      data.sandboxes.update(id, { renewLifecycle: true, advanceGeneration: true, expectedGeneration: 1 }),
    ).rejects.toThrow();
    gate.resolve();
    await first;
    const activityToken = crypto.randomUUID();
    const beforeRenewal = await databaseNowMs(sql);
    await data.sandboxes.update(id, {
      renewLifecycle: true,
      advanceGeneration: true,
      activityToken,
      expectedGeneration: 1,
    });
    const afterRenewal = await databaseNowMs(sql);
    // The renewal writes its deadline and reconcile_after from one transaction
    // clock, so their gap is the TTL regardless of the runner's wall clock.
    const renewed = (
      await db.query<{ expires_ms: number; ttl_ms: number }>(
        `select (extract(epoch from expires_at) * 1000)::float8 as expires_ms,
          (extract(epoch from expires_at - reconcile_after) * 1000)::float8 as ttl_ms
          from sandboxes where id=$1`,
        [id],
      )
    ).rows[0];
    if (!renewed) throw Error("missing renewed sandbox");
    expect(renewed.ttl_ms).toBe(90000);
    // The gap alone would accept a renewal backdated as a whole; bound the
    // deadline with database clock samples taken around the renewal.
    expectDeadlineWithin(renewed.expires_ms, beforeRenewal, afterRenewal, 90);
    await expect(
      data.sandboxes.update(id, {
        status: "running",
        stoppedAt: null,
        finishActivity: true,
        expectedGeneration: 2,
        activityToken,
      }),
    ).rejects.toThrow("Sandbox status changes require a lifecycle transition.");
    await expect(
      data.sandboxes.update(id, { finishActivity: true, activityToken, expectedGeneration: 1 }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    await data.sandboxes.update(id, {
      finishActivity: true,
      activityToken,
      expectedGeneration: 2,
    });
    const row = await data.sandboxes.get(id);
    expect(row?.status).toBe("stopped");
    expect(row?.lifecycleGeneration).toBe(3);
    expect(row?.effectiveTtlSeconds).toBe(90);
    expect(row?.requestedTtlSeconds).toBe(90);
    expect(Date.parse(row?.expiresAt ?? "")).toBe(Math.floor(renewed.expires_ms));
    expect(
      (
        await db.query(
          "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1 order by id",
          [id],
        )
      ).rows,
    ).toEqual([
      { from_status: "running", to_status: "stopped", actor: "reconciler", code: "provider_stopped", generation: 1 },
    ]);
  } finally {
    gate.resolve();
    await Promise.allSettled([first]);
    await worker?.drain();
  }
});

for (const status of ["running", "starting", "failed", "stopping"] as const) {
  test(`removed-owner ${status} sandbox reports blocked cleanup without provider authority`, async () => {
    const { db, people } = await sharedDatabase();

    const id = crypto.randomUUID();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,expires_at)
        values($1,'boat','bx_23456789',$2,$3,$4,'claude',$5,now()-interval '1 second')`,
      [id, golden.id, people.org, people.owner, status],
    );
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    let resolutions = 0;
    const worker = createSandboxLifecycle(bunLikeSql(db), async () => {
      resolutions++;
      throw new Error("Provider authority must not be requested");
    });
    expect(await worker.reconcileOne()).toBe(true);
    const row = (
      await db.query<{
        status: string;
        lifecycle_error: string;
        stopped_at: Date | null;
        stop_requested_at: Date | null;
        last_observed_at: Date | null;
        reconcile_lease: string | null;
        reconcile_lease_until: Date | null;
        retry_seconds: number;
      }>(
        `select *,extract(epoch from (reconcile_after-now()))::float8 as retry_seconds
        from sandboxes where id=$1`,
        [id],
      )
    ).rows[0]!;
    expect(row.lifecycle_error).toBe(
      "Cleanup blocked: removed-owner authority is unavailable. Automatic cleanup requires service-owned worker authority.",
    );
    expect(row.status).toBe(status);
    expect(row.stopped_at).toBeNull();
    expect(row.stop_requested_at).toBeNull();
    expect(row.last_observed_at).toBeNull();
    expect(row.reconcile_lease).toBeNull();
    expect(row.reconcile_lease_until).toBeNull();
    expect(row.retry_seconds).toBeGreaterThan(0);
    expect(row.retry_seconds).toBeLessThanOrEqual(60);
    expect(await worker.reconcileOne()).toBe(false);
    await db.query("update sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [id]);
    expect(await worker.reconcileOne()).toBe(true);
    expect(resolutions).toBe(0);
  });
}

for (const blocked of ["boat", "modal"] as const) {
  test(`timed-out ${blocked} calls preserve capacity for the other authority and stay globally bounded`, async () => {
    const { db, people } = await sharedDatabase();
    const sql = bunLikeSql(db);
    const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const entered: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const ids: string[] = [];
    const calls: string[] = [];
    const authorityFor = new Map<string, "boat" | "modal">();
    const worker = createSandboxLifecycle(
      sql,
      async (id) =>
        ({
          id: authorityFor.get(id),
          async get() {
            calls.push(id);
            const index = ids.indexOf(id);
            entered[index]!.resolve();
            await gates[index]!.promise;
            return { state: "stopped", retainedSnapshot: "usable" };
          },
        }) as unknown as import("@armada/core").Provider,
    );
    try {
      for (const authority of [blocked, blocked === "boat" ? "modal" : "boat"] as const) {
        const golden = (
          await db.query<{ id: string }>(
            `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
          values($1,$2,$3,'private',$4::public.sandbox_provider,'master','image',case when $4::public.sandbox_provider='modal' then 'workspace' end,case when $4::public.sandbox_provider='modal' then 'main' end,case when $4::public.sandbox_provider='modal' then 'app' end,'{"repos":[],"init":[]}') returning id`,
            [people.org, people.owner, `capacity-${authority}`, authority],
          )
        ).rows[0]!;
        for (let i = 0; i < 5; i++) {
          const id = crypto.randomUUID();
          ids.push(id);
          authorityFor.set(id, authority);
          gates.push(Promise.withResolvers<void>());
          entered.push(Promise.withResolvers<void>());
          await db.query(
            `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,runtime_transport)
             values($1::uuid,$2,$1::uuid::text,$3,$4,$5,'codex','running',null)`,
            [id, authority, golden.id, people.org, people.owner],
          );
          // Leave the fifth candidate eligible to prove saturation does not
          // simply rely on there being no work in this partition.
          if (i === 4) continue;
          const controller = new AbortController();
          const tick = worker.reconcileOne(controller.signal);
          expect(await Promise.race([entered[ids.length - 1]!.promise.then(() => true), tick.then(() => false)])).toBe(
            true,
          );
          controller.abort();
          expect(await tick).toBe(true);
        }
        expect(await worker.reconcileOne()).toBe(false);
      }
      expect(calls).toHaveLength(8);
      for (const gate of gates) gate.resolve();
      await worker.drain();
      // Neither timed-out partition publishes its delayed terminal response.
      expect(
        (await db.query("select id from sandboxes where id=any($1::uuid[]) and status='running'", [ids])).rows,
      ).toHaveLength(10);
      expect(await worker.reconcileOne()).toBe(true);
      expect(calls).toHaveLength(9);
    } finally {
      for (const gate of gates) gate.resolve();
      await worker.drain();
    }
  });
}

test("runtime lifecycle stops compute without claiming a checkpoint invalidated by a late journal event", async () => {
  const { db, people } = await sharedDatabase();

  const sql: Sql = {
    ...bunLikeSql(db),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const store = createSqlData(sql)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const row = await store.insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "runtime-compute",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    model: "gpt-5.4",
    reasoningEffort: "high",
    boatRuntime: true,
  });
  const enrolments = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const ticket = await enrolments.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} });
  const active = await enrolments.enrol(ticket.enrolmentToken);
  await db.query(
    "insert into runtime_checkpoints(sandbox_id,epoch,request_id,watermark,completed_at) values($1,$2,$3,0,now())",
    [row.id, active.epoch, crypto.randomUUID()],
  );
  await createRuntimeEvents(enrolments, ENCRYPTION_KEY).append(active.runtimeToken, active.epoch, {
    sandboxId: row.id,
    generation: active.epoch,
    events: [{ sequence: 1, event: { id: "late", at: 1, kind: "other", type: "late-notification", data: {} } }],
  });
  await db.query("update sandboxes set stop_requested_at=now(),reconcile_after=now() where id=$1", [row.id]);
  const lifecycle = createSandboxLifecycle(sql, async () => {
    throw Error("Stop job owns provider I/O.");
  });
  expect(await lifecycle.reconcileOne()).toBe(true);
  expect(await runBoatStop(sql, archivedBoat())).toBe("done");
  const final = await store.get(row.id);
  expect(final?.status).toBe("stopped");
  expect(final?.preservationNote).toContain("no acknowledged runtime checkpoint");
  await lifecycle.drain();
});

test.each(["active", "terminate", "booting", "failed"] as const)("expired Modal stop from %s", async (phase) => {
  const { db, people } = await sharedDatabase();
  const sql = bunLikeSql(db);
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,'expired-modal','private','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!;
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,runtime_transport,expires_at)
    values($1,'modal','compute',$2,$3,$4,'codex',$5,'dialout',now()-interval '1 second')`,
    [id, golden.id, people.org, people.owner, phase === "failed" ? "failed" : "running"],
  );
  let stopped = false;
  const provider = {
    id: "modal",
    get: async () => ({
      id: "compute",
      state: stopped ? "stopped" : "running",
      providerState: phase === "failed" ? "active" : phase,
      physicalGeneration: "3",
    }),
    captureRuntimeWork: async () => {
      if (phase !== "active" && phase !== "failed") throw Error("Only active compute can preserve work");
      return { status: "clean" };
    },
    runtimeStopMachine: async () => ({
      physical: { machineId: "compute", generation: 3 },
      stopped,
      machine: {
        stop: async () => {
          if (phase === "active")
            expect(
              (
                await db.query(
                  "select actor,code,generation,from_status,to_status from sandbox_transitions where sandbox_id=$1",
                  [id],
                )
              ).rows,
            ).toEqual([
              { actor: "reconciler", code: "expired", generation: 1, from_status: "running", to_status: "stopping" },
            ]);
          expect(
            (
              await db.query(
                "select coalesce(preservation_stop_generation=stop_generation,false) as captured from sandboxes where id=$1",
                [id],
              )
            ).rows,
          ).toEqual([{ captured: phase === "active" || phase === "failed" }]);
          stopped = true;
        },
      },
    }),
    quiesce: async () => {
      throw Error("No tunnel quiesce");
    },
    exec: async () => {
      throw Error("No native work capture");
    },
  } as unknown as import("@armada/core").Provider;
  const worker = createSandboxLifecycle(sql, async () => provider);
  expect(await worker.reconcileOne()).toBe(true);
  expect(stopped).toBe(false);
  if (phase === "failed") {
    const { sandboxes } = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    await expect(sandboxes.assertDeletionAllowed!(id)).rejects.toThrow("Sandbox exit is unconfirmed.");
  }
  expect((await runClaimedStop(sql, async () => provider)).result.status).toBe("done");
  expect(stopped).toBe(true);
  expect((await db.query("select status,preservation_note from sandboxes where id=$1", [id])).rows[0]).toMatchObject({
    status: phase === "failed" ? "failed" : "stopped",
    preservation_note: null,
  });
  await worker.drain();
});

for (const loss of ["membership", "credential", "credential_stale_generation", "revoked", "transient"] as const) {
  test(`stop-requested sandbox enters operator custody after ${loss} loss without fabricating exit`, async () => {
    const { db, people } = await sharedDatabase();
    const id = crypto.randomUUID();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,stop_requested_at)
       values($1,'boat','bx_23456789',$2,$3,$4,'claude','stopping',now())`,
      [id, golden.id, people.org, people.owner],
    );
    if (loss === "membership")
      await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    const sql = bunLikeSql(db);
    const worker = createSandboxLifecycle(sql, async () => {
      throw Error("Stop job owns provider I/O.");
    });
    expect(await worker.reconcileOne()).toBe(true);
    if (loss !== "membership") {
      const run = runBoatStop(sql, {
        ...archivedBoat(),
        async observe() {
          if (loss === "credential_stale_generation")
            await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
          if (loss === "revoked")
            throw new ProviderError({ provider: "boat", code: "unauthorized", message: "Revoked", retryable: false });
          if (loss === "transient") throw Error("transient service failure");
          throw new VaultError("missing_credential", "original authority unavailable");
        },
      });
      if (loss === "credential_stale_generation") await expect(run).rejects.toThrow("completion lost");
      else expect(await run).toBe(loss === "transient" ? "retry" : "fail");
    }
    const row = (
      await db.query<{
        status: string;
        stopped_at: Date | null;
        last_observed_at: Date | null;
        stop_requested_at: Date | null;
        provider_sandbox_id: string;
        lifecycle_generation: number;
        reconcile_lease: string | null;
        lifecycle_error: string | null;
        held: boolean;
      }>(
        `select status,stopped_at,last_observed_at,stop_requested_at,provider_sandbox_id,
       lifecycle_generation,reconcile_lease,lifecycle_error,reconcile_after='infinity'::timestamptz as held
       from sandboxes where id=$1`,
        [id],
      )
    ).rows[0]!;
    expect(row.status).toBe("stopping");
    expect(row.stopped_at).toBeNull();
    expect(row.last_observed_at).toBeNull();
    expect(row.stop_requested_at).not.toBeNull();
    expect(row.provider_sandbox_id).toBe("bx_23456789");
    expect(row.reconcile_lease).toBeNull();
    expect(row.held).toBe(true);
    if (loss === "credential_stale_generation" || loss === "transient") expect(row.lifecycle_error).toBeNull();
    else expect(row.lifecycle_error).toContain("Operator cleanup required:");
    if (loss !== "credential_stale_generation") expect(await worker.reconcileOne()).toBe(false);
  });
}

test.each(["queued", "dispatching", "acknowledged"])("idle-only stop preserves %s work", async (state) => {
  const { db, people } = await sharedDatabase();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const store = createSqlData(sql)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const id = crypto.randomUUID();
  const runtime = state === "acknowledged";
  const status = runtime ? "running" : "ready";
  await db.query(
    `insert into sandboxes (id, provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, boat_runtime)
     select $1,'boat','idle-stop-race',id,$2,$3,'claude',$4::sandbox_status,$5 from goldens where name='shared'`,
    [id, people.org, people.owner, status, runtime],
  );
  const idle = await store.get(id);
  if (!idle) throw Error("missing sandbox");
  const promptId = crypto.randomUUID();
  if (runtime) {
    await db.query(
      `insert into public.runtime_enrolments(sandbox_id,lifecycle_generation,epoch,runtime_hash)
       select id,lifecycle_generation,1,encode(sha256(uuid_send(id)),'hex')
       from public.sandboxes where id=$1`,
      [id],
    );
    await db.query(
      `insert into public.runtime_commands(sandbox_id,request_id,epoch,request_enc,result_enc,accepted_prompt_id)
       values($1,$2,1,decode('00','hex'),decode('00','hex'),$2::text::uuid)`,
      [id, promptId],
    );
  } else {
    await db.query(
      `insert into account_turn_queue
         (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,state)
       select $1,gen_random_uuid(),id,$2,$3,1,1,'hash',decode('00','hex'),'conversation',$4
       from credentials where scope='org' and owner_id=$3 and kind='openai'`,
      [id, people.owner, people.org, state],
    );
  }

  const admission = { ownerStop: true, status: "stopping", stopRequested: true, onlyIfIdle: true } as const;
  const { onlyIfIdle: _, ...manualAdmission } = admission;
  const stop = (patch: Omit<typeof admission, "onlyIfIdle">, sandbox = idle) =>
    store.update(sandbox.id, {
      ...patch,
      advanceGeneration: true,
      activityToken: crypto.randomUUID(),
      ...(sandbox.lifecycleGeneration !== undefined && { expectedGeneration: sandbox.lifecycleGeneration }),
    });
  await expect(stop(admission)).rejects.toThrow("The sandbox is busy");
  expect(await store.get(id)).toMatchObject({ status, lifecycleGeneration: idle.lifecycleGeneration });
  if (runtime) {
    await db.query("insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,$2,true)", [
      id,
      promptId,
    ]);
    await db.query("update public.sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
    await expect(stop(admission)).rejects.toMatchObject({ code: "sandbox_not_ready" });
    const current = (await store.get(id))!;
    await stop(admission, current);
  } else {
    expect((await db.query("select state from account_turn_queue where sandbox_id=$1", [id])).rows).toEqual([
      { state },
    ]);

    await stop(manualAdmission);
    expect((await db.query("select state from account_turn_queue where sandbox_id=$1", [id])).rows).toEqual([
      { state: "failed" },
    ]);
  }

  expect(await runBoatStop(sql, archivedBoat())).toBe("done");
  const journal = await db.query(
    `select from_status, to_status, actor, code from sandbox_transitions
     where sandbox_id=$1 order by id`,
    [id],
  );
  expect(journal.rows).toEqual([
    { from_status: status, to_status: "stopping", actor: "owner", code: "owner_stop_admitted" },
    { from_status: "stopping", to_status: "stopped", actor: "lifecycle_runner", code: "owner_stop_settled" },
  ]);
});
