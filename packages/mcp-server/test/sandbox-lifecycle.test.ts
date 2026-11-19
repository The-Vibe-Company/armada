import { expect, test } from "bun:test";
import { type Provider, ProviderError, type Sql, VaultError } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { retainedSandbox, sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { sandboxActivity } from "../src/sandbox-activity.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
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
  const docker = await createDockerSandboxService(sql, ENCRYPTION_KEY, { enabled: true }).reserve(actor, {
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
        query: async <T>(text: string, params?: unknown[]) => {
          // Queue the final publication before SQL executes, as with pool/lock delay.
          if (hold && text.includes("last_observed_at=case")) {
            hold = false;
            publishing.resolve();
            await release.promise;
          }
          return sql.query<T>(text, params);
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

// Primary regression owner: actual SDK HTTP decoding plus migrated SQL persistence.
for (const outcome of [
  "external-stop",
  "invalid-stop-time",
  "snapshot-pending",
  "expired",
  "expired-external-stop",
  "interrupt-pending",
  "unconfirmed",
  "stop-error",
  "stale",
  "manual-stop",
] as const) {
  const waitingForRetention = outcome === "invalid-stop-time" || outcome === "snapshot-pending";
  const externalStop = outcome === "external-stop" || waitingForRetention;
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
    if (!externalStop && outcome !== "stale" && outcome !== "manual-stop")
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
            conversations: outcome === "interrupt-pending" ? [{ id: "conv-pending", running: true }] : [],
          });
        return Response.json({
          ok: true,
          sandbox:
            stopped || externalStop || outcome === "expired-external-stop" || outcome === "stale"
              ? retainedSandbox({
                  stoppedAt: outcome === "invalid-stop-time" ? "not-a-date" : validStoppedAt,
                  snapshotVerifiedAt: validStoppedAt,
                  ...(outcome === "snapshot-pending" ? { lastSnapshotStatus: "in_progress" } : {}),
                })
              : sandbox({ state: "running" }),
        });
      }) as typeof fetch,
    });
    await createSandboxLifecycle(sql, async () => provider).reconcileOne();
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
        : outcome === "stale"
          ? "running"
          : "stopping",
    );
    expect(row.status_reason).toBe(
      ["expired", "expired-external-stop", "interrupt-pending", "unconfirmed", "stop-error"].includes(outcome)
        ? "expired"
        : null,
    );
    expect(row.effective_ttl_seconds).toBe(60);
    expect(row.requested_ttl_seconds).toBe(60);
    if (outcome === "external-stop") expect(row.provider_stop_retained).toBe(true);
    if (waitingForRetention) {
      expect(row.stop_time_finite).toBeNull();
      expect(row.lifecycle_error).toContain(
        outcome === "snapshot-pending" ? "snapshot is pending" : "no verified retained snapshot",
      );
    }
    if (outcome === "external-stop" || ["expired", "expired-external-stop", "manual-stop"].includes(outcome)) {
      expect(row.stop_time_finite).toBe(true);
      expect(row.usage_runtime_seconds).not.toBeNull();
      expect(row.usage_runtime_seconds!).toBeGreaterThanOrEqual(0);
    }
    if (outcome === "unconfirmed" || outcome === "stop-error" || outcome === "interrupt-pending")
      expect(row.lifecycle_error).toContain("Retrying");
    expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(requests.filter((r) => r.startsWith("POST") && r.endsWith("/stop")).length).toBe(
      externalStop || outcome === "expired-external-stop" || outcome === "stale" || outcome === "interrupt-pending"
        ? 0
        : 1,
    );
  });
}

