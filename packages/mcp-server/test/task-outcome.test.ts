import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { operation } from "../../cli/src/operations.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { createNativeWebhookPrompts } from "../src/native-webhook-prompts.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { call, ENCRYPTION_KEY, type FakeBoat, harness, PUBLIC_URL } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

// Successful ready-report fixtures now include actual completed response metadata.
function finishMatched(boat: FakeBoat, promptId: string) {
  const index = Number(promptId.split("_")[1]) - 1;
  const model = boat.prompts[index]?.model;
  if (!model) throw new Error("Fixture needs an explicit requested model");
  boat.sandbox("bx_1").events.push({
    id: `response_${promptId}`,
    at: index + 1,
    kind: "message",
    promptId,
    model,
    text: "done",
    partial: false,
    tools: [],
  });
  boat.finish("bx_1", promptId, "finished");
}

// The actual MCP/control API, migrations and provider event stream own this contract.
// A field-copy unit test would not catch a missing route, stale-turn write or lifecycle clear.
test("explicit report validates the latest finished turn and persists through API status/list", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const bearer = await token(people.member);
    const mcp = await client(bearer);
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "work" });
    expect(launched.isError).toBe(false);
    const id = launched.data.id;
    const report = (outcome: unknown, prompt_id = "prompt_1") => call(mcp, "report", { id, prompt_id, outcome });
    expect((await report({ state: "ready" })).isError).toBe(true); // still running
    finishMatched(boat, "prompt_1");
    expect((await report({ state: "blocked", reason: " " })).isError).toBe(true);
    expect((await report({ state: "ready", headSha: "not-a-sha" })).isError).toBe(true);
    expect((await report({ state: "ready" }, "old-prompt")).isError).toBe(true);
    const outcome = {
      state: "ready",
      prNumber: 42,
      prUrl: "https://github.com/example/repo/pull/42",
      headSha: "a".repeat(40),
    };
    const store = createSqlVaultStore(db);
    const options = {
      authStore: server.auth,
      store,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providerFor: boat.providerFor,
      providers: providerRegistry({ vault: store, encryptionKey: ENCRYPTION_KEY, providerFor: boat.providerFor }),
    };
    const code = await operation(
      "report",
      [
        String(id),
        "ready",
        "--prompt-id",
        "prompt_1",
        "--pr-number",
        "42",
        "--pr-url",
        outcome.prUrl,
        "--head-sha",
        outcome.headSha,
      ],
      {
        env: { ARMADA_URL: PUBLIC_URL, ARMADA_TOKEN: bearer },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => undefined,
        out: () => undefined,
        err: () => undefined,
        fetch: async (input, init) => {
          const response = await handleControlRequest(new Request(String(input), init), options);
          expect(response?.status).toBe(200);
          return response ?? new Response(null, { status: 404 });
        },
      },
      async () => "",
    );
    expect(code).toBe(0);
    expect((await call(mcp, "status", { id })).data.taskOutcome).toEqual(outcome);
    expect((await call(mcp, "list")).data.sandboxes).toMatchObject([{ id, taskOutcome: outcome }]);
    expect(
      (await db.query<{ task_outcome: unknown }>("select task_outcome from sandboxes where id=$1", [id])).rows[0]
        ?.task_outcome,
    ).toEqual(outcome);
    expect((await report({ state: "blocked", reason: "Needs review" })).isError).toBe(false);
    expect((await call(mcp, "status", { id })).data.taskOutcome).toEqual({ state: "blocked", reason: "Needs review" });
  } finally {
    await server.close();
  }
});

