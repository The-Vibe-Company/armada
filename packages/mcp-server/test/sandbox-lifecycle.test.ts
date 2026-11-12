import { expect, test } from "bun:test";
import { createBoatProvider } from "@armada/provider-boat";
import { sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { sandboxActivity } from "../src/sandbox-activity.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { bunLikeSql, database } from "./support.ts";

test("an expired observation lease cannot publish a delayed terminal result", async () => {
  const { db, people } = await database();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let lifecycle: ReturnType<typeof createSandboxLifecycle> | undefined;
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
        return Response.json({ ok: true, sandbox: sandbox({ state: observations === 1 ? "archived" : "running" }) });
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
    const tick = lifecycle.reconcileOne(controller.signal);
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
    await lifecycle?.drain();
    await db.close();
  }
});

// Primary regression owner: actual SDK HTTP decoding plus migrated SQL persistence.
for (const outcome of [
  "external-stop",
  "expired",
  "expired-external-stop",
  "interrupt-pending",
  "unconfirmed",
  "stop-error",
  "stale",
  "manual-stop",
] as const) {
  test(`lifecycle reconciles Boat ${outcome} without deleting retained data`, async () => {
    const { db, people } = await database();
    try {
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
      if (outcome !== "external-stop" && outcome !== "stale" && outcome !== "manual-stop")
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
            sandbox: sandbox({
              state:
                stopped || outcome === "external-stop" || outcome === "expired-external-stop" || outcome === "stale"
                  ? "archived"
                  : "running",
            }),
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
        }>("select * from sandboxes where id=$1", [id])
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
      // Without a provider timestamp, confirmed stops close the observed interval locally.
      if (["external-stop", "expired", "expired-external-stop", "manual-stop"].includes(outcome)) {
        expect(row.usage_runtime_seconds).not.toBeNull();
        expect(row.usage_runtime_seconds!).toBeGreaterThanOrEqual(0);
      }
      if (outcome === "unconfirmed" || outcome === "stop-error" || outcome === "interrupt-pending")
        expect(row.lifecycle_error).toContain("Retrying");
      expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
      expect(requests.filter((r) => r.startsWith("POST") && r.endsWith("/stop")).length).toBe(
        outcome === "external-stop" ||
          outcome === "expired-external-stop" ||
          outcome === "stale" ||
          outcome === "interrupt-pending"
          ? 0
          : 1,
      );
    } finally {
      await db.close();
    }
  });
}

for (const observation of ["stopped", "expired", "unavailable"] as const) {
  test(`failed launch reason survives terminal reconciliation (${observation})`, async () => {
    const { db, people } = await database();
    try {
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
          return Response.json({ ok: true, sandbox: sandbox({ state: stopped ? "archived" : "running" }) });
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
        const resumed = await store.get(id);
        expect(resumed?.stoppedAt).toBeNull();
        expect(resumed?.status).toBe("running");
        expect(resumed?.lifecycleGeneration).toBe(3);
        expect(Date.parse(resumed?.expiresAt ?? "")).toBeGreaterThan(Date.now());
        const beforeObservation = methods.length;
        expect(await lifecycle.reconcileOne()).toBe(true);
        expect(resolutions).toBe(2);
        expect(methods.slice(beforeObservation)).toEqual(["GET"]);
        expect((await store.get(id))?.status).toBe("running");
      }
    } finally {
      await db.close();
    }
  });
}

test("replicas lease one observation and resume admission fences old writes while retaining requested TTL", async () => {
  const { db, people } = await database();
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
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
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
        await gate;
        return Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) });
      }) as typeof fetch,
    });
    const worker = createSandboxLifecycle(sql, async () => provider);
    const first = worker.reconcileOne();
    await observing;
    await worker.reconcileOne();
    expect(observations).toBe(1);
    await expect(
      data.sandboxes.update(id, { renewLifecycle: true, advanceGeneration: true, expectedGeneration: 1 }),
    ).rejects.toThrow();
    release?.();
    await first;
    const activityToken = crypto.randomUUID();
    await data.sandboxes.update(id, {
      renewLifecycle: true,
      advanceGeneration: true,
      activityToken,
      expectedGeneration: 1,
    });
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
    expect(Date.parse(row?.expiresAt ?? "") - Date.now()).toBeGreaterThan(85000);
  } finally {
    await db.close();
  }
});

test("timed-out provider observations stay bounded until their raw work settles", async () => {
  const { db, people } = await database();
  const arrived = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const held = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  let lifecycle: ReturnType<typeof createSandboxLifecycle> | undefined;
  try {
    const sql = bunLikeSql(db);
    const store = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    }).sandboxes;
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await store.insert({
        id,
        provider: "boat",
        providerSandboxId: `bx_2345678${i}`,
        goldenId: golden.id,
        orgId: people.org,
        ownerId: people.owner,
        harness: "claude",
        status: "running",
        model: "test",
        reasoningEffort: "medium",
        effectiveTtlSeconds: 3600,
      });
    }
    let calls = 0;
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (input: Request | string | URL) => {
        const index = calls++;
        arrived[index]?.resolve();
        if (index < held.length) await held[index]?.promise;
        return Response.json({
          ok: true,
          sandbox: sandbox({
            id: new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1),
            state: index < held.length ? "archived" : "running",
          }),
        });
      }) as typeof fetch,
    });
    lifecycle = createSandboxLifecycle(sql, async () => provider);
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const tick = lifecycle.reconcileOne(controller.signal);
      await arrived[i]?.promise;
      controller.abort();
      expect(await tick).toBe(true);
    }
    expect(await lifecycle.reconcileOne()).toBe(false);
    expect(calls).toBe(4);
    expect(
      (await db.query("select id from sandboxes where id=any($1::uuid[]) and reconcile_lease is null", [ids])).rows,
    ).toHaveLength(1);
    for (const gate of held) gate.resolve();
    await lifecycle.drain();
    // Late archived responses cannot turn the aborted observations into terminal writes.
    expect(
      (await db.query("select id from sandboxes where id=any($1::uuid[]) and status='running'", [ids])).rows,
    ).toHaveLength(5);
    expect(await lifecycle.reconcileOne()).toBe(true);
    expect(calls).toBe(5);
  } finally {
    for (const gate of held) gate.resolve();
    await lifecycle?.drain();
    await db.close();
  }
});
