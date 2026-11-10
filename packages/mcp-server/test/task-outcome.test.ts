import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import { operation } from "../../cli/src/operations.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

// The actual MCP/control API, migrations and provider event stream own this contract.
// A field-copy unit test would not catch a missing route, stale-turn write or lifecycle clear.
test("explicit report validates the latest finished turn and persists through API status/list", async () => {
  const server = await harness();
  try {
    const { client, token, people, boat, db } = server;
    const bearer = await token(people.member);
    const mcp = await client(bearer);
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "work" });
    expect(launched.isError).toBe(false);
    const id = launched.data.id;
    const report = (outcome: unknown, prompt_id = "prompt_1") => call(mcp, "report", { id, prompt_id, outcome });
    expect((await report({ state: "ready" })).isError).toBe(true); // still running
    boat.finish("bx_1", "prompt_1", "finished");
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

test("new send clears an outcome before provider admission and rejects stale reporters", async () => {
  const server = await harness();
  try {
    const { client, token, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "first" });
    const id = launched.data.id;
    boat.finish("bx_1", "prompt_1", "finished");
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
    boat.finish("bx_1", "prompt_2", "finished");
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
  } finally {
    await server.close();
  }
});
