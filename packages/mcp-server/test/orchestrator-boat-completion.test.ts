import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { OrchestratorRuntime } from "../src/orchestrator-runtime.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database } from "./support.ts";

// #847: a finished Boat turn must reach the orchestrator stream without any follow-up send, or
// every client keeps showing the agent as working and steers a turn that has ended.
test("a Boat turn updated in place is published as finished once the provider reports it done", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const id = "bx_23456789";
  let promptRun = { promptId: "prompt-1", conversationId: "conv-1", status: "running", done: false };
  const provider = createBoatProvider({
    apiKey: "synthetic-org-boat-key",
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/events"))
        // Boat updates a prompt event in place: the turn appears once, as running, and no newer
        // event follows it when it finishes.
        return Response.json({
          ok: true,
          events: url.searchParams.has("cursor")
            ? []
            : [
                {
                  id: "evt-prompt-1",
                  timestamp: 1,
                  type: "prompt",
                  conversationId: "conv-1",
                  taskId: "prompt-1",
                  data: { status: "running", prompt: "Ca va ?" },
                },
              ],
          pageInfo: { hasMore: false },
        });
      if (url.pathname.endsWith("/prompts/prompt-1")) return Response.json({ ok: true, promptRun });
      return Response.json({ ok: true, sandbox: { id, name: "parent", state: "running", labels: {} } });
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
    const message = await core.reserveOrchestratorOperation(sql, {
      orchestratorId: created.identity.id,
      actorId: p.owner,
      action: "message",
      key: "sdk-message",
      digest: "1".repeat(64),
      expectedRevision: 1,
    });
    await sql.query("update orchestrator_operations set state='succeeded',runtime_result=$2::jsonb where id=$1", [
      message.id,
      JSON.stringify({ kind: "prompt_receipt", promptId: "prompt-1", conversationId: "conv-1", status: "queued" }),
    ]);
    const statuses = async () =>
      (await store.events(p.owner, p.org, created.identity.id)).events.flatMap((event) =>
        event.kind === "agent" && event.event.kind === "prompt" && event.event.promptId === "prompt-1"
          ? [event.event.status]
          : [],
      );

    await runtime.collectEvents(p.owner, p.org, created.identity.id);
    expect(await statuses()).toEqual(["running"]);

    promptRun = { ...promptRun, status: "finished", done: true };
    await runtime.collectEvents(p.owner, p.org, created.identity.id);
    // The latest status of the turn is now finished, with no steer or message sent.
    expect(await statuses()).toEqual(["running", "finished"]);

    await runtime.collectEvents(p.owner, p.org, created.identity.id);
    expect(await statuses()).toEqual(["running", "finished"]);
  } finally {
    await db.close();
  }
});
