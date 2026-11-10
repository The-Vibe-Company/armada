import { expect, jest, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import { launchSandbox } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { sandbox } from "../../provider-boat/test/support.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { bunLikeSql, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const server = await harness();
  const sql = bunLikeSql(server.db);
  const data = createSqlData(sql);
  const actor = { userId: server.people.owner, orgId: server.people.org, role: "member" as const };
  const scoped = data({ via: "service", userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }] });
  const golden = (await server.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const id = crypto.randomUUID();
  const insert = () =>
    scoped.sandboxes.insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: actor.orgId,
      ownerId: actor.userId,
      harness: "claude",
      status: "ready",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      requestedTtlSeconds: 90,
      effectiveTtlSeconds: 90,
    });
  const token = await server.token(actor.userId);
  const control = (action: string, provider: ReturnType<typeof createBoatProvider>) =>
    handleControlRequest(
      new Request(PUBLIC_URL + `/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, ...(action === "send" ? { prompt: "continue" } : {}) }),
      }),
      {
        authStore: server.auth,
        supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
        store: createSqlVaultStore(sql),
        encryptionKey: ENCRYPTION_KEY,
        data,
        providers: { resolve: async () => provider },
      },
    );
  return { server, sql, scoped, actor, id, insert, control };
}

for (const fails of [false, true])
  test(`initial launch owns completion and failure publication across an observer lease (${fails})`, async () => {
    const f = await fixture();
    const setup = deferred();
    const finish = deferred();
    const observed = deferred();
    const release = deferred();
    let pending: Promise<unknown> = Promise.resolve();
    let pendingLaunch: Promise<unknown> = Promise.resolve();
    let capture = false;
    const stops: string[] = [];
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/stop")) {
          stops.push(path);
          return Response.json({ ok: true });
        }
        if (path.endsWith("/commands")) {
          setup.resolve();
          await finish.promise;
          return Response.json({
            ok: true,
            type: "command.finished",
            success: !fails,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            detached: false,
            exitCode: fails ? 1 : 0,
            stdout: "",
            stderr: fails ? "init failed" : "",
          });
        }
        if (request.method === "POST") return Response.json({ ok: true, sandbox: sandbox({ state: "idle" }) });
        if (capture) {
          capture = false;
          observed.resolve();
          await release.promise;
        }
        return Response.json({ ok: true, sandbox: sandbox({ state: "idle" }) });
      }) as typeof fetch,
    });
    try {
      const launch = launchSandbox(
        provider,
        {
          goldens: f.scoped.goldens,
          sandboxes: f.scoped.sandboxes,
          credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
        },
        f.actor,
        { golden: "shared", harness: "claude" },
        { newId: () => f.id, sleep: async () => {} },
      ).then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      );
      pendingLaunch = launch;
      await setup.promise;
      const lifecycle = createSandboxLifecycle(f.sql, async () => provider);
      expect(await lifecycle.reconcileOne()).toBe(false);
      // Process suspension can outlive ownership: completion must still CAS-fence an observer.
      await f.server.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
      capture = true;
      const observation = lifecycle.reconcileOne();
      pending = observation;
      await observed.promise;
      finish.resolve();
      const completed = await launch;
      expect(completed.error !== null).toBe(fails);
      if (!fails) expect(completed.result?.sandbox.status).toBe("ready");
      const row = await f.scoped.sandboxes.get(f.id);
      expect(row?.status).toBe(fails ? "failed" : "ready");
      expect(row?.lifecycleGeneration).toBe(2);
      if (fails) expect(row?.statusReason).toContain("init failed");
      expect(stops).toHaveLength(fails ? 1 : 0);
      release.resolve();
      await observation;
      expect((await f.scoped.sandboxes.get(f.id))?.status).toBe(fails ? "failed" : "ready");
    } finally {
      finish.resolve();
      release.resolve();
      await pending;
      await pendingLaunch;
      await f.server.close();
    }
  });

test("actual Boat resume rearms deadline even when the earlier send sample was ready", async () => {
  const f = await fixture();
  let gets = 0;
  let ready = false;
  let stops = 0;
  let resumes = 0;
  const provider = createBoatProvider({
    apiKey: "test-key",
    beforeResume: async () => true,
    beforePrompt: async () => {},
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/resume")) {
        resumes++;
        ready = true;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/stop")) {
        stops++;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/prompt"))
        return Response.json({ ok: true, promptId: "p", conversationId: "c", status: "queued" });
      return Response.json({ ok: true, sandbox: sandbox({ state: ++gets === 1 || ready ? "idle" : "archived" }) });
    }) as typeof fetch,
  });
  try {
    await f.insert();
    await f.server.db.query("update sandboxes set expires_at=now()-interval '1 second' where id=$1", [f.id]);
    expect((await f.control("send", provider))?.status).toBe(200);
    const row = await f.scoped.sandboxes.get(f.id);
    expect(row?.status).toBe("running");
    expect(row?.requestedTtlSeconds).toBe(90);
    expect(row?.effectiveTtlSeconds).toBe(90);
    expect(Date.parse(row?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(resumes).toBe(1);
    await createSandboxLifecycle(f.sql, async () => provider).reconcileOne();
    expect(stops).toBe(0);
    expect((await f.scoped.sandboxes.get(f.id))?.status).toBe("running");
  } finally {
    await f.server.close();
  }
});

for (const outcome of ["error", "unconfirmed"] as const)
  test(`failed diagnostic survives uncertain manual stop and background confirmation (${outcome})`, async () => {
    const f = await fixture();
    let attempts = 0;
    let terminal = false;
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (new URL(request.url).pathname.endsWith("/events"))
          return Response.json({ ok: true, events: [], pageInfo: { hasMore: false } });
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/stop")) {
          attempts++;
          if (attempts === 1 && outcome === "error")
            return Response.json({ error: { code: "unavailable", message: "test" } }, { status: 503 });
          terminal = attempts > 1;
          return Response.json({ ok: true });
        }
        if (request.method === "POST") return Response.json({ ok: true });
        return Response.json({ ok: true, sandbox: sandbox({ state: terminal ? "archived" : "archiving" }) });
      }) as typeof fetch,
    });
    try {
      await f.insert();
      await f.scoped.sandboxes.update(f.id, { status: "failed", statusReason: "Original initialization failure" });
      expect((await f.control("stop", provider))?.status).toBe(outcome === "error" ? 503 : 200);
      const pending = await f.scoped.sandboxes.get(f.id);
      expect(pending?.status).toBe("failed");
      expect(pending?.statusReason).toBe("Original initialization failure");
      expect(pending?.stoppedAt).toBeNull();
      const report = await f.control("status", provider);
      expect({ status: report?.status, body: report ? await report.json() : null }).toMatchObject({ status: 200 });
      expect((await f.scoped.sandboxes.get(f.id))?.statusReason).toBe("Original initialization failure");
      await f.server.db.query(
        "update sandboxes set activity_until=now()-interval '1 second',reconcile_after=now()-interval '1 second' where id=$1",
        [f.id],
      );
      await createSandboxLifecycle(f.sql, async () => provider).reconcileOne();
      const row = await f.scoped.sandboxes.get(f.id);
      expect(row?.status).toBe("failed");
      expect(row?.statusReason).toBe("Original initialization failure");
      expect(row?.stoppedAt).not.toBeNull();
      expect(attempts).toBe(2);
    } finally {
      await f.server.close();
    }
  });

test("initial launch preserves sequential 600-second setup command budgets", async () => {
  const f = await fixture();
  const budgets: number[] = [];
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      if (new URL(request.url).pathname.endsWith("/commands")) {
        const body = (await request.json()) as { timeoutSeconds: number };
        budgets.push(body.timeoutSeconds);
        // Each SDK command takes six minutes, within its existing 600s budget.
        jest.advanceTimersByTime(6 * 60_000);
        return Response.json({
          ok: true,
          type: "command.finished",
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      return Response.json({ ok: true, sandbox: sandbox({ state: "idle" }) });
    }) as typeof fetch,
  });
  try {
    jest.useFakeTimers();
    const result = await launchSandbox(
      provider,
      {
        goldens: f.scoped.goldens,
        sandboxes: f.scoped.sandboxes,
        credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
      },
      f.actor,
      { golden: "shared", harness: "claude" },
      { newId: () => f.id, sleep: async () => {} },
    );
    expect(budgets).toEqual([600, 600]);
    expect(result.sandbox.status).toBe("ready");
    expect((await f.scoped.sandboxes.get(f.id))?.status).toBe("ready");
  } finally {
    jest.useRealTimers();
    await f.server.close();
  }
});
