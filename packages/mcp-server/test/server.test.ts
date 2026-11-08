import { afterEach, describe, expect, test } from "bun:test";
import { createServiceStore, createSqlAuthStore } from "@armada/auth";
import { bunLikeSql, call, harness, PUBLIC_URL, SECRETS, type TestServer } from "./support.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: Parameters<typeof harness>[0] = {}) {
  server = await harness(options);
  return server;
}

const allSecrets = Object.values(SECRETS);

function expectNoSecret(text: string) {
  for (const secret of allSecrets) expect(text).not.toContain(secret);
}

/** The dashboard's way in: plain JSON-RPC posts, one tool call each, with the person's bearer. */
function rpc(handler: TestServer["handler"], bearer: string) {
  let next = 1;
  const post = (body: unknown) =>
    handler(
      new Request(`${PUBLIC_URL}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    post,
    async tool(name: string, args: Record<string, unknown>) {
      const response = await post({
        jsonrpc: "2.0",
        id: next++,
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (response.status !== 200) return { status: response.status, result: null };
      const body = (await response.json()) as {
        result: { isError?: boolean; structuredContent?: Record<string, unknown> };
      };
      return { status: 200, result: body.result };
    },
  };
}

describe("http", () => {
  test("/healthz answers without a token", async () => {
    const { handler } = await start();
    const response = await handler(new Request(`${PUBLIC_URL}/healthz`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("the OAuth routes are mounted before /mcp", async () => {
    const { handler } = await start();
    const response = await handler(new Request(`${PUBLIC_URL}/.well-known/oauth-protected-resource`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp` });
  });

  test("a mounted route answers its paths and leaves the others to /mcp", async () => {
    const { handler } = await start({
      routes: [
        async (request) => (new URL(request.url).pathname === "/api/v1/org/list" ? Response.json({ orgs: [] }) : null),
      ],
    });
    expect(await (await handler(new Request(`${PUBLIC_URL}/api/v1/org/list`, { method: "POST" }))).json()).toEqual({
      orgs: [],
    });
    expect((await handler(new Request(`${PUBLIC_URL}/mcp`, { method: "POST" }))).status).toBe(401);
  });

  test("/mcp without a valid token is the OAuth challenge", async () => {
    const { handler } = await start();
    for (const authorization of [undefined, "Bearer armada_sk_not-a-real-token-but-long-enough-000000000"]) {
      const response = await handler(
        new Request(`${PUBLIC_URL}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
          body: "{}",
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
      );
    }
  });

  test("a revoked token fails on the next request: nothing is cached", async () => {
    const { token, client, auth, people } = await start();
    const secret = await token(people.member);
    const mcp = await client(secret);
    expect((await call(mcp, "golden_list")).isError).toBe(false);
    const [row] = (await auth.listServiceTokens(people.member)) as { id: string }[];
    await auth.revokeToken("service", {
      id: row?.id ?? "",
      userId: people.member,
      revokedAt: new Date().toISOString(),
    });
    await expect(mcp.callTool({ name: "golden_list", arguments: {} })).rejects.toThrow();
  });

  test("the dashboard's plain JSON-RPC calls work: initialize, then tools/call", async () => {
    const { handler, token, people } = await start();
    const { post } = rpc(handler, await token(people.member));
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dashboard", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "armada" } } });
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list", arguments: {} } });
    expect(await listed.json()).toMatchObject({ id: 2, result: { structuredContent: { sandboxes: [] } } });
  });

  test("a Supabase session drives the dashboard's tools, checked by Supabase on every request", async () => {
    const { handler, session, signOut, supabaseCalls, people, boat, client, token } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      golden: "shared",
      harness: "claude",
      prompt: "go",
    });
    const jwt = session(people.member);
    const dashboard = rpc(handler, jwt);

    const logs = await dashboard.tool("logs", { id: launched.data.id });
    expect(logs.result?.isError).toBeUndefined();
    expect(logs.result?.structuredContent).toMatchObject({ events: [expect.objectContaining({ kind: "prompt" })] });
    boat.finish("bx_1", "prompt_1", "finished");
    const sent = await dashboard.tool("send", { id: launched.data.id, prompt: "and the tests" });
    expect(sent.result?.structuredContent).toMatchObject({ promptId: "prompt_2", conversationId: "conv_1" });
    const stopped = await dashboard.tool("stop", { id: launched.data.id });
    expect(stopped.result?.structuredContent).toMatchObject({ status: "stopped" });
    expect(supabaseCalls).toHaveLength(3);

    signOut(jwt);
    expect((await dashboard.tool("list", {})).status).toBe(401);
  });

  test("a bearer Supabase refuses is the OAuth challenge, and Supabase being down is a 503", async () => {
    const { handler, session, supabaseDown, people } = await start();
    const forged = await rpc(handler, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged").post({});
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toContain("resource_metadata=");
    const jwt = session(people.member);
    supabaseDown(true);
    expect((await rpc(handler, jwt).tool("list", {})).status).toBe(503);
  });
});

describe("when the auth lookup fails", () => {
  const SERVICE_KEY = "service-role-key-that-supabase-rejects";

  test("a rejected PostgREST key is a 503 whose real cause is logged, without the token or the key", async () => {
    const lines: string[] = [];
    const rejecting = createServiceStore({
      env: { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY },
      fetch: async () =>
        Response.json(
          { message: "Invalid API key" },
          { status: 401, headers: { "sb-error-code": "UNAUTHORIZED_INVALID_API_KEY" } },
        ),
    });
    const { handler, session, people } = await start({ authStore: () => rejecting, log: (line) => lines.push(line) });
    const jwt = session(people.member);
    const response = await rpc(handler, jwt).tool("list", {});
    expect(response.status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Supabase answered 401 (UNAUTHORIZED_INVALID_API_KEY) for GET members");
    expect(lines[0]).not.toContain(jwt);
    expect(lines[0]).not.toContain(SERVICE_KEY);
  });

  test("a database failure on an Armada token is a 503 with its cause logged", async () => {
    const lines: string[] = [];
    const broken = createSqlAuthStore({
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    });
    const { handler, token, people } = await start({ authStore: () => broken, log: (line) => lines.push(line) });
    const response = await rpc(handler, await token(people.member)).tool("list", {});
    expect(response.status).toBe(503);
    expect(lines.join("\n")).toContain("connection terminated unexpectedly");
  });

  test("the memberships of a Supabase session come from the server's own database connection", async () => {
    const { handler, session, people } = await start({ authStore: (db) => createSqlAuthStore(db) });
    const jwt = session(people.member, []);
    const listed = await rpc(handler, jwt).tool("golden_list", {});
    expect(listed.result?.isError).toBeUndefined();
    const content = listed.result?.structuredContent as { goldens: { name: string }[] };
    const names = content.goldens.map((g) => g.name);
    expect(names.sort()).toEqual(["elsewhere", "shared"]);
  });
});

describe("on the database client production uses", () => {
  test("a Supabase session drives every tool when the driver refuses raw array parameters", async () => {
    const { session, client, boat, people } = await start({
      sql: (db) => bunLikeSql(db),
      authStore: (db) => createSqlAuthStore(bunLikeSql(db)),
    });
    const mcp = await client(session(people.member, []));

    const goldens = await call(mcp, "golden_list");
    expect(goldens.isError).toBe(false);
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    expect(launched.isError).toBe(false);

    const listed = await call(mcp, "list");
    expect(listed.isError).toBe(false);
    expect(listed.data.sandboxes).toHaveLength(1);
    expect((await call(mcp, "list", { status: ["ready", "running"] })).isError).toBe(false);
    expect((await call(mcp, "status", { id: launched.data.id })).isError).toBe(false);
    expect((await call(mcp, "logs", { id: launched.data.id })).isError).toBe(false);
    boat.finish("bx_1", "prompt_1", "finished");
    const waited = await call(mcp, "wait", { id: launched.data.id, timeoutSeconds: 5 });
    expect(waited.isError).toBe(false);
    expect((await call(mcp, "send", { id: launched.data.id, prompt: "and the tests" })).isError).toBe(false);
    const stopped = await call(mcp, "stop", { id: launched.data.id });
    expect(stopped.isError).toBe(false);
    expect(stopped.data).toMatchObject({ status: "stopped" });
  });

  test("an internal tool error answers generically and logs its real cause, redacted", async () => {
    const lines: string[] = [];
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature-part";
    const { client, token, people } = await start({
      log: (line) => lines.push(line),
      sql: (db) => ({
        async query<T>(text: string, params?: unknown[]) {
          if (text.includes("from public.sandboxes")) {
            throw new Error(
              `connection to postgres://postgres:hunter2@db.example.com:5432/postgres failed for Bearer ${bearer}`,
            );
          }
          return (await db.query(text, params)) as unknown as { rows: T[] };
        },
      }),
    });
    const failed = await call(await client(await token(people.member)), "list");
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Armada could not complete the call.");
    expect(failed.text).toContain("error code: internal");
    expect(failed.text).not.toContain("hunter2");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tool list failed (internal): Error: connection to postgres://***@db.example.com");
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain(bearer);
  });
});