for (const observation of ["stopped", "expired", "unavailable"] as const) {
  test(`failed launch reason survives terminal reconciliation (${observation})`, async () => {
    const { db, people } = await sharedDatabase();

    const sql = bunLikeSql(db);
    const id = crypto.randomUUID();
    const reason = "Repository initialization failed";
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    await db.query(
      `insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,status_reason,expires_at)
        values($1,'boat','bx_23456789',$2,$3,$4,'claude','failed',$5,now()-interval '1 second')`,
      [id, golden.id, people.org, people.owner, reason],
    );
    const methods: string[] = [];
    let stopped = observation === "stopped";
    const provider = createBoatProvider({
      apiKey: "test-key",
      beforeResume: async () => true,
      beforePrompt: async () => {},
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        methods.push(request.method);
        if (observation === "unavailable")
          return Response.json({ error: { code: "unavailable", message: "test" } }, { status: 503 });
        const path = new URL(request.url).pathname;
        if (path.endsWith("/resume")) {
          stopped = false;
          return Response.json({ ok: true });
        }
        if (path.endsWith("/prompt"))
          return Response.json({ ok: true, promptId: "prompt_1", conversationId: "conv_1", status: "queued" });
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/stop")) {
          stopped = true;
          return Response.json({ ok: true });
        }
        if (request.method === "POST") return Response.json({ ok: true });
        if (path.endsWith("/conversations")) return Response.json({ ok: true, conversations: [] });
        return Response.json({ ok: true, sandbox: stopped ? retainedSandbox() : sandbox({ state: "running" }) });
      }) as typeof fetch,
    });
    let resolutions = 0;
    const lifecycle = createSandboxLifecycle(sql, async () => {
      resolutions++;
      return provider;
    });
    await lifecycle.reconcileOne();
    const row = (
      await db.query<{
        status: string;
        status_reason: string;
        stopped_at: Date | null;
        last_observed_at: Date | null;
        reconcile_lease: string | null;
        lifecycle_error: string | null;
      }>(
        "select status,status_reason,stopped_at,last_observed_at,reconcile_lease,lifecycle_error from sandboxes where id=$1",
        [id],
      )
    ).rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.status_reason).toBe(reason);
    expect(row?.reconcile_lease).toBeNull();
    expect(methods.includes("DELETE")).toBe(false);
    if (observation === "unavailable") {
      expect(row?.stopped_at).toBeNull();
      expect(row?.lifecycle_error).toContain("Retrying");
    } else {
      expect(row?.stopped_at).not.toBeNull();
      expect(row?.last_observed_at).not.toBeNull();
      expect(row?.lifecycle_error).toBeNull();
      expect(methods).toEqual(
        observation === "expired" ? ["GET", "GET", "GET", "GET", "GET", "POST", "POST", "GET"] : ["GET"],
      );
    }
    // Re-due historical failures: only unknown outcomes may consume provider work again.
    await db.query("update sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [id]);
    const calls = methods.length;
    expect(await lifecycle.reconcileOne()).toBe(observation === "unavailable");
    expect(resolutions).toBe(observation === "unavailable" ? 2 : 1);
    expect(methods.length).toBe(calls + (observation === "unavailable" ? 1 : 0));
    if (observation !== "unavailable") {
      const store = createSqlData(sql)({
        via: "service",
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
      }).sandboxes;
      const confirmed = await store.get(id);
      if (!confirmed) throw Error("missing confirmed failed sandbox");
      // The production send-admission owner rearms the persisted policy, then the
      // real SDK resumes the stopped machine and admits its next native prompt.
      const beforeRearm = await databaseNowMs(sql);
      await sandboxActivity(
        store,
        confirmed,
        { renewLifecycle: true, status: "starting", stoppedAt: null },
        async (signal) => {
          const receipt = await provider.prompt({
            sandboxId: confirmed.providerSandboxId,
            harness: "claude",
            text: "continue",
            signal,
          });
          return { result: receipt, patch: { status: "running", stoppedAt: null } };
        },
      );
      const afterRearm = await databaseNowMs(sql);
      const resumed = await store.get(id);
      expect(resumed?.stoppedAt).toBeNull();
      expect(resumed?.status).toBe("running");
      expect(resumed?.lifecycleGeneration).toBe(3);
      // The rearm writes the deadline and reconcile_after from one transaction
      // clock; their gap is the TTL regardless of the runner's wall clock.
      const rearmed = await db.query<{ gap_seconds: number }>(
        "select extract(epoch from expires_at - reconcile_after)::float8 as gap_seconds from sandboxes where id=$1",
        [id],
      );
      expect(rearmed.rows[0]?.gap_seconds).toBe(resumed?.effectiveTtlSeconds);
      // A shared clock error in the write (for example an expired deadline)
      // falls outside the database samples taken around the rearm.
      expectDeadlineWithin(
        Date.parse(resumed?.expiresAt ?? ""),
        beforeRearm,
        afterRearm,
        resumed?.effectiveTtlSeconds ?? 0,
      );
      const beforeObservation = methods.length;
      expect(await lifecycle.reconcileOne()).toBe(true);
      expect(resolutions).toBe(2);
      expect(methods.slice(beforeObservation)).toEqual(["GET"]);
      expect((await store.get(id))?.status).toBe("running");
    }
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
    await expect(data.sandboxes.update(id, { status: "stopped", expectedGeneration: 1 })).rejects.toThrow();
    await data.sandboxes.update(id, {
      status: "running",
      stoppedAt: null,
      finishActivity: true,
      activityToken,
      expectedGeneration: 2,
    });
    const row = await data.sandboxes.get(id);
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
      { from_status: "stopped", to_status: "running", actor: "api", code: "sandbox_running", generation: 3 },
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

test("runtime lifecycle stops compute with explicit no-checkpoint note, without native quiescence or capture", async () => {
  const { db, people } = await sharedDatabase();

  const sql = bunLikeSql(db);
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
  await db.query("update sandboxes set stop_requested_at=now(),reconcile_after=now() where id=$1", [row.id]);
  let stopped = false;
  const calls: string[] = [];
  const provider = {
    id: "boat",
    async get() {
      return {
        id: "runtime-compute",
        name: "x",
        labels: {},
        state: stopped ? "stopped" : "ready",
        providerState: "x",
        ...(stopped ? { stoppedAt: new Date(), retainedSnapshot: "usable" } : {}),
      };
    },
    async stop() {
      calls.push("stop");
      stopped = true;
    },
    async quiesce() {
      throw Error("must not claim native quiescence");
    },
    async exec() {
      throw Error("must not capture native work");
    },
  };
  const lifecycle = createSandboxLifecycle(sql, async () => provider as unknown as import("@armada/core").Provider);
  expect(await lifecycle.reconcileOne()).toBe(true);
  expect(calls).toEqual(["stop"]);
  const final = await store.get(row.id);
  expect(final?.status).toBe("stopped");
  expect(final?.preservationNote).toContain("no acknowledged runtime checkpoint");
  await lifecycle.drain();
});

// Expiry must stop enrolled Modal compute even though native quiesce is unavailable.
test("expired Modal dial-out reaches compute stop without tunnel quiescence or preservation exec", async () => {
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
    values($1,'modal','compute',$2,$3,$4,'codex','running','dialout',now()-interval '1 second')`,
    [id, golden.id, people.org, people.owner],
  );
  let stopped = false;
  const provider = {
    id: "modal",
    get: async () => ({ id: "compute", state: stopped ? "stopped" : "running" }),
    stop: async () => {
      stopped = true;
    },
    quiesce: async () => {
      throw Error("No tunnel quiesce");
    },
    exec: async () => {
      throw Error("No native work capture");
    },
  } as unknown as import("@armada/core").Provider;
  const worker = createSandboxLifecycle(sql, async () => provider);
  expect(await worker.reconcileOne()).toBe(true);
  expect(stopped).toBe(true);
  expect((await db.query("select status,preservation_note from sandboxes where id=$1", [id])).rows[0]).toMatchObject({
    status: "stopped",
    preservation_note: expect.stringContaining("disk retention, resume"),
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
    let resolutions = 0;
    const worker = createSandboxLifecycle(bunLikeSql(db), async () => {
      resolutions++;
      if (loss === "credential_stale_generation")
        await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
      if (loss === "revoked")
        return {
          id: "boat",
          get: async () => {
            throw new ProviderError({ provider: "boat", code: "unauthorized", retryable: false, message: "revoked" });
          },
        } as unknown as Provider;
      if (loss === "transient") throw Error("transient service failure");
      throw new VaultError("missing_credential", "original authority unavailable");
    });
    expect(await worker.reconcileOne()).toBe(true);
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
    expect(resolutions).toBe(loss === "membership" ? 0 : 1);
    expect(row.status).toBe("stopping");
    expect(row.stopped_at).toBeNull();
    expect(row.last_observed_at).toBeNull();
    expect(row.stop_requested_at).not.toBeNull();
    expect(row.provider_sandbox_id).toBe("bx_23456789");
    if (loss === "credential_stale_generation") {
      expect(row.reconcile_lease).not.toBeNull();
      expect(row.lifecycle_error).toBeNull();
      expect(row.held).toBe(false);
    } else if (loss === "transient") {
      expect(row.reconcile_lease).toBeNull();
      expect(row.lifecycle_error).toContain("Retrying");
      expect(row.held).toBe(false);
    } else {
      expect(row.reconcile_lease).toBeNull();
      expect(row.lifecycle_error).toContain("Operator cleanup required:");
      expect(row.held).toBe(true);
    }
    expect(await worker.reconcileOne()).toBe(false);
  });
}

test.each(["queued", "dispatching"])("idle-only stop preserves %s account work", async (state) => {
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
  await db.query(
    `insert into sandboxes (id, provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status)
     select $1,'boat','idle-stop-race',id,$2,$3,'claude','ready' from goldens where name='shared'`,
    [id, people.org, people.owner],
  );
  const idle = await store.get(id);
  if (!idle) throw Error("missing sandbox");
  // Queue acceptance has won since the idle observation, without changing its generation.
  await db.query(
    `insert into account_turn_queue
       (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,state)
     select $1,gen_random_uuid(),id,$2,$3,1,1,'hash',decode('00','hex'),'conversation',$4
     from credentials where scope='org' and owner_id=$3 and kind='openai'`,
    [id, people.owner, people.org, state],
  );

  const admission = { status: "stopping", stopRequested: true, onlyIfIdle: true } as const;
  const stop = (patch: typeof admission | Omit<typeof admission, "onlyIfIdle">) =>
    sandboxActivity(store, idle, patch, async () => ({
      result: "stopped",
      patch: { status: "stopped", stoppedAt: new Date().toISOString(), stopRequested: false },
    }));

  await expect(stop(admission)).rejects.toThrow("The sandbox is busy");
  expect(await store.get(id)).toMatchObject({ status: "ready", lifecycleGeneration: idle.lifecycleGeneration });
  expect((await db.query("select state from account_turn_queue where sandbox_id=$1", [id])).rows).toEqual([{ state }]);

  expect(await stop({ status: "stopping", stopRequested: true })).toBe("stopped");
  expect((await db.query("select state from account_turn_queue where sandbox_id=$1", [id])).rows).toEqual([
    { state: "failed" },
  ]);
});