test("send and steer clear outcomes before admission and fence replacement receipts", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "first" });
    const id = launched.data.id;
    finishMatched(boat, "prompt_1");
    expect((await call(mcp, "report", { id, prompt_id: "prompt_1", outcome: { state: "ready" } })).isError).toBe(false);
    // Observe actual SQL state at the provider boundary, not just after completion.
    const prompt = boat.provider.prompt;
    let during: unknown;
    boat.provider.prompt = async (input) => {
      during = (await db.query("select task_outcome,task_prompt_id from sandboxes where id=$1", [id])).rows[0];
      return prompt(input);
    };
    expect((await call(mcp, "send", { id, prompt: "second" })).isError).toBe(false);
    expect(during).toEqual({ task_outcome: null, task_prompt_id: null });
    expect((await call(mcp, "status", { id })).data.taskOutcome).toBeNull();
    finishMatched(boat, "prompt_2");
    expect((await call(mcp, "report", { id, prompt_id: "prompt_1", outcome: { state: "ready" } })).isError).toBe(true);
    expect(
      (
        await call(mcp, "report", {
          id,
          prompt_id: "prompt_2",
          outcome: { state: "blocked", reason: "Needs credentials" },
        })
      ).isError,
    ).toBe(false);
    // A late native continuation/restart may return a new prompt ID, even after
    // the previously observed turn finished. Its receipt, not the old ID, wins.
    boat.provider.steer = async (input) => {
      expect((await db.query("select task_outcome,task_prompt_id from sandboxes where id=$1", [id])).rows[0]).toEqual({
        task_outcome: null,
        task_prompt_id: null,
      });
      const receipt = await boat.provider.prompt({
        sandboxId: input.sandboxId,
        harness: "claude",
        text: input.text,
        conversationId: "conv_1",
      });
      return { ...receipt, promptId: "unpollable-steer-record", mode: "late" };
    };
    expect((await call(mcp, "steer", { id, text: "continue with review" })).data.promptId).toBe(
      "unpollable-steer-record",
    );
    boat.finish("bx_1", "prompt_3", "finished");
    expect((await call(mcp, "report", { id, prompt_id: "prompt_2", outcome: { state: "ready" } })).isError).toBe(true);
    // Missing model provenance is neutral and does not retroactively fail legitimate completed work.
    expect((await call(mcp, "report", { id, prompt_id: "prompt_3", outcome: { state: "ready" } })).isError).toBe(false);
    boat.provider.prompt = async () => {
      throw new Error("Ambiguous provider admission");
    };
    expect((await call(mcp, "send", { id, prompt: "unconfirmed work" })).isError).toBe(true);
    // Even after the bounded activity lease expires, no old finished turn can
    // revive the cleared outcome. Expiry is simulated rather than slept through.
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [id]);
    expect((await call(mcp, "report", { id, prompt_id: "prompt_3", outcome: { state: "ready" } })).isError).toBe(true);
    expect((await db.query("select task_outcome from sandboxes where id=$1", [id])).rows[0]).toEqual({
      task_outcome: null,
    });
  } finally {
    await server.close();
  }
});

test("a restart steer registers its replacement run so settlement exports it", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const id = (await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "first" })).data.id;
    await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'metadata',$2)", [
      people.org,
      await encryptSecret("{}", ENCRYPTION_KEY),
    ]);
    // Boat answers a restart with a steer record; the replacement run is prompt_2.
    boat.provider.steer = async (input) => {
      boat.finish(input.sandboxId, "prompt_1", "interrupted");
      const receipt = await boat.provider.prompt({ sandboxId: input.sandboxId, harness: "codex", text: input.text });
      return { ...receipt, promptId: "unpollable-steer-record", mode: "restart" };
    };
    expect((await call(mcp, "steer", { id, text: "change course" })).isError).toBe(false);
    expect((await db.query("select task_prompt_id from sandboxes where id=$1", [id])).rows[0]).toEqual({
      task_prompt_id: "prompt_2",
    });
    boat.finish("bx_1", "prompt_2", "finished");
    const native = createNativeWebhookPrompts(db, async () => boat.provider);
    while (await native.reconcileOne(new AbortController().signal));
    expect(
      (
        await db.query("select prompt_id,terminal_status from langfuse_turn_exports where sandbox_id=$1 order by 1", [
          id,
        ])
      ).rows,
    ).toEqual([
      { prompt_id: "prompt_1", terminal_status: "interrupted" },
      { prompt_id: "prompt_2", terminal_status: "finished" },
    ]);
  } finally {
    await server.close();
  }
});