describe("tools", () => {
  test("the tools an orchestrator and the dashboard use are listed, with schemas", async () => {
    const { token, client, people } = await start();
    const mcp = await client(await token(people.member));
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["exec", "golden_list", "interrupt", "launch", "list", "logs", "send", "status", "steer", "stop", "wait"].sort(),
    );
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });

  test("golden_list shows org goldens and one's own private ones, never another's or another org's", async () => {
    const { token, client, people } = await start();
    const names = async (userId: string) =>
      ((await call(await client(await token(userId)), "golden_list")).data.goldens as { name: string }[]).map(
        (golden) => golden.name,
      );
    expect(await names(people.owner)).toEqual(["mine", "shared"]);
    expect(await names(people.member)).toEqual(["shared"]);
    expect(await names(people.admin)).toEqual(["shared"]);
  });

  test("launch forks with noEnv, the caller's Armada credential and the org boat key, and returns no secret", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "Fix the build" });
    expect(launched.isError).toBe(false);
    expect(launched.data).toMatchObject({
      golden: "shared",
      harness: "claude",
      status: "running",
      promptId: "prompt_1",
    });
    expect(boat.forks[0]).toMatchObject({ noEnv: true, env: { CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude } });
    expect(boat.keys.at(-1)).toBe(SECRETS.orgBoat);
    expect(boat.execs.map((exec) => exec.command).join("\n")).toContain("'pull' '--ff-only'");
    expectNoSecret(launched.text);
  });

  test("launch of a private golden uses its owner's own credential and personal boat key", async () => {
    const { token, client, people, boat } = await start();
    const launched = await call(await client(await token(people.owner)), "launch", {
      golden: "mine",
      harness: "claude",
    });
    expect(launched.data).toMatchObject({ status: "ready", conversationIds: [], promptId: null });
    expect(boat.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRETS.ownerClaude });
    expect(boat.keys).toEqual([SECRETS.personalBoat]);
  });

  test("launch of someone else's private golden is refused like a missing one, before any fork", async () => {
    const { token, client, people, boat } = await start();
    const refused = await call(await client(await token(people.admin)), "launch", {
      golden: "mine",
      harness: "claude",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("No golden named 'mine'");
    expect(boat.forks).toHaveLength(0);
  });

  test("launch refuses a harness Armada does not run", async () => {
    const { token, client, people } = await start();
    const refused = await call(await client(await token(people.member)), "launch", { golden: "shared", harness: "pi" });
    expect(refused.isError).toBe(true);
  });

  test("list and status hide another member's private sandbox", async () => {
    const { token, client, people } = await start();
    const owner = await client(await token(people.owner));
    const mine = await call(owner, "launch", { golden: "mine", harness: "claude" });
    const shared = await call(owner, "launch", { golden: "shared", harness: "codex" });
    const ids = async (userId: string) =>
      ((await call(await client(await token(userId)), "list")).data.sandboxes as { id: string }[]).map((row) => row.id);
    expect(await ids(people.owner)).toEqual([String(shared.data.id), String(mine.data.id)]);
    expect(await ids(people.admin)).toEqual([String(shared.data.id)]);
    const hidden = await call(await client(await token(people.admin)), "status", { id: mine.data.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain("No sandbox");
  });

  test("status reads getPrompt: a finished turn with a usage limit is failed, with its reason, and recorded", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    boat.sandbox("bx_1").events.push({
      id: "ev_limit",
      at: 5,
      kind: "other",
      type: "usage_limit",
      data: { message: "Claude usage limit reached" },
      promptId: "prompt_1",
    });
    boat.finish("bx_1", "prompt_1", "finished");
    const status = await call(mcp, "status", { id: launched.data.id });
    expect(status.data).toMatchObject({
      status: "failed",
      settled: true,
      prompt: { promptId: "prompt_1", state: "failed", reason: "Claude usage limit reached" },
    });
    expect(status.data.statusReason).toBe("Claude usage limit reached");
    const row = await db.query<{ status: string; status_reason: string | null }>(
      "select status::text as status, status_reason from sandboxes where id = $1",
      [launched.data.id],
    );
    expect(row.rows[0]).toEqual({ status: "failed", status_reason: "Claude usage limit reached" });
    const listed = await call(mcp, "list");
    expect(listed.data.sandboxes).toMatchObject([{ status: "failed", statusReason: "Claude usage limit reached" }]);

    await call(mcp, "send", { id: launched.data.id, prompt: "try again" });
    const cleared = await db.query<{ status_reason: string | null }>(
      "select status_reason from sandboxes where id = $1",
      [launched.data.id],
    );
    expect(cleared.rows[0]?.status_reason).toBeNull();
  });

  test("a session in several orgs sees each org's goldens, and launch takes the org that has the golden", async () => {
    const { session, client, people, boat, db } = await start();
    const mcp = await client(session(people.member, [people.org, people.otherOrg]));
    const goldens = await call(mcp, "golden_list");
    expect(goldens.data.goldens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "shared", orgId: people.org }),
        expect.objectContaining({ name: "elsewhere", orgId: people.otherOrg }),
      ]),
    );

    const elsewhere = await call(mcp, "launch", { golden: "elsewhere", harness: "claude" });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain("error code: missing_credential");
    expect(boat.forks).toHaveLength(0);

    const shared = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(shared.isError).toBe(false);
    expect(boat.keys.at(-1)).toBe(SECRETS.orgBoat);

    await db.query(
      `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
       select $1, 'shared', 'org', $2, $3, config from goldens where name = 'shared'`,
      [people.otherOrg, people.member, `a${"4".repeat(62)}`],
    );
    const ambiguous = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(ambiguous.text).toContain("several of your orgs");
    const chosen = await call(mcp, "launch", { golden: "shared", harness: "claude", org: people.org });
    expect(chosen.isError).toBe(false);
    const outsider = await call(mcp, "launch", { golden: "shared", harness: "claude", org: crypto.randomUUID() });
    expect(outsider.text).toContain("not a member");
  });

  test("wait returns once the turn ends, and timedOut when it does not", async () => {
    const { token, client, people, boat, clock } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    const before = clock.now.getTime();
    const waiting = await call(mcp, "wait", { id: launched.data.id, timeout_seconds: 3 });
    expect(waiting.data).toMatchObject({ timedOut: true, settled: false, status: "running" });
    expect(clock.now.getTime() - before).toBe(3000);

    boat.finish("bx_1", "prompt_1", "finished");
    const done = await call(mcp, "wait", { id: launched.data.id, timeout_seconds: 3 });
    expect(done.data).toMatchObject({ timedOut: false, settled: true, status: "ready", prompt: { state: "finished" } });
  });

  test("logs pass the cursor through and keep one body per event id, the newest", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    const events = boat.sandbox("bx_1").events;
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Wor", partial: true, tools: [] });
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Working", partial: false, tools: [] });
    const first = await call(mcp, "logs", { id: launched.data.id });
    expect((first.data.events as { id: string; text: string }[]).map((event) => [event.id, event.text])).toEqual([
      ["ev_prompt_1", "go"],
      ["ev_msg", "Working"],
    ]);
    expect(first.data).toMatchObject({ cursor: "3", hasMore: false });
    const next = await call(mcp, "logs", { id: launched.data.id, since_cursor: first.data.cursor });
    expect(next.data).toMatchObject({ events: [], cursor: "3" });
  });

  test("send continues the conversation and marks the sandbox running", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    boat.finish("bx_1", "prompt_1", "finished");
    await call(mcp, "status", { id: launched.data.id });
    const sent = await call(mcp, "send", { id: launched.data.id, prompt: "Now add tests" });
    expect(sent.data).toMatchObject({ promptId: "prompt_2", conversationId: "conv_1" });
    expect(boat.prompts[1]).toMatchObject({ conversationId: "conv_1", text: "Now add tests", harness: "claude" });
    const listed = await call(mcp, "list");
    expect(listed.data.sandboxes).toMatchObject([{ status: "running", conversationIds: ["conv_1"] }]);
  });

  test("steer reports restart for Codex and native for Claude, and asks for send when nothing runs", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const codex = await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "go" });
    expect((await call(mcp, "steer", { id: codex.data.id, text: "Use bun" })).data).toMatchObject({
      delivery: "restart",
    });
    const claude = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    const refused = await call(mcp, "steer", { id: claude.data.id, text: "Use bun" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Use send");
    await call(mcp, "send", { id: claude.data.id, prompt: "go" });
    expect((await call(mcp, "steer", { id: claude.data.id, text: "Use bun" })).data).toMatchObject({
      delivery: "native",
    });
    expect(boat.steers).toHaveLength(3);
  });

  test("exec redacts the agent's credentials from the output", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    boat.setExecOutput({ stdout: `CLAUDE_CODE_OAUTH_TOKEN=${SECRETS.orgClaude}\nok\n` });
    const ran = await call(mcp, "exec", { id: launched.data.id, command: "env" });
    expect(ran.data).toMatchObject({ exitCode: 0, stdout: "CLAUDE_CODE_OAUTH_TOKEN=***\nok\n" });
    expectNoSecret(ran.text);
  });

  test("stop removes the machine and records stopped", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect((await call(mcp, "stop", { id: launched.data.id })).data).toMatchObject({ status: "stopped" });
    expect(boat.stops).toEqual(["bx_1"]);
    const row = await db.query<{ status: string; stopped_at: Date | null }>(
      "select status::text as status, stopped_at from sandboxes where id = $1",
      [launched.data.id],
    );
    expect(row.rows[0]?.status).toBe("stopped");
    expect(row.rows[0]?.stopped_at).not.toBeNull();
  });

  test("a member of another org sees none of this org's goldens or sandboxes", async () => {
    const { token, client, people } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      golden: "shared",
      harness: "claude",
    });
    const other = await client(await token(people.member, people.otherOrg));
    expect((await call(other, "golden_list")).data.goldens).toMatchObject([{ name: "elsewhere" }]);
    expect((await call(other, "list")).data.sandboxes).toEqual([]);
    expect((await call(other, "stop", { id: launched.data.id })).isError).toBe(true);
  });
});
