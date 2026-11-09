import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("CLI/shared launch prepares persisted native repo cwd before idle/first prompts, retaining plain sends and models across resume", async () => {
  const server = await harness();
  try {
    const { people, db, boat } = server;
    await db.query("update goldens set config = $1::jsonb where name = 'shared'", [
      JSON.stringify({
        repos: [
          { url: "https://github.com/example/web.git", branch: "main", dir: "web" },
          { url: "https://github.com/example/api.git", branch: "main", dir: "api" },
        ],
        init: ["echo repository init"],
      }),
    ]);
    const prepare = boat.provider.prepareNativeHarnessCwd;
    if (!prepare) throw new Error("Missing native preparation fixture.");
    boat.provider.prepareNativeHarnessCwd = async (request) => {
      const row = (
        await db.query<{ repository_dir: string }>(
          "select repository_dir from sandboxes where provider_sandbox_id = $1",
          [request.sandboxId],
        )
      ).rows[0];
      expect(request.cwd).toBe(`/home/user/${row?.repository_dir}`);
      expect(boat.execs.length).toBeGreaterThan(0);
      if (boat.preparations.length === 0) {
        expect(boat.prompts).toHaveLength(0);
        expect(boat.execs.at(-1)?.command).toContain("repository init");
      }
      await prepare(request);
    };
    const token = await server.token(people.member);
    const store = createSqlVaultStore(db);
    const options: ControlOptions = {
      authStore: server.auth,
      store,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providerFor: boat.providerFor,
      providers: providerRegistry({ vault: store, encryptionKey: ENCRYPTION_KEY, providerFor: boat.providerFor }),
    };
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let output = "";
    const auth: AuthIo = {
      env: { ARMADA_URL: PUBLIC_URL, ARMADA_TOKEN: token },
      session: memorySessionStore(),
      now: () => new Date(),
      open: () => undefined,
      out: (text) => {
        output += text;
      },
      err: () => undefined,
      fetch: async (input, init) => {
        const request = new Request(String(input), init);
        requests.push({
          path: new URL(request.url).pathname,
          body: (await request.clone().json()) as Record<string, unknown>,
        });
        return (await handleControlRequest(request, options)) ?? new Response(null, { status: 404 });
      },
    };
    const code = await run(
      [
        "launch",
        "shared",
        "--agent",
        "codex",
        "--repo",
        "api",
        "--model",
        "gpt-6.1-terra",
        "--reasoning-effort",
        "high",
        "--json",
      ],
      { out: auth.out, err: auth.err },
      { auth },
    );
    expect(code).toBe(0);
    const launched = JSON.parse(output);
    expect(launched).toMatchObject({
      repositoryDir: "api",
      model: "gpt-6.1-terra",
      reasoningEffort: "high",
      status: "ready",
      provider: "boat",
    });
    expect(boat.preparations).toEqual([
      { sandboxId: launched.providerSandboxId, harness: "codex", cwd: "/home/user/api" },
    ]);
    expect(requests[0]).toMatchObject({ path: "/api/v1/sandbox/launch", body: { repo: "api" } });
    expect(boat.prompts).toHaveLength(0);
    expect(
      await run(
        ["send", launched.id, "change context", "--repo", "web", "--json"],
        { out: auth.out, err: auth.err },
        { auth },
      ),
    ).toBe(2);
    expect(requests).toHaveLength(1);
    expect(
      (await db.query<{ repository_dir: string }>("select repository_dir from sandboxes where id = $1", [launched.id]))
        .rows[0]?.repository_dir,
    ).toBe("api");
    await expect(db.query("update sandboxes set repository_dir = 'web' where id = $1", [launched.id])).rejects.toThrow(
      "immutable",
    );
    const client = await server.client(token);
    const first = await call(client, "send", { id: launched.id, prompt: "first" });
    expect(first.isError).toBe(false);
    await call(client, "stop", { id: launched.id });
    // A later golden edit must not change the immutable context of an existing sandbox.
    await db.query("update goldens set config = $1::jsonb where name = 'shared'", [
      JSON.stringify({ repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] }),
    ]);
    await call(client, "send", { id: launched.id, prompt: "resume" });
    await call(client, "send", {
      id: launched.id,
      prompt: "new conversation",
      conversation_id: "another-conversation",
      model: "gpt-6-luna",
      reasoning_effort: "low",
    });
    const steered = await call(client, "steer", { id: launched.id, text: "adjust" });
    expect(steered.isError).toBe(false);
    await call(client, "send", { id: launched.id, prompt: "back" });
    expect(boat.prompts.map(({ text, model, reasoningEffort }) => ({ text, model, reasoningEffort }))).toEqual([
      { text: "first", model: "gpt-6.1-terra", reasoningEffort: "high" },
      { text: "resume", model: "gpt-6.1-terra", reasoningEffort: "high" },
      { text: "new conversation", model: "gpt-6-luna", reasoningEffort: "low" },
      { text: "back", model: "gpt-6.1-terra", reasoningEffort: "high" },
    ]);
    expect(boat.steers.at(-1)?.text).toBe("adjust");
    const detail = await handleControlRequest(
      new Request(`${PUBLIC_URL}/api/v1/sandbox/detail`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: launched.id }),
      }),
      options,
    );
    expect(await detail?.json()).toMatchObject({
      repositoryDir: "api",
      model: "gpt-6.1-terra",
      reasoningEffort: "high",
    });
    expect((await call(client, "list")).data.sandboxes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: launched.id, canOpen: true })]),
    );
    // MCP first-prompt launch uses the identical persisted field and native preparation.
    const immediate = await call(client, "launch", {
      golden: "shared",
      harness: "codex",
      repo: "web",
      prompt: "start",
    });
    expect(immediate.data.repositoryDir).toBe("web");
    expect(boat.prompts.at(-1)?.text).toBe("start");
    const legacySelector = await call(client, "launch", {
      golden: "shared",
      harness: "codex",
      repo: "EXAMPLE/web",
      prompt: "legacy selector",
    });
    expect(legacySelector.isError).toBe(false);
    expect(legacySelector.data.repositoryDir).toBe("web");
    expect(boat.preparations.at(-1)).toMatchObject({ harness: "codex", cwd: "/home/user/web" });
    expect(boat.prompts.at(-1)?.text).toBe("legacy selector");
    const preparedCount = boat.preparations.length;
    const legacy = await call(client, "launch", { golden: "shared", harness: "codex", prompt: "plain" });
    expect(legacy.data.repositoryDir).toBeNull();
    expect(boat.preparations).toHaveLength(preparedCount);
    expect(boat.prompts.at(-1)?.text).toBe("plain");
    const forks = boat.forks.length;
    for (const repo of ["unknown", "../web", "/home/user/web", "web/subdir", "web;echo unsafe"]) {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandbox/launch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ golden: "shared", harness: "codex", repo }),
        }),
        options,
      );
      if (!response) throw new Error("Missing launch response.");
      expect([400, 404]).toContain(response.status);
      expect((await call(client, "launch", { golden: "shared", harness: "codex", repo })).isError).toBe(true);
    }
    expect((await call(client, "launch", { golden: "mine", harness: "codex", repo: "web" })).isError).toBe(true);
    expect(boat.forks).toHaveLength(forks);
    await db.query("update goldens set config = $1::jsonb where name = 'shared'", [
      JSON.stringify({
        repos: [
          { url: "https://github.com/example/web.git", branch: "main", dir: "left" },
          { url: "https://github.com/example/web.git", branch: "main", dir: "right" },
        ],
        init: [],
      }),
    ]);
    const ambiguous = await call(client, "launch", { golden: "shared", harness: "codex", repo: "example/web" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("ambiguous");
    expect(boat.forks).toHaveLength(forks);
    await db.query("update goldens set config = $1::jsonb where name = 'shared'", [
      JSON.stringify({ repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] }),
    ]);
    delete boat.provider.prepareNativeHarnessCwd;
    expect((await call(client, "launch", { golden: "shared", harness: "codex", repo: "web" })).isError).toBe(true);
    expect(boat.forks).toHaveLength(forks);
    boat.provider.prepareNativeHarnessCwd = async () => {
      throw new Error("native preparation failed");
    };
    const failed = await call(client, "launch", { golden: "shared", harness: "codex", repo: "web" });
    expect(failed.isError).toBe(true);
    expect(boat.prompts.at(-1)?.text).toBe("plain");
    expect(boat.stops).toContain(`bx_${boat.forks.length}`);
    // The database also rejects bypassing the launch validator.
    await expect(
      db.query(
        "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,repository_dir) select $1,'bx_invalid_context',golden_id,org_id,owner_id,harness,'ready','../web' from sandboxes where id = $2",
        [crypto.randomUUID(), launched.id],
      ),
    ).rejects.toThrow("configured golden repository");
  } finally {
    await server.close();
  }
});
