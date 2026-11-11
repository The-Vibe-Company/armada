import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  CREDENTIAL_BUSY_MESSAGE,
  createSqlVaultStore,
  mutateCredentialAccount,
  ProviderError,
  VaultError,
} from "@armada/core/server";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import helperManifest from "../../core/helper/manifest.json";
import { createSqlData } from "../src/data.ts";
import { createHandler } from "../src/http.ts";
import { createProviderMetadata } from "../src/provider-metadata.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { readStatus } from "../src/turns.ts";
import { encryptedRecoveryExec } from "./fixtures/recovery-exec.ts";
import { bunLikeSql, call, ENCRYPTION_KEY, harness, PUBLIC_URL, SECRETS, type TestServer } from "./support.ts";

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

  test("CLI discovery on the MCP host answers without a token or private settings", async () => {
    const { handler } = await start();
    const response = await handler(new Request(`${PUBLIC_URL}/.well-known/armada.json`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      supabaseUrl: "https://project.supabase.co",
      anonKey: "anon",
      controlUrl: PUBLIC_URL,
      providers: [],
    });
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
  test("a SQL session membership failure is a 503 with a sanitized diagnostic", async () => {
    const lines: string[] = [];
    const credential = "postgres://armada:synthetic-password@database.test/armada";
    let jwt = "";
    const broken = createSqlAuthStore({
      query: async () => {
        throw new Error(`membership query failed: ${credential} Bearer ${jwt}`);
      },
    });
    const { handler, session, people } = await start({ authStore: () => broken, log: (line) => lines.push(line) });
    jwt = session(people.member);
    const response = await rpc(handler, jwt).tool("list", {});
    expect(response.status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("The membership store is unavailable.");
    expect(lines[0]).toContain("membership query failed");
    for (const text of [lines[0] ?? "", await response.text()]) {
      expect(text).not.toContain(jwt);
      expect(text).not.toContain(credential);
      expect(text).not.toContain("synthetic-password");
    }
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
      [
        "delete",
        "extend",
        "exec",
        "work_recovery",
        "github_refresh",
        "golden_build_status",
        "golden_capabilities",
        "golden_create",
        "golden_adopt",
        "golden_list",
        "golden_snapshot",
        "golden_size_policy",
        "golden_update",
        "interrupt",
        "launch",
        "launch_sized_v1",
        "list",
        "logs",
        "orchestrator_capabilities",
        "orchestrator_connections_list",
        "orchestrator_connections_add",
        "orchestrator_connections_remove",
        "orchestrator_create",
        "orchestrator_list",
        "orchestrator_detail",
        "orchestrator_events",
        "orchestrator_message",
        "orchestrator_steer",
        "orchestrator_stop",
        "orchestrator_resume",
        "orchestrator_recover",
        "orchestrator_reconcile",
        "skill_defaults_get",
        "skill_defaults_set",
        "template_create",
        "template_list",
        "template_get",
        "template_publish",
        "template_delete",
        "template_launch",
        "variable_list",
        "variable_read",
        "variable_set",
        "variable_update",
        "variable_delete",
        "secret_list",
        "secret_commit",
        "secret_revoke",
        "secret_delete",
        "report",
        "resource_advice",
        "send",
        "status",
        "steer",
        "stop",
        "wait",
      ].sort(),
    );
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
    const secretCommit = tools.find((tool) => tool.name === "secret_commit");
    expect(secretCommit?.inputSchema.required).toEqual(["org", "uploadReference"]);
    expect(secretCommit?.inputSchema.properties?.uploadReference).toMatchObject({ type: "string" });
    const variableSet = tools.find((tool) => tool.name === "variable_set");
    expect(variableSet?.inputSchema.required).toEqual(["org", "scope", "name", "value"]);
    expect(variableSet?.inputSchema.properties?.scope).toMatchObject({ enum: ["personal", "org"] });
    expect(variableSet?.inputSchema.properties?.value).toMatchObject({ type: "string" });
    for (const name of ["variable_update", "variable_delete", "secret_revoke", "secret_delete"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(schema?.required).toEqual(["org", "id", "expectedVersion"]);
      expect(schema?.properties?.expectedVersion).toMatchObject({ type: "integer", minimum: 1 });
    }
    for (const tool of tools.filter((tool) => /^(secret|variable)_/.test(tool.name))) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      if (tool.name.startsWith("secret_")) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("value");
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("value_enc");
      }
    }
    const launch = tools.find((tool) => tool.name === "launch");
    expect(launch?.inputSchema.properties?.repo).toMatchObject({ type: "string" });
    expect(launch?.inputSchema.required ?? []).not.toContain("repo");
    const goldenUpdate = tools.find((tool) => tool.name === "golden_update");
    const goldenSnapshot = tools.find((tool) => tool.name === "golden_snapshot");
    expect(goldenUpdate?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(goldenSnapshot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(goldenUpdate?.inputSchema).toBeDefined();
    expect(goldenUpdate?.outputSchema).toBeDefined();
    expect(goldenSnapshot?.inputSchema).toBeDefined();
    expect(goldenSnapshot?.outputSchema).toBeDefined();
  });

  test("golden_capabilities is read-only, scoped before resolution, and reports provider metadata only", async () => {
    const { token, client, people, boat, db, auth, clock } = await start();
    const bearer = await token(people.member);
    const vault = createSqlVaultStore(db);
    const supabase = { supabaseUrl: "https://unused.test", anonKey: "test" };
    let secretReads = 0;
    const metadata = createProviderMetadata({
      sql: db,
      vault: {
        credentials: async (...args) => {
          secretReads++;
          return vault.credentials(...args);
        },
        orgBoatKey: async (...args) => {
          secretReads++;
          return vault.orgBoatKey(...args);
        },
      },
      encryptionKey: ENCRYPTION_KEY,
      providerFor: boat.providerFor,
    });
    const handler = createHandler({
      publicUrl: PUBLIC_URL,
      authStore: auth,
      supabase,
      oauth: {
        ...supabase,
        publicUrl: PUBLIC_URL,
        store: auth,
        authSecret: "metadata-fixture-auth-secret",
        fetch: async () => {
          throw new Error("Capability reads must not invoke OAuth.");
        },
        now: () => clock.now,
      },
      data: createSqlData(db),
      vault,
      encryptionKey: ENCRYPTION_KEY,
      providerMetadata: metadata,
      providerFor: () => {
        throw new Error("Metadata must not resolve a resource provider.");
      },
      log: () => {},
    });
    const request = rpc(handler, bearer);
    // This user also belongs to otherOrg, but this token must never widen to it.
    const denied = await request.tool("golden_capabilities", { org: people.otherOrg, provider: "boat" });
    expect(denied.result?.isError).toBe(true);
    expect(secretReads).toBe(0);
    expect(boat.keys).toEqual([]);
    Object.assign(boat.provider, { maxGoldens: 7 });
    const result = await request.tool("golden_capabilities", { org: people.org, provider: "boat" });
    expect(result.result?.isError).not.toBe(true);
    expect(result.result?.structuredContent).toEqual({
      provider: "boat",
      maxGoldens: 7,
      bindings: [{ goldenId: expect.any(String), relation: "unbound" }],
    });
    Object.assign(boat.provider, { maxGoldens: undefined });
    expect((await request.tool("golden_capabilities", {})).result?.structuredContent).toEqual({
      provider: "boat",
      maxGoldens: null,
    });
    expect(secretReads).toBeGreaterThan(0);
    expect(boat.keys).toHaveLength(2);
    expect(boat.forks).toEqual([]);
    expect(boat.execs).toEqual([]);
    expect(boat.stops).toEqual([]);
    const listed = await (await client(bearer)).listTools();
    expect(listed.tools.find((tool) => tool.name === "golden_capabilities")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
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
    const { token, client, people, boat, db } = await start();
    const helperClient = await client(await token(people.member));
    for (const reason of ["helper_missing", "helper_receipt_invalid"]) {
      if (reason === "helper_receipt_invalid")
        await db.query(
          `update goldens set helper_receipt='{"version":"old","digest":"old","protocol":0,"platform":"x86_64","capabilities":[],"snapshotId":"old"}' where name='shared'`,
        );
      const refused = await call(helperClient, "launch", {
        golden: "shared",
        harness: "claude",
        helperCapabilities: ["diagnose"],
      });
      expect(refused.isError).toBe(true);
      expect(refused.data).toEqual({
        error: { code: "unsupported", message: expect.any(String), details: { reason, action: "rebuild_golden" } },
      });
      expect(boat.forks).toHaveLength(0);
    }
    await db.query(
      `update goldens set helper_receipt = jsonb_build_object(
      'version','0.1.0','protocol',1,'platform','x86_64','digest',$1::text,
      'capabilities',jsonb_build_array('diagnose'),'snapshotId',provider_snapshot_id) where name='shared'`,
      [helperManifest.x86_64.digest],
    );
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      golden: "shared",
      harness: "claude",
      prompt: "Fix the build",
      helperCapabilities: ["diagnose"],
    });
    expect(launched.isError).toBe(false);
    expect(launched.data).toMatchObject({
      golden: "shared",
      harness: "claude",
      status: "running",
      promptId: "prompt_1",
      helper: { status: "supported", protocol: 1, capabilities: ["diagnose"] },
    });
    expect(boat.forks[0]).toMatchObject({ noEnv: true, env: { CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude } });
    expect(boat.keys.at(-1)).toBe(SECRETS.orgBoat);
    expect(boat.execs.map((exec) => exec.command).join("\n")).toContain("'pull' '--ff-only'");
    expectNoSecret(launched.text);
  });

  test("launch reports GitHub as not connected, without failing, when the caller never connected it", async () => {
    const { token, client, people, boat } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      golden: "shared",
      harness: "claude",
    });
    expect(launched.isError).toBe(false);
    expect(launched.data.github).toMatchObject({ status: "not_connected", login: null });
    expect(boat.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude });
  });

  test("launch with a connected GitHub acts as the caller: fresh token in the env, git set up, refresh token rotated", async () => {
    const { token, client, people, boat, github, db } = await start();
    await github.connect(people.member, "octocat", 583231);
    const mcp = await client(await token(people.member));

    const first = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(first.data.github).toEqual({
      status: "connected",
      login: "octocat",
      tokenExpiresAt: expect.any(String),
      message: expect.stringContaining("gh"),
    });
    expect(boat.forks[0]?.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude,
      GH_TOKEN: "ghu_access_octocat",
      GITHUB_TOKEN: "ghu_access_octocat",
    });
    expect(boat.execs[0]?.command).toContain("user.email '583231+octocat@users.noreply.github.com'");
    expect(first.text).not.toContain("ghu_access_octocat");

    const second = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(second.data.github).toMatchObject({ status: "connected" });
    expect(github.refreshed).toEqual(["ghr_refresh_octocat_0"]);
    const stored = await db.query<{ refresh_token_enc: Uint8Array }>(
      "select refresh_token_enc from github_connections",
    );
    expect(stored.rows).toHaveLength(1);
  });

  test("a revoked GitHub grant is reported once as revoked, then skipped, and the launch still succeeds", async () => {
    const { token, client, people, boat, github } = await start();
    await github.connect(people.member, "octocat", 583231);
    github.revokeEverything();
    const mcp = await client(await token(people.member));

    const first = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(first.isError).toBe(false);
    expect(first.data.github).toMatchObject({ status: "revoked", login: null });
    expect((first.data.github as { message: string }).message).toContain("Reconnect GitHub");
    expect(boat.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude });

    await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(github.refreshed).toHaveLength(1);
  });

  test("exec output masks GitHub and narrow MCP gateway credentials", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    const narrow = `armada_gw_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    boat.setExecOutput({ stdout: `GH_TOKEN=ghu_0123456789abcdefghijABCDEFGHIJ0123 MCP=${narrow}` });
    const ran = await call(mcp, "exec", { id: launched.data.id, command: "env" });
    expect(String(ran.data.stdout).includes(narrow)).toBe(false);
    expect(ran.data.stdout).toBe("GH_TOKEN=*** MCP=***");
  });

  test("launch accepts deprecated visibility without changing sandbox access", async () => {
    const { token, client, people, db } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      golden: "shared",
      harness: "codex",
      visibility: "private",
    });
    expect(launched.isError).toBe(false);
    expect(launched.data.visibility).toBe("org");
    expect(
      (
        await db.query<{ visibility: string }>("select visibility from public.sandboxes where id=$1", [
          launched.data.id,
        ])
      ).rows[0]?.visibility,
    ).toBe("org");
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

  test("list exposes safe org metadata while member interior operations make no provider calls", async () => {
    const { token, client, people, boat } = await start();
    const owner = await client(await token(people.owner));
    const mine = await call(owner, "launch", { golden: "mine", harness: "claude" });
    const member = await client(await token(people.member));
    const listed = await call(member, "list");
    expect(listed.data.sandboxes).toMatchObject([{ id: mine.data.id, canOpen: false, canManage: false }]);
    const before = { keys: boat.keys.length, execs: boat.execs.length, stops: boat.stops.length };
    for (const [name, args] of Object.entries({
      status: {},
      logs: {},
      wait: { timeout_seconds: 0 },
      exec: { command: "pwd" },
      send: { prompt: "hello" },
      steer: { text: "hello" },
      interrupt: {},
      stop: {},
    })) {
      const denied = await call(member, name, { id: mine.data.id, ...args });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("No sandbox");
    }
    expect({ keys: boat.keys.length, execs: boat.execs.length, stops: boat.stops.length }).toEqual(before);
    const admin = await client(await token(people.admin));
    expect((await call(admin, "list")).data.sandboxes).toMatchObject([{ canOpen: true, canManage: true }]);
  });

  for (const [message, state, reason] of [
    [
      "The box moved to a new machine while this prompt was running. Send it again.",
      "interrupted",
      "interrupted_by_provider_move",
    ],
    [
      "Codex app-server exited with signal SIGKILL; the next prompt starts a fresh process",
      "interrupted",
      "interrupted_by_harness_exit",
    ],
    ["Agent request failed", "failed", "Agent request failed"],
  ] as const) {
    test(`turn error does not fail the machine: ${reason}`, async () => {
      const { token, client, people, boat, db } = await start();
      const mcp = await client(await token(people.member));
      const launched = await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "go" });
      boat.finish("bx_1", "prompt_1", "failed");
      const event = boat.sandbox("bx_1").events.find((event) => event.kind === "prompt");
      if (event?.kind !== "prompt") throw Error("Missing prompt fixture");
      event.reason = message;
      // Also repair historical misclassification when provider health can be checked.
      await db.query("update sandboxes set status='failed',status_reason=$2 where id=$1", [launched.data.id, message]);
      const status = await call(mcp, "status", { id: launched.data.id });
      expect(status.data).toMatchObject({
        status: "ready",
        statusReason: null,
        settled: true,
        prompt: { state, reason },
      });
      const row = await db.query("select status::text,status_reason from sandboxes where id=$1", [launched.data.id]);
      expect(row.rows[0]).toEqual({ status: "ready", status_reason: null });
      const resent = await call(mcp, "send", { id: launched.data.id, prompt: "try again" });
      expect(resent.isError).not.toBe(true);
      boat.finish("bx_1", "prompt_2", "failed");
      await db.query("update sandboxes set status='failed',status_reason=$2 where id=$1", [launched.data.id, message]);
      boat.sandbox("bx_1").info.state = "stopped";
      const stopped = await call(mcp, "status", { id: launched.data.id });
      expect(stopped.data.status).toBe("stopped");
      boat.sandbox("bx_1").info.state = "failed";
      boat.sandbox("bx_1").info.error = "Machine irrecoverable";
      const failed = await call(mcp, "status", { id: launched.data.id });
      expect(failed.data).toMatchObject({ status: "failed", statusReason: "Machine irrecoverable" });
    });
  }

  test("status reads getPrompt: a usage limit fails the turn, not the machine", async () => {
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
    boat.sandbox("bx_1").events.push({
      id: "matched-response",
      at: 4,
      kind: "message",
      promptId: "prompt_1",
      model: boat.prompts[0]!.model!,
      text: "response",
      partial: false,
      tools: [],
    });
    boat.finish("bx_1", "prompt_1", "finished");
    const originalEvents = boat.provider.events;
    let unavailable = true;
    boat.provider.events = async (request) => {
      if (unavailable) {
        unavailable = false;
        throw new Error("temporary evidence failure");
      }
      return originalEvents(request);
    };
    expect((await call(mcp, "status", { id: launched.data.id })).data.prompt).toMatchObject({
      state: "finished",
      modelSelectionReason: "model_selection_unverified",
    });
    const status = await call(mcp, "status", { id: launched.data.id });
    expect(status.data).toMatchObject({
      status: "ready",
      settled: true,
      prompt: { promptId: "prompt_1", state: "failed", reason: "Claude usage limit reached" },
    });
    expect(status.data.statusReason).toBeNull();
    const row = await db.query<{ status: string; status_reason: string | null }>(
      "select status::text as status, status_reason from sandboxes where id = $1",
      [launched.data.id],
    );
    expect(row.rows[0]).toEqual({ status: "ready", status_reason: null });
    const listed = await call(mcp, "list");
    expect(listed.data.sandboxes).toMatchObject([{ status: "ready" }]);

    // A lifecycle owner may win after the provider observation. Reads return
    // its persisted state instead of publishing stale readiness or returning409.
    await db.query(
      "update sandboxes set status='running',reconcile_lease_until=now()+interval '2 minutes' where id=$1",
      [launched.data.id],
    );
    expect((await call(mcp, "status", { id: launched.data.id })).data).toMatchObject({
      status: "running",
      settled: false,
    });
    await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [launched.data.id]);
    expect((await call(mcp, "status", { id: launched.data.id })).data.status).toBe("ready");

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

  test("Codex without response models and legacy turns stay finished with neutral evidence", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "codex", prompt: "work" });
    boat.finish("bx_1", "prompt_1", "finished");
    const store = createSqlData(db)({
      userId: people.member,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    }).sandboxes;
    const saved = await store.get(String(launched.data.id));
    if (!saved) throw new Error("Missing launched sandbox");
    for (const provider of ["boat", "modal"] as const) {
      const read = await readStatus(
        { ...boat.provider, id: provider },
        store,
        { ...saved, provider },
        { now: new Date() },
      );
      expect(read.prompt).toMatchObject({
        state: "finished",
        reason: null,
        observedModel: null,
        modelSelectionReason: "model_selection_unverified",
      });
    }
    // Stored status must not collect native usage or publish a stale lifecycle observation.
    const writes: string[] = [];
    const observedStore = {
      ...store,
      update: async () => {
        writes.push("lifecycle");
        throw new Error("Stored reads must not publish lifecycle state");
      },
      recordUsage: async () => {
        writes.push("usage");
        throw new Error("Stored reads must not collect usage");
      },
      recordTurnModelEvidence: async () => {
        writes.push("telemetry");
        throw new Error("Stored reads must not publish telemetry");
      },
    };
    const stored = await readStatus(
      {
        ...boat.provider,
        collectTurnUsage: async () => {
          throw new Error("No live native usage");
        },
      },
      observedStore,
      { ...saved, status: "running" },
      { now: new Date(), stored: true },
    );
    expect(stored.status).toBe("ready");
    expect(stored.prompt?.state).toBe("finished");
    expect(writes).toEqual([]);
    // Modal appends terminal prompt transitions; they are not the start of a turn.
    const modalEvents = boat.sandbox("bx_1").events;
    modalEvents.push({
      id: "early-root",
      at: 2,
      kind: "message",
      promptId: "prompt_1",
      model: saved.model!,
      text: "root",
      partial: false,
      tools: [],
    });
    for (let i = 0; i < 201; i++)
      modalEvents.push({
        id: `tool_${i}`,
        at: 3 + i,
        kind: "message",
        promptId: "prompt_1",
        responseKind: "tool_result",
        text: "",
        partial: false,
        tools: [],
      });
    modalEvents.push(
      {
        id: "late-root",
        at: 205,
        kind: "message",
        promptId: "prompt_1",
        model: "different-model",
        text: "root",
        partial: false,
        tools: [],
      },
      { id: "terminal", at: 206, kind: "prompt", promptId: "prompt_1", status: "finished", text: "work" },
    );
    const mixed = await readStatus(
      { ...boat.provider, id: "modal" },
      store,
      { ...saved, provider: "modal" },
      { now: new Date() },
    );
    expect(mixed.prompt).toMatchObject({
      state: "finished",
      reason: null,
      observedModel: null,
      modelSelectionReason: "model_selection_unverified",
    });
    modalEvents.splice(1);
    await db.query("delete from sandbox_turn_models where sandbox_id=$1", [launched.data.id]);
    boat.sandbox("bx_1").events.push({
      id: "legacy-response",
      at: 2,
      kind: "message",
      promptId: "prompt_1",
      model: "other-model",
      text: "done",
      partial: false,
      tools: [],
    });
    const legacy = await call(mcp, "status", { id: launched.data.id });
    expect(legacy.data.prompt).toMatchObject({
      state: "finished",
      reason: null,
      requestedModel: null,
      observedModel: "other-model",
      modelSelectionReason: "model_selection_unverified",
    });
  });

  test("running status reads no history; transient terminal gaps retry and long history does not hide the turn", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      golden: "shared",
      harness: "claude",
      model: "chosen",
      prompt: "work",
    });
    const original = boat.provider.events;
    let reads = 0;
    boat.provider.events = async (request) => {
      reads++;
      return original(request);
    };
    await call(mcp, "status", { id: launched.data.id });
    await call(mcp, "status", { id: launched.data.id });
    expect(reads).toBe(0);
    const state = boat.sandbox("bx_1");
    state.events.unshift(
      ...Array.from({ length: 10200 }, (_, i) => ({
        id: `old_${i}`,
        at: 0,
        kind: "other" as const,
        type: "old",
        data: {},
        promptId: "old",
      })),
    );
    state.events.push({
      id: "response",
      at: 2,
      kind: "message",
      promptId: "prompt_1",
      model: "chosen",
      text: "done",
      partial: false,
      tools: [],
    });
    boat.finish("bx_1", "prompt_1", "finished");
    let failures = 2;
    boat.provider.events = async (request) => {
      if (failures-- > 0) throw new Error("temporary");
      return original(request);
    };
    const missing = await call(mcp, "status", { id: launched.data.id });
    expect(missing.data.prompt).toMatchObject({
      state: "finished",
      reason: null,
      modelSelectionReason: "model_selection_unverified",
    });
    const recovered = await call(mcp, "status", { id: launched.data.id });
    expect(recovered.data.prompt).toMatchObject({
      state: "finished",
      observedModel: "chosen",
      modelSelectionReason: null,
    });
  });

  test("failed model record inserts do not fail an accepted launch or send", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    await db.exec(
      `create function reject_model_record() returns trigger language plpgsql as $$ begin raise exception 'record unavailable'; end $$; create trigger reject_model_record before insert on sandbox_turn_models for each row execute function reject_model_record();`,
    );
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "work" });
    expect(launched.isError).toBe(false);
    expect(boat.stops).toHaveLength(0);
    const sent = await call(mcp, "send", { id: launched.data.id, prompt: "next" });
    expect(sent.isError).toBe(false);
    expect(boat.prompts).toHaveLength(2);
    const status = await call(mcp, "status", { id: launched.data.id });
    expect(status.data).toMatchObject({ status: "running", prompt: { state: "running" } });
  });

  test("turn model provenance survives send overrides and provider history retention", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      golden: "shared",
      harness: "claude",
      model: "claude-fable-5-2",
      prompt: "probe",
    });
    expect(launched.isError).toBe(false);
    const id = launched.data.id;
    // Coordinator's 12:35Z capture: first main response was Sonnet, no fallback notice.
    boat.sandbox("bx_1").events.push({
      id: "observed",
      at: 2,
      kind: "message",
      promptId: "prompt_1",
      model: "claude-sonnet-5",
      text: "claude-sonnet-5",
      partial: false,
      tools: [],
    });
    boat.finish("bx_1", "prompt_1", "finished");
    const status = await call(mcp, "status", { id });
    expect(status.data.prompt).toMatchObject({
      state: "failed",
      requestedModel: "claude-fable-5-2",
      observedModel: "claude-sonnet-5",
      reason: "model_selection_mismatch",
    });
    expect(status.data.prompt).toMatchObject({
      modelSelectionMessage: expect.stringContaining("Do not retry automatically"),
    });
    const sent = await call(mcp, "send", { id, prompt: "override", model: "claude-sonnet-5" });
    expect(sent.isError).toBe(false);
    boat.sandbox("bx_1").events.push({
      id: "override",
      at: 4,
      kind: "message",
      promptId: "prompt_2",
      model: "claude-sonnet-5",
      text: "ok",
      partial: false,
      tools: [],
    });
    boat.finish("bx_1", "prompt_2", "finished");
    const waited = await call(mcp, "wait", { id, timeout_seconds: 1 });
    expect(waited.data).toMatchObject({
      model: "claude-fable-5-2",
      prompt: {
        state: "finished",
        requestedModel: "claude-sonnet-5",
        observedModel: "claude-sonnet-5",
        modelSelectionReason: null,
      },
    });
    boat.sandbox("bx_1").events.length = 0;
    boat.sandbox("bx_1").prompts.delete("prompt_1");
    const historical = await call(mcp, "status", { id, prompt_id: "prompt_1" });
    expect(historical.data.prompt).toMatchObject({
      state: "failed",
      requestedModel: "claude-fable-5-2",
      observedModel: "claude-sonnet-5",
    });
    const persisted = await db.query(
      "select requested_model, evidence from sandbox_turn_models where sandbox_id=$1 order by prompt_id",
      [id],
    );
    expect(persisted.rows).toHaveLength(2);
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
    expect(done.data).toMatchObject({
      timedOut: false,
      settled: true,
      status: "ready",
      prompt: { state: "finished", reason: null, modelSelectionReason: "model_selection_unverified" },
    });
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

  test("logs reads every page only when all is requested and advances the cursor", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "go" });
    const events = boat.sandbox("bx_1").events;
    for (let index = 0; index < 205; index += 1) {
      events.push({
        id: `ev_${index}`,
        at: index + 2,
        kind: "message",
        text: String(index),
        partial: false,
        tools: [],
      });
    }
    const first = await call(mcp, "logs", { id: launched.data.id });
    expect(first.data.events).toHaveLength(100);
    expect(first.data).toMatchObject({ cursor: "100", hasMore: true });
    const all = await call(mcp, "logs", { id: launched.data.id, all: true });
    expect(all.data.events).toHaveLength(206);
    expect(all.data).toMatchObject({ cursor: "206", hasMore: false });
  });

  test("real launch persists account binding and send/restart steer refuse a removed source without using a new default", async () => {
    const { token, client, people, db, boat } = await start();
    const store = createSqlVaultStore(db);
    const first = await mutateCredentialAccount(store, ENCRYPTION_KEY, people.member, {
      action: "set",
      scope: "user",
      kind: "openai",
      name: "Work",
      value: "work-subscription",
    });
    const second = await mutateCredentialAccount(store, ENCRYPTION_KEY, people.member, {
      action: "set",
      scope: "user",
      kind: "openai",
      name: "Other",
      value: "other-subscription",
    });
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "codex", credentialId: first.id });
    expect(launched.isError).not.toBe(true);
    expect(
      (await db.query("select credential_id,credential_version from sandboxes where id=$1", [launched.data.id]))
        .rows[0],
    ).toEqual({ credential_id: first.id, credential_version: 1 });
    const admin = await client(await token(people.admin));
    const beforeAdmin = { prompts: boat.prompts.length, steers: boat.steers.length };
    expect(
      (await call(admin, "send", { id: launched.data.id, prompt: "Cannot use owner's personal account" })).isError,
    ).toBe(true);
    expect(
      (await call(admin, "steer", { id: launched.data.id, text: "Cannot restart with owner's account" })).isError,
    ).toBe(true);
    expect({ prompts: boat.prompts.length, steers: boat.steers.length }).toEqual(beforeAdmin);
    const listed = await call(admin, "list");
    expect(
      (listed.data.sandboxes as Record<string, unknown>[]).every(
        (row) => !("credentialId" in row) && !("credentialVersion" in row),
      ),
    ).toBe(true);
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.member, {
      action: "default",
      scope: "user",
      id: second.id!,
    });
    const sent = await call(mcp, "send", { id: launched.data.id, prompt: "Continue" });
    expect(sent.isError).not.toBe(true);
    const count = boat.prompts.length;
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.member, {
      action: "remove",
      scope: "user",
      id: first.id!,
    });
    const refused = await call(mcp, "send", { id: launched.data.id, prompt: "Must not use another account" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("No fallback was used");
    expect(boat.prompts).toHaveLength(count);
    const steerCount = boat.steers.length;
    const steerRefused = await call(mcp, "steer", { id: launched.data.id, text: "Must not restart" });
    expect(steerRefused.isError).toBe(true);
    expect(steerRefused.text).toContain("No fallback was used");
    expect(boat.steers).toHaveLength(steerCount);
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
    expect(listed.data.sandboxes).toMatchObject([{ status: "running" }]);
  });

  test("launch validates repo selectors before fork and forwards a recorded repo to native preparation", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    for (const repo of ["bad", "https://github.com/example/web", "", 42, null, ["example/web"]]) {
      const refused = await call(mcp, "launch", { golden: "shared", harness: "codex", repo });
      expect(refused.isError).toBe(true);
      expect(boat.forks).toHaveLength(0);
    }
    const missing = await call(mcp, "launch", { golden: "shared", harness: "codex", repo: "example/missing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no repository");
    expect(boat.forks).toHaveLength(0);
    expect(boat.preparations).toEqual([]);
    const launched = await call(mcp, "launch", {
      golden: "shared",
      harness: "codex",
      repo: "EXAMPLE/web",
      model: "gpt-6.1-terra",
      reasoning_effort: "high",
    });
    expect(launched.isError).not.toBe(true);
    expect(launched.data).toMatchObject({ status: "ready", model: "gpt-6.1-terra", reasoningEffort: "high" });
    expect(boat.preparations).toEqual([{ sandboxId: "bx_1", harness: "codex", cwd: "/home/user/web" }]);
    expect(boat.prompts).toHaveLength(0);
    await call(mcp, "send", { id: launched.data.id, prompt: "Later" });
    expect(boat.prompts[0]).toMatchObject({ harness: "codex", model: "gpt-6.1-terra", reasoningEffort: "high" });
  });

  test("an idle launch keeps its model and effort for every send, across stop, and an override lasts one turn", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const refused = await call(mcp, "launch", { golden: "shared", harness: "codex", reasoning_effort: "extreme" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Use one of: low, medium, high, xhigh, max, ultra");
    expect(boat.forks).toHaveLength(0);

    const launched = await call(mcp, "launch", {
      golden: "shared",
      harness: "codex",
      model: "gpt-6.1-terra",
      reasoning_effort: "high",
    });
    expect(launched.data).toMatchObject({ model: "gpt-6.1-terra", reasoningEffort: "high", status: "ready" });
    expect(boat.prompts).toHaveLength(0);

    await call(mcp, "send", { id: launched.data.id, prompt: "first" });
    await call(mcp, "stop", { id: launched.data.id });
    await call(mcp, "send", { id: launched.data.id, prompt: "after stop" });
    await call(mcp, "send", { id: launched.data.id, prompt: "once", model: "gpt-6-luna", reasoning_effort: "low" });
    await call(mcp, "send", { id: launched.data.id, prompt: "back" });
    expect(boat.prompts.map(({ text, model, reasoningEffort }) => ({ text, model, reasoningEffort }))).toEqual([
      { text: "first", model: "gpt-6.1-terra", reasoningEffort: "high" },
      { text: "after stop", model: "gpt-6.1-terra", reasoningEffort: "high" },
      { text: "once", model: "gpt-6-luna", reasoningEffort: "low" },
      { text: "back", model: "gpt-6.1-terra", reasoningEffort: "high" },
    ]);
    const status = await call(mcp, "status", { id: launched.data.id });
    expect(status.data).toMatchObject({ model: "gpt-6.1-terra", reasoningEffort: "high" });

    // A sandbox recorded before the choice existed keeps the provider's default.
    await db.query("update sandboxes set model = null, reasoning_effort = null where id = $1", [launched.data.id]);
    await call(mcp, "send", { id: launched.data.id, prompt: "legacy" });
    expect(boat.prompts.at(-1)).not.toHaveProperty("model");
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

  test.each(["running", "failed"])(
    "a mid-turn stop queues until interruption settles and retains %s state",
    async (state) => {
      const { token, client, people, boat, db } = await start();
      const mcp = await client(await token(people.member));
      const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "work" });
      if (state === "failed")
        await db.query("update sandboxes set status='failed', status_reason='original failure' where id=$1", [
          launched.data.id,
        ]);
      let pending = true;
      boat.provider.quiesce = async () => {
        if (pending)
          throw new ProviderError({
            provider: "boat",
            code: "sandbox_not_ready",
            retryable: true,
            message: "Interruption pending",
          });
      };
      boat.setExecOutput({ stdout: '{"status":"clean"}' });
      const commands = boat.execs.length;
      const stop = await call(mcp, "stop", { id: launched.data.id });
      expect(stop.isError).not.toBe(true);
      expect(stop.data.status).toBe(state === "failed" ? "failed" : "stopping");
      expect(boat.stops).toHaveLength(0);
      expect(boat.execs).toHaveLength(commands);
      // A stale receipt must never let a repeated user stop bypass settlement.
      await db.query(
        "update sandboxes set preservation_note='unpushed work could not be preserved (timeout)' where id=$1",
        [launched.data.id],
      );
      expect((await call(mcp, "stop", { id: launched.data.id })).data.status).toBe(
        state === "failed" ? "failed" : "stopping",
      );
      expect(boat.stops).toHaveLength(0);
      expect(boat.execs).toHaveLength(commands);
      await db.query("update sandboxes set reconcile_lease_until=now()+interval '2 minutes' where id=$1", [
        launched.data.id,
      ]);
      expect((await call(mcp, "status", { id: launched.data.id })).data).toMatchObject({
        status: state === "failed" ? "failed" : "stopping",
        settled: false,
      });
      expect((await call(mcp, "stop", { id: launched.data.id })).isError).not.toBe(true);
      await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [launched.data.id]);
      pending = false;
      await db.query("update sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [launched.data.id]);
      const lifecycle = createSandboxLifecycle(bunLikeSql(db), async () => boat.provider);
      expect(await lifecycle.reconcileOne()).toBe(true);
      expect(boat.stops).toEqual(["bx_1"]);
      expect(boat.execs.length).toBeGreaterThan(commands);
      const row = (
        await db.query<{ status: string; preservation_note: string | null; stop_requested_at: Date | null }>(
          "select status::text, preservation_note, stop_requested_at from sandboxes where id=$1",
          [launched.data.id],
        )
      ).rows[0];
      expect(row).toMatchObject({
        status: state === "failed" ? "failed" : "stopped",
        preservation_note: null,
        stop_requested_at: null,
      });
    },
  );

  test("ordinary exec commands stay concurrent without changing lifecycle generation", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    const id = launched.data.id;
    const before = (
      await db.query<{ lifecycle_generation: string | number | bigint }>(
        "select lifecycle_generation from sandboxes where id=$1",
        [id],
      )
    ).rows[0]?.lifecycle_generation;
    const execute = boat.provider.exec;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    boat.provider.exec = async (request) => {
      if (request.command === "held command") {
        await new Promise<void>((resolve) => {
          release = resolve;
          entered?.();
        });
      }
      return execute(request);
    };
    const first = call(mcp, "exec", { id, command: "held command" });
    await running;
    let second: Awaited<ReturnType<typeof call>>;
    try {
      second = await call(mcp, "exec", { id, command: "parallel command" });
    } finally {
      release?.();
    }
    const completed = await first;
    expect(second.isError).not.toBe(true);
    expect(second.data.exitCode).toBe(0);
    expect(completed.isError).not.toBe(true);
    const after = (
      await db.query<{ lifecycle_generation: string | number | bigint; activity_lease_id: string | null }>(
        "select lifecycle_generation,activity_lease_id from sandboxes where id=$1",
        [id],
      )
    ).rows[0];
    expect(after?.lifecycle_generation).toEqual(before);
    expect(after?.activity_lease_id).toBeNull();
  });

  test.each(["exec", "steer"])("pending successful stop blocks %s workspace mutation", async (tool) => {
    let preparations = 0;
    const { token, client, people, boat, db } = await start({
      connections: {
        validate: async () => {},
        bind: async () => {},
        prepare: async () => {
          preparations++;
        },
      },
    });
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude", prompt: "work" });
    const id = launched.data.id;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    boat.provider.stop = async () => {
      throw new ProviderError({
        provider: "boat",
        code: "unavailable",
        retryable: true,
        message: "Stop did not dispatch",
      });
    };
    expect((await call(mcp, "stop", { id })).isError).toBe(true);
    // Expire the retained unknown-outcome lease without a wall-clock wait.
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [id]);
    const prepared = preparations;
    const commands = boat.execs.length,
      steers = boat.steers.length;
    expect(
      (
        await call(
          mcp,
          tool,
          tool === "exec" ? { id, command: "touch after-capture" } : { id, text: "change after capture" },
        )
      ).isError,
    ).toBe(true);
    expect(boat.execs).toHaveLength(commands);
    expect(boat.steers).toHaveLength(steers);
    expect(preparations).toBe(prepared);
  });

  test("explicit new work cancels a pending stop receipt before the next stop", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    const id = launched.data.id;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    const stop = boat.provider.stop;
    boat.provider.stop = async () => {
      throw new ProviderError({
        provider: "boat",
        code: "unavailable",
        retryable: true,
        message: "Stop did not dispatch",
      });
    };
    expect((await call(mcp, "stop", { id })).isError).toBe(true);
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [id]);
    const sent = await call(mcp, "send", { id, prompt: "new work" });
    expect(sent.isError).not.toBe(true);
    const promptId = sent.data.promptId;
    if (typeof promptId !== "string") throw new Error("Missing accepted prompt id");
    boat.finish("bx_1", promptId, "finished");
    boat.provider.stop = stop;
    const count = boat.execs.filter((r) => r.preservationStage === "collect_exec").length;
    expect((await call(mcp, "stop", { id })).isError).not.toBe(true);
    expect(boat.execs.filter((r) => r.preservationStage === "collect_exec")).toHaveLength(count + 1);
  });

  test.each(["preserved", "clean"] as const)("user stop then lifecycle stop reuses its %s capture", async (result) => {
    const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
    process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
      const { token, client, people, boat, db } = await start();
      const mcp = await client(await token(people.member));
      const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
      const id = launched.data.id;
      const archive = Buffer.from("private local-only commit recovery fixture").toString("base64");
      boat.setExecOutput({ stdout: JSON.stringify({ status: result }) });
      const capture = encryptedRecoveryExec(() => archive, boat.provider.exec);
      let captures = 0;
      boat.provider.exec = async (request) => {
        if (request.preservationStage === "collect_exec") captures++;
        if (boat.sandbox("bx_1").info.state !== "ready")
          throw new ProviderError({
            provider: "boat",
            code: "sandbox_not_ready",
            retryable: false,
            message: "Archiving",
          });
        return capture(request);
      };
      const stop = boat.provider.stop;
      boat.provider.stop = async (request) => {
        await stop(request);
        if (boat.stops.length === 1)
          boat.sandbox(request.sandboxId).info = {
            ...boat.sandbox(request.sandboxId).info,
            state: "stopping",
            providerState: "archiving",
          };
      };
      expect((await call(mcp, "stop", { id })).data.status).toBe("stopping");
      const before = (
        await db.query<{
          preservation_note: string | null;
        }>("select preservation_note from sandboxes where id=$1", [id])
      ).rows[0];
      expect(captures).toBe(1);
      // Stop admission/reconciliation owns the machine; reads and retries must
      // remain available without replaying capture or stop on archiving compute.
      await db.query("update sandboxes set reconcile_lease_until=now()+interval '2 minutes' where id=$1", [id]);
      expect((await call(mcp, "status", { id })).data).toMatchObject({ status: "stopping", settled: false });
      expect((await call(mcp, "wait", { id, timeout_seconds: 0 })).data.timedOut).toBe(true);
      expect((await call(mcp, "stop", { id })).data.status).toBe("stopping");
      await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [id]);
      const lifecycle = createSandboxLifecycle(bunLikeSql(db), async () => boat.provider);
      expect(await lifecycle.reconcileOne()).toBe(true);
      expect(boat.stops).toHaveLength(1);
      boat.sandbox("bx_1").info = { ...boat.sandbox("bx_1").info, state: "stopped", providerState: "archived" };
      await db.query("update sandboxes set reconcile_after=now() where id=$1", [id]);
      expect(await lifecycle.reconcileOne()).toBe(true);
      expect((await call(mcp, "stop", { id })).data.status).toBe("stopped");
      const after = (
        await db.query<{ status: string; preservation_note: string | null }>(
          "select status::text,preservation_note from sandboxes where id=$1",
          [id],
        )
      ).rows[0];
      expect(after?.status).toBe("stopped");
      expect(after?.preservation_note).toBe(before?.preservation_note);
      expect(captures).toBe(1);
      expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(
        result === "preserved" ? 1 : 0,
      );
      expect((await call(mcp, "work_recovery", { id })).data.archive).toBe(result === "preserved" ? archive : null);
    } finally {
      if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
      else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
    }
  });

  test("a clean fully-pushed stop leaves no preservation note", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    expect((await call(mcp, "stop", { id: launched.data.id })).data.status).toBe("stopped");
    const row = (
      await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [
        launched.data.id,
      ])
    ).rows[0];
    expect(row?.preservation_note).toBeNull();
  });

  test("user-stop trace places capture before physical dispatch", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      await call(mcp, "stop", { id: launched.data.id });
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.filter((e) => e.event === "work_preservation_stage").map((e) => e.phase)).toEqual([
        "observed",
        "quiesce_started",
        "quiesce_finished",
        "capture_started",
        "capture_clean",
        "capture_committed",
      ]);
      expect(events.at(-1)).toMatchObject({
        event: "sandbox_stop_dispatch",
        source: "user_stop",
        sandboxId: launched.data.id,
      });
    } finally {
      log.mockRestore();
    }
  });

  test("stop without a provider timestamp retains observed compute time", async () => {
    const { token, client, people, boat, db, clock } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    await db.query("update sandboxes set usage_running_since=$2::timestamptz - interval '12 seconds' where id=$1", [
      launched.data.id,
      clock.now.toISOString(),
    ]);
    expect((await call(mcp, "stop", { id: launched.data.id })).data).toMatchObject({ status: "stopped" });
    expect(boat.stops).toEqual(["bx_1"]);
    const row = await db.query<{ status: string; stopped_at: Date | null; seconds: number | null }>(
      "select status::text as status, stopped_at, usage_runtime_seconds as seconds from sandboxes where id = $1",
      [launched.data.id],
    );
    expect(row.rows[0]?.status).toBe("stopped");
    expect(row.rows[0]?.stopped_at?.toISOString()).toBe(clock.now.toISOString());
    expect(row.rows[0]?.seconds).toBe(12);
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

test("authenticated MCP forwards the configured shared orchestrator runtime rather than a disabled copy", async () => {
  const seen: string[] = [];
  const runtime = {
    list: async (caller: { userId: string }, orgId: string) => {
      seen.push(caller.userId, orgId);
      return { version: 1, items: [], cursor: null };
    },
  } as unknown as import("../src/orchestrator-runtime.ts").OrchestratorRuntime;
  const s = await start({ orchestrators: runtime });
  const mcp = await s.client(await s.token(s.people.owner));
  const result = await mcp.callTool({ name: "orchestrator_list", arguments: { args: { orgId: s.people.org } } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ version: 1, items: [], cursor: null });
  expect(seen).toEqual([s.people.owner, s.people.org]);
});

// Token resolution in these fixtures must not leak audit records to stdout.
captureGitHubAuditLogs();

test("MCP launch preserves the closed busy account code and safe action", async () => {
  const { token, client, people, boat } = await start({
    providerFor: () => {
      throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
    },
  });
  const mcp = await client(await token(people.owner));
  const result = await call(mcp, "launch", { golden: "shared", harness: "claude" });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("error code: credential_busy");
  expect(result.text).toContain(CREDENTIAL_BUSY_MESSAGE);
  expect(boat.forks).toHaveLength(0);
});
