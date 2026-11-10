import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { createBoatBestEffortAdapter } from "../src/orchestrator-boat-best-effort.ts";
import { OrchestratorRuntime } from "../src/orchestrator-runtime.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { latestPrompt } from "../src/turns.ts";
import { database } from "./support.ts";

// Transport regression owner: do not replace the provider with a method fake.
// Comparing the real SDK's HTTP requests catches unsupported managed-only fields.
test("Boat owner polling and stopped-history use ordinary SDK requests and bounded pages", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const id = "bx_23456789";
  const requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    authorization: string | null;
  }[] = [];
  let historyReading = false;
  const provider = createBoatProvider({
    apiKey: "synthetic-org-boat-key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init?.body ?? null,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      let body: unknown = { ok: true };
      if (url.pathname.endsWith("/events")) {
        const firstOrdinary = !url.searchParams.has("conversation") && !url.searchParams.has("cursor");
        const firstHistory = historyReading && url.searchParams.get("cursor") === "opaque-next";
        body = {
          ok: true,
          events: [],
          pageInfo: {
            hasMore: firstOrdinary || firstHistory,
            ...(firstOrdinary ? { nextCursor: "opaque-next" } : firstHistory ? { nextCursor: "history-end" } : {}),
          },
        };
      } else if (url.pathname.endsWith("/stop")) body = { ok: true, id, stop: { id: "stop-1", status: "pending" } };
      else if (url.pathname.endsWith("/stops/stop-1"))
        body = { ok: true, id, stop: { id: "stop-1", status: "completed" } };
      else body = { ok: true, sandbox: { id, name: "parent", state: "archived", labels: {} } };
      return Response.json(body);
    }) as typeof fetch,
  });
  try {
    const golden = (await core.createSqlGoldenStore(sql).list(p.org)).find((g) => g.name === "shared")!;
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const created = await store.create({
      ownerId: p.owner,
      key: "sdk-create",
      skillRevision: "a".repeat(40),
      configuration: {
        version: 1,
        orgId: p.org,
        name: "sdk-parent",
        goldenId: golden.id,
        provider: "boat",
        harness: "codex",
        model: "gpt-6.1-sol",
        modelAccountId: crypto.randomUUID(),
      },
    });
    const saved = await core.createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      orgId: p.org,
      ownerId: p.owner,
      goldenId: golden.id,
      provider: "boat",
      providerSandboxId: id,
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      harness: "codex",
      status: "ready",
      visibility: "private",
    });
    await sql.query("update orchestrators set sandbox_id=$2,state='ready' where id=$1", [
      created.identity.id,
      saved.id,
    ]);
    await sql.query("update sandboxes set lifecycle_generation=1,orchestrator_native_generation='boot-1' where id=$1", [
      saved.id,
    ]);
    await sql.query("update orchestrator_operations set state='succeeded' where id=$1", [created.operation.id]);
    await sql.query("update orchestrator_runtime set conversation_id='conv-1' where orchestrator_id=$1", [
      created.identity.id,
    ]);
    const runtime = new OrchestratorRuntime({
      store,
      skillRevision: "a".repeat(40),
      authority: new core.OrchestratorAuthority(sql, async () => {}),
      resolveBackend: async () => ({
        provider,
        projectDir: "/home/user",
        mcpUrl: "https://armada.invalid/mcp",
        consent: { scopes: [], goldenIds: [], credentialIds: [] },
        assertNativeProof: async () => {},
        revalidate: async () => {},
        launch: async () => {},
      }),
    });
    await latestPrompt(provider, id);
    await runtime.collectEvents(p.owner, p.org, created.identity.id);
    const ordinary = requests[0]!;
    const ordinaryCursor = requests[1]!;
    const managed = requests[2]!;
    expect(ordinary.query).toEqual({ sort: "asc", limit: "200" });
    expect(managed).toEqual({ ...ordinary, query: { ...ordinary.query, conversation: "conv-1" } });
    expect(managed.authorization).toBe("Bearer synthetic-org-boat-key");
    expect(ordinaryCursor.query).toEqual({ ...ordinary.query, cursor: "opaque-next" });
    await sql.query("update orchestrator_runtime set provider_cursor='opaque-next' where orchestrator_id=$1", [
      created.identity.id,
    ]);
    await runtime.collectEvents(p.owner, p.org, created.identity.id);
    const managedCursor = requests[3]!;
    expect(managedCursor).toEqual({ ...ordinaryCursor, query: { ...ordinaryCursor.query, conversation: "conv-1" } });

    const operation = await core.reserveOrchestratorOperation(sql, {
      orchestratorId: created.identity.id,
      actorId: p.owner,
      action: "stop",
      key: "sdk-stop",
      digest: "0".repeat(64),
      expectedRevision: 1,
    });
    const machine = {
      orchestratorId: created.identity.id,
      sandboxId: saved.id,
      providerSandboxId: id,
      generation: "1",
      physicalGeneration: "boot-1",
    };
    await sql.query("update sandboxes set stop_requested_at=now() where id=$1", [saved.id]);
    await sql.query("update orchestrator_operations set runtime_result=$2::jsonb where id=$1", [
      operation.id,
      JSON.stringify({ kind: "boat_retirement", ...machine }),
    ]);
    await provider.stop({ sandboxId: id });
    const adapter = createBoatBestEffortAdapter({ sql, mcpUrl: "https://armada.invalid/mcp" });
    historyReading = true;
    const receipt = await adapter
      .managed(provider, machine, { ownerId: p.owner, orgId: p.org, goldenId: golden.id, provider: "boat" })
      .checkpointAndStop(machine, operation.id);
    expect(receipt.state).toBe("stopped");
    const stops = requests.filter((request) => request.method === "POST" && request.path.endsWith("/stop"));
    expect(stops).toHaveLength(2);
    expect(stops[1]).toEqual(stops[0]);
    expect(stops[0]).toMatchObject({ path: `/api/v1/sandboxes/${id}/stop`, body: null });
    const history = requests.filter((request) => request.path.endsWith("/events")).slice(4);
    expect(history).toEqual([
      managedCursor,
      { ...managedCursor, query: { ...managedCursor.query, cursor: "history-end" } },
    ]);
    expect(
      (
        await sql.query<{ provider_cursor: string }>(
          "select provider_cursor from orchestrator_runtime where orchestrator_id=$1",
          [created.identity.id],
        )
      ).rows[0]?.provider_cursor,
    ).toBe("history-end");
  } finally {
    await db.close();
  }
});