test("consecutive restart steers keep the marker and export every replacement turn", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const id = (await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "first" })).data.id;
    await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'metadata',$2)", [
      people.org,
      await encryptSecret("{}", ENCRYPTION_KEY),
    ]);
    // The replacement run is not visible yet when the steer returns.
    let interrupting = "prompt_1";
    boat.provider.steer = async (input) => {
      boat.finish(input.sandboxId, interrupting, "interrupted");
      return { conversationId: "conv_1", promptId: "unpollable-steer-record", mode: "restart" };
    };
    const taskPromptId = async () =>
      (await db.query<{ task_prompt_id: string | null }>("select task_prompt_id from sandboxes where id=$1", [id]))
        .rows[0]?.task_prompt_id;
    expect((await call(mcp, "steer", { id, text: "change course" })).isError).toBe(false);
    expect(await taskPromptId()).toBe("");
    // The first replacement appears late, then a second steer interrupts it.
    await boat.provider.prompt({ sandboxId: "bx_1", harness: "codex", text: "change course" });
    interrupting = "prompt_2";
    expect((await call(mcp, "steer", { id, text: "again" })).isError).toBe(false);
    expect(await taskPromptId()).toBe("");
    const reconcile = async () => {
      await db.query("update sandboxes set reconcile_after=now() where id=$1", [id]);
      await createSandboxLifecycle(db, async () => boat.provider).reconcileOne();
    };
    // prompt_2 answers the first steer only; the second steer is still unresolved.
    await reconcile();
    expect(
      (await db.query("select after_prompt_id,pending_steers from native_steer_cursors where sandbox_id=$1", [id]))
        .rows,
    ).toEqual([{ after_prompt_id: "prompt_2", pending_steers: 1 }]);
    // The second replacement appears and finishes after that pass.
    await boat.provider.prompt({ sandboxId: "bx_1", harness: "codex", text: "again" });
    boat.finish("bx_1", "prompt_3", "finished");
    await reconcile();
    const native = createNativeWebhookPrompts(db, async () => boat.provider);
    while (await native.reconcileOne(new AbortController().signal));
    expect(
      (
        await db.query("select prompt_id,terminal_status from langfuse_turn_exports where sandbox_id=$1 order by 1", [
          id,
        ])
      ).rows,
    ).toEqual([
      { prompt_id: "prompt_1", terminal_status: "interrupted" },
      { prompt_id: "prompt_2", terminal_status: "interrupted" },
      { prompt_id: "prompt_3", terminal_status: "finished" },
    ]);
    expect(
      (await db.query("select pending_since,pending_steers from native_steer_cursors where sandbox_id=$1", [id])).rows,
    ).toEqual([{ pending_since: null, pending_steers: 0 }]);
  } finally {
    await server.close();
  }
});

test("a restart steer restarts an expired cursor from its own prior run", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const id = (await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "first" })).data.id;
    boat.finish("bx_1", "prompt_1", "finished");
    expect((await call(mcp, "send", { id, prompt: "second" })).isError).toBe(false);
    // An unresolved cursor from hours ago is outside reconciliation's window.
    await db.query(
      "insert into native_steer_cursors(sandbox_id,after_prompt_id,steer_id,pending_since,pending_steers) values($1,'prompt_1',gen_random_uuid(),now()-interval '2 hours',3)",
      [id],
    );
    boat.provider.steer = async (input) => {
      boat.finish(input.sandboxId, "prompt_2", "interrupted");
      return { conversationId: "conv_1", promptId: "unpollable-steer-record", mode: "restart" };
    };
    expect((await call(mcp, "steer", { id, text: "change course" })).isError).toBe(false);
    expect(
      (await db.query("select after_prompt_id,pending_steers from native_steer_cursors where sandbox_id=$1", [id]))
        .rows,
    ).toEqual([{ after_prompt_id: "prompt_2", pending_steers: 1 }]);
  } finally {
    await server.close();
  }
});

test("a restart steer whose replacement appears after the response still reaches export", async () => {
  const server = await harness({}, await sharedDatabase());
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const id = (await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "first" })).data.id;
    await db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'metadata',$2)", [
      people.org,
      await encryptSecret("{}", ENCRYPTION_KEY),
    ]);
    boat.provider.steer = async (input) => {
      boat.finish(input.sandboxId, "prompt_1", "interrupted");
      return { conversationId: "conv_1", promptId: "unpollable-steer-record", mode: "restart" };
    };
    expect((await call(mcp, "steer", { id, text: "change course" })).isError).toBe(false);
    expect((await db.query("select task_prompt_id from sandboxes where id=$1", [id])).rows[0]).toEqual({
      task_prompt_id: "",
    });
    // The replacement run is published only after the steer response, then finishes.
    // Its prompt event shares the original run's timestamp: only provider order separates them.
    await boat.provider.prompt({ sandboxId: "bx_1", harness: "codex", text: "change course" });
    const events = boat.sandbox("bx_1").events;
    events.find((e) => e.id === "ev_prompt_2")!.at = events.find((e) => e.id === "ev_prompt_1")!.at;
    boat.finish("bx_1", "prompt_2", "finished");
    await db.query("update sandboxes set reconcile_after=now() where id=$1", [id]);
    await createSandboxLifecycle(db, async () => boat.provider).reconcileOne();
    const native = createNativeWebhookPrompts(db, async () => boat.provider);
    while (await native.reconcileOne(new AbortController().signal));
    expect(
      (
        await db.query("select prompt_id,terminal_status from langfuse_turn_exports where sandbox_id=$1 order by 1", [
          id,
        ])
      ).rows,
    ).toEqual([
      { prompt_id: "prompt_1", terminal_status: "interrupted" },
      { prompt_id: "prompt_2", terminal_status: "finished" },
    ]);
    expect(
      (await db.query("select after_prompt_id,pending_since from native_steer_cursors where sandbox_id=$1", [id])).rows,
    ).toEqual([{ after_prompt_id: "prompt_2", pending_since: null }]);
  } finally {
    await server.close();
  }
});
