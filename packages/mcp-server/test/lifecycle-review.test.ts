import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { retainedSandbox, sandbox } from "../../provider-boat/test/support.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { bunLikeSql, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

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
      return Response.json({
        ok: true,
        sandbox: ++gets === 1 || ready ? sandbox({ state: "idle" }) : retainedSandbox(),
      });
    }) as unknown as typeof fetch,
  });
  try {
    await f.insert();
    await f.server.db.query("update sandboxes set expires_at=now()+interval '1 hour' where id=$1", [f.id]);
    // The rearm computes its deadline from the database clock, so bound it with
    // database clock samples taken around the send, never the runner's clock.
    const dbNow = async () =>
      (await f.server.db.query<{ ms: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms"))
        .rows[0]!.ms;
    const before = await dbNow();
    expect((await f.control("send", provider))?.status).toBe(200);
    const after = await dbNow();
    const row = await f.scoped.sandboxes.get(f.id);
    expect(row?.status).toBe("running");
    expect(row?.requestedTtlSeconds).toBe(90);
    expect(row?.effectiveTtlSeconds).toBe(90);
    // A rearm leaves exactly one TTL between the send and the deadline; the
    // seeded one-hour deadline would fall outside these bounds.
    const deadline = Date.parse(row?.expiresAt ?? "");
    expect(deadline).toBeGreaterThanOrEqual(Math.floor(before) + 90_000);
    expect(deadline).toBeLessThanOrEqual(Math.ceil(after) + 90_000);
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
      }) as unknown as typeof fetch,
    });
    try {
      await f.insert();
      await f.server.db.query("update sandboxes set status='failed',status_reason=$2 where id=$1", [
        f.id,
        "Original initialization failure",
      ]);
      expect((await f.control("stop", provider))?.status).toBe(outcome === "error" ? 502 : 200);
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
      // Boat completes its already-started archival independently; reconciliation
      // must confirm it, not dispatch another stop to force this fixture forward.
      terminal = true;
      await createSandboxLifecycle(f.sql, async () => provider).reconcileOne();
      const row = await f.scoped.sandboxes.get(f.id);
      expect(row?.status).toBe("failed");
      expect(row?.statusReason).toBe("Original initialization failure");
      expect(row?.stoppedAt).not.toBeNull();
      expect(attempts).toBe(1);
    } finally {
      await f.server.close();
    }
  });

test("manual stop retires an interrupted registration whose exact provider identity is absent", async () => {
  const f = await fixture();
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async () =>
      Response.json(
        { error: { code: "sandbox_not_found", message: "Absent" } },
        { status: 404 },
      )) as unknown as typeof fetch,
  });
  try {
    await f.insert();
    await f.server.db.query("update sandboxes set status='starting' where id=$1", [f.id]);
    expect((await f.control("stop", provider))?.status).toBe(200);
    const pending = await f.scoped.sandboxes.get(f.id);
    expect(pending?.status).toBe("stopping");
    expect(pending?.stoppedAt).toBeNull();
    expect(await createSandboxLifecycle(f.sql, async () => provider).reconcileOne()).toBe(true);
    const settled = await f.scoped.sandboxes.get(f.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.stoppedAt).not.toBeNull();
  } finally {
    await f.server.close();
  }
});
