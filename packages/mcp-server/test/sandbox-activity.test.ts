import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { sandbox } from "../../provider-boat/test/support.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { bunLikeSql, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("send completion fences an old stopped SDK observation captured after admission expiry", async () => {
  const server = await harness();
  const resumed = deferred<void>();
  const resumeRequested = deferred<void>();
  const observed = deferred<void>();
  const oldObservation = deferred<void>();
  const sql = bunLikeSql(server.db);
  let isReady = false;
  let capture = false;
  const methods: string[] = [];
  const provider = createBoatProvider({
    apiKey: "test-key",
    beforeResume: async () => true,
    beforePrompt: async () => {},
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      methods.push(`${request.method} ${path}`);
      if (path.endsWith("/resume")) {
        expect(request.signal.aborted).toBe(false);
        resumeRequested.resolve();
        await resumed.promise;
        isReady = true;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/prompt"))
        return Response.json({ ok: true, promptId: "prompt_1", conversationId: "conv_1", status: "queued" });
      if (capture) {
        capture = false;
        observed.resolve();
        await oldObservation.promise;
        return Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) });
      }
      return Response.json({ ok: true, sandbox: sandbox({ state: isReady ? "idle" : "archived" }) });
    }) as typeof fetch,
  });
  try {
    const data = createSqlData(sql);
    const scoped = data({
      via: "service",
      userId: server.people.owner,
      orgs: [{ orgId: server.people.org, role: "member" }],
    });
    const golden = (await server.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const id = crypto.randomUUID();
    await scoped.sandboxes.insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: server.people.org,
      ownerId: server.people.owner,
      harness: "claude",
      status: "ready",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
    });
    await scoped.sandboxes.update(id, { status: "stopped", stoppedAt: new Date().toISOString() });
    const token = await server.token(server.people.owner);
    const send = handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/sandbox/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, prompt: "continue" }),
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
    await resumeRequested.promise;
    // Simulate a process pause beyond the persisted lease; no wall-clock sleep or mocked SQL oracle.
    await server.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [id]);
    capture = true;
    const observation = createSandboxLifecycle(sql, async () => provider).reconcileOne();
    await observed.promise;
    resumed.resolve();
    expect((await send)?.status).toBe(200);
    const completed = await scoped.sandboxes.get(id);
    expect(completed?.status).toBe("running");
    oldObservation.resolve();
    await observation;
    const row = await scoped.sandboxes.get(id);
    expect(row?.status).toBe("running");
    expect(row?.stoppedAt).toBeNull();
    expect(row?.lifecycleGeneration).toBe(3);
    expect(methods.filter((method) => method.includes("/resume"))).toHaveLength(1);
    expect(methods.filter((method) => method.includes("/prompt"))).toHaveLength(1);
  } finally {
    resumed.resolve();
    oldObservation.resolve();
    await server.close();
  }
});

test("accepted send with failed completion publication reports outcome unknown, not a retryable dependency outage", async () => {
  const server = await harness();
  try {
    const data = createSqlData(bunLikeSql(server.db));
    const caller = {
      via: "service" as const,
      userId: server.people.owner,
      orgs: [{ orgId: server.people.org, role: "member" as const }],
    };
    const scoped = data(caller);
    const golden = (await server.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const record = await scoped.sandboxes.insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "bx_publication",
      goldenId: golden.id,
      orgId: server.people.org,
      ownerId: server.people.owner,
      harness: "claude",
      status: "ready",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
    });
    let dispatched = 0;
    const provider = createBoatProvider({
      apiKey: "test-key",
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (new URL(request.url).pathname.endsWith("/prompt")) {
          dispatched++;
          return Response.json({ ok: true, promptId: "accepted", conversationId: "conversation", status: "queued" });
        }
        return Response.json({ ok: true, sandbox: sandbox({ id: record.providerSandboxId, state: "idle" }) });
      }) as typeof fetch,
    });
    const token = await server.token(server.people.owner);
    const response = await handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/sandbox/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: record.id, prompt: "continue" }),
      }),
      {
        authStore: server.auth,
        supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
        store: createSqlVaultStore(bunLikeSql(server.db)),
        encryptionKey: ENCRYPTION_KEY,
        data: (actor) => {
          const scoped = data(actor);
          const update = scoped.sandboxes.update.bind(scoped.sandboxes);
          scoped.sandboxes.update = async (id, patch) => {
            if (patch.finishActivity && dispatched > 0) throw new Error("private-publication-diagnostic");
            return update(id, patch);
          };
          return scoped;
        },
        providers: { resolve: async () => provider },
      },
    );
    expect(dispatched).toBe(1);
    expect(response?.status).toBe(503);
    const payload = await response!.text();
    expect(JSON.parse(payload)).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(payload).not.toContain("private-publication-diagnostic");
  } finally {
    await server.close();
  }
});
