import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  mutateCredentialAccount,
  ProviderError,
  VaultError,
} from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import helperManifest from "../../core/helper/manifest.json";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { readStatus } from "../src/turns.ts";
import { encryptedRecoveryExec } from "./fixtures/recovery-exec.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import {
  bunLikeSql,
  call,
  ENCRYPTION_KEY,
  GITHUB_APP,
  harness,
  PUBLIC_URL,
  SECRETS,
  type TestServer,
} from "./support.ts";

const sharedDatabase = rowOnlyDatabase();
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: Parameters<typeof harness>[0] = {}) {
  server = await harness(options, await sharedDatabase());
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
  test("/mcp without a valid token is the OAuth challenge", async () => {
    const { handler } = await start();
    for (const authorization of [undefined, `Bearer armada_sk_${"not-a-real-token-but-long-enough-000000000"}`]) {
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
    expect((await call(mcp, "list")).isError).toBe(false);
    const [row] = (await auth.listServiceTokens(people.member)) as { id: string }[];
    await auth.revokeToken("service", {
      id: row?.id ?? "",
      userId: people.member,
      revokedAt: new Date().toISOString(),
    });
    await expect(mcp.callTool({ name: "list", arguments: {} })).rejects.toThrow();
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
      provider: "boat",
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
    const sent = await dashboard.tool("send", {
      id: launched.data.id,
      prompt: "and the tests",
      request_id: crypto.randomUUID(),
    });
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
    const response = await rpc(handler, jwt).post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list", arguments: {} },
    });
    expect(response.status).toBe(503);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "operator_failure",
      requestId: response.headers.get("x-request-id"),
      phase: "mcp.authentication",
    });
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
    const started = await rpc(handler, jwt).tool("launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(started.result?.isError).toBeUndefined();
    expect(started.result?.structuredContent).toMatchObject({ id: expect.any(String) });
  });
});

describe("on the database client production uses", () => {
  test("a Supabase session drives every tool when the driver refuses raw array parameters", async () => {
    const { session, client, boat, people } = await start({
      sql: (db) => bunLikeSql(db),
      authStore: (db) => createSqlAuthStore(bunLikeSql(db)),
    });
    const mcp = await client(session(people.member, []));

    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
    expect(launched.isError).toBe(false);

    const listed = await call(mcp, "list");
    expect(listed.isError).toBe(false);
    expect(listed.data.sandboxes).toHaveLength(1);
    expect((await call(mcp, "list", { status: ["ready", "running"] })).isError).toBe(false);
    expect((await call(mcp, "status", { id: launched.data.id })).isError).toBe(false);
    expect((await call(mcp, "logs", { id: launched.data.id })).isError).toBe(false);
    boat.finish("bx_1", "prompt_1", "finished");
    const waited = await call(mcp, "status", { wait: true, id: launched.data.id, timeout_seconds: 5 });
    expect(waited.isError).toBe(false);
    expect((await call(mcp, "send", { id: launched.data.id, prompt: "and the tests" })).isError).toBe(false);
    const stopped = await call(mcp, "stop", { id: launched.data.id });
    expect(stopped.isError).toBe(false);
    expect(stopped.data).toMatchObject({ status: "stopped" });
  });

  test("an internal tool error answers generically and logs its real cause, redacted", async () => {
    const lines: string[] = [];
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature-part";
    const { handler, token, people } = await start({
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
    const response = await rpc(handler, await token(people.member)).post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list", arguments: {} },
    });
    const { result } = (await response.json()) as { result: { isError: boolean; _meta: { requestId: string } } };
    const requestId = response.headers.get("x-request-id") ?? "";
    expect(requestId).toBeTruthy();
    expect(result.isError).toBe(true);
    expect(result._meta.requestId).toBe(requestId);
    const failure = JSON.stringify(result);
    expect(failure).toContain("Check the current state before retrying.");
    expect(failure).toContain("error code: internal");
    expect(failure).not.toContain("hunter2");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "operator_failure",
      phase: "tool.list",
      requestId,
      errorClass: "Error",
      message: "Exception message withheld",
    });
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain(bearer);
  });
});

describe("tools", () => {
  test("advertised usage schemas accept incomplete subtotals on status and list", async () => {
    const { token, client, people } = await start();
    const mcp = await client(await token(people.member));
    // The SDK validates callTool receipts against the schemas cached by listTools.
    await mcp.listTools();
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "codex", prompt: "go" });
    const status = await call(mcp, "status", { id: launched.data.id });
    expect(status.isError).not.toBe(true);
    expect(status.data).toMatchObject({ usage: { tokenTotals: { incomplete: true } } });
    const listed = await call(mcp, "list");
    expect(listed.isError).not.toBe(true);
    expect(listed.data).toMatchObject({
      sandboxes: expect.arrayContaining([
        expect.objectContaining({
          id: launched.data.id,
          usage: expect.objectContaining({ tokenTotals: expect.objectContaining({ incomplete: true }) }),
        }),
      ]),
    });
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
        provider: "boat",
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
      provider: "boat",
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
    expect(boat.execs.map((exec) => exec.command).join("\n")).toContain("git fetch origin");
    expectNoSecret(launched.text);
  });

  test("launch reports GitHub as not connected, without failing, when the caller never connected it", async () => {
    const { token, client, people, boat } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
    });
    expect(launched.isError).toBe(false);
    expect(launched.data.github).toMatchObject({ status: "not_connected", login: null });
    expect(boat.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude });
  });

  test("private repository authorization refuses HTTP and MCP before any compute allocation", async () => {
    const s = await start();
    await s.db.query("update goldens set config=$1::jsonb where name='shared'", [
      JSON.stringify({
        repos: [{ url: "https://github.com/acme/private.git", branch: "main", dir: "private" }],
        init: [],
      }),
    ]);
    const bearer = await s.token(s.people.member);
    const before = (await s.db.query("select id from sandboxes order by id")).rows;
    const response = await handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/sandbox/launch", {
        method: "POST",
        headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
        body: JSON.stringify({ golden: "shared", harness: "claude", org: s.people.org, provider: "boat" }),
      }),
      {
        authStore: s.auth,
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store: createSqlVaultStore(s.db),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(s.db),
        providerFor: s.boat.providerFor,
        github: {
          app: GITHUB_APP,
          fetch: (async () => Response.json({ message: "Not found." }, { status: 404 })) as unknown as typeof fetch,
        },
      },
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: {
        code: "no_credentials",
        message: expect.stringContaining("Repository private needs a GitHub connection"),
      },
    });
    const mcp = await call(await s.client(bearer), "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain("armada github connect");
    expect(s.boat.forks).toHaveLength(0);
    expect((await s.db.query("select id from sandboxes order by id")).rows).toEqual(before);
  });

  test("launch with a connected GitHub acts as the caller: fresh token in the env, git set up, refresh token rotated", async () => {
    const { token, client, people, boat, github, db } = await start();
    await github.connect(people.member, "octocat", 583231);
    const mcp = await client(await token(people.member));

    const first = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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

    const second = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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

    const first = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(first.isError).toBe(false);
    expect(first.data.github).toMatchObject({ status: "revoked", login: null });
    expect((first.data.github as { message: string }).message).toContain("Reconnect GitHub");
    expect(boat.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRETS.orgClaude });

    await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(github.refreshed).toHaveLength(1);
  });

  test("exec output masks GitHub and narrow MCP gateway credentials", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    const narrow = `armada_gw_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    boat.setExecOutput({ stdout: `GH_TOKEN=ghu_${"0123456789abcdefghijABCDEFGHIJ0123"} MCP=${narrow}` });
    const ran = await call(mcp, "exec", { id: launched.data.id, command: "env" });
    expect(String(ran.data.stdout).includes(narrow)).toBe(false);
    expect(ran.data.stdout).toBe("GH_TOKEN=*** MCP=***");
  });

  test("launch of a private golden uses its owner's own credential and personal boat key", async () => {
    const { token, client, people, boat } = await start();
    const launched = await call(await client(await token(people.owner)), "launch", {
      provider: "boat",
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
      provider: "boat",
      golden: "mine",
      harness: "claude",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("No boat golden named 'mine'");
    expect(boat.forks).toHaveLength(0);
  });

  test("launch refuses a harness Armada does not run", async () => {
    const { token, client, people } = await start();
    const refused = await call(await client(await token(people.member)), "launch", {
      provider: "boat",
      golden: "shared",
      harness: "pi",
    });
    expect(refused.isError).toBe(true);
  });

  test("list exposes safe org metadata while member interior operations make no provider calls", async () => {
    const { token, client, people, boat } = await start();
    const owner = await client(await token(people.owner));
    const mine = await call(owner, "launch", { provider: "boat", golden: "mine", harness: "claude" });
    const member = await client(await token(people.member));
    const listed = await call(member, "list");
    expect(listed.data.sandboxes).toMatchObject([{ id: mine.data.id, canOpen: false, canManage: false }]);
    const before = { keys: boat.keys.length, execs: boat.execs.length, stops: boat.stops.length };
    const controls = [
      ["status", {}],
      ["logs", {}],
      ["status", { wait: true, timeout_seconds: 0 }],
      ["exec", { command: "pwd" }],
      ["send", { prompt: "hello" }],
      ["send", { steer: true, prompt: "hello" }],
      ["stop", { turn: true }],
      ["stop", {}],
    ] as const;
    for (const [name, args] of controls) {
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
    ["Agent request failed", "failed", "Agent failed. Check the agent configuration before retrying."],
  ] as const) {
    test(`turn error does not fail the machine: ${reason}`, async () => {
      const { token, client, people, boat, db } = await start();
      const mcp = await client(await token(people.member));
      const launched = await call(mcp, "launch", {
        provider: "boat",
        golden: "shared",
        harness: "codex",
        prompt: "go",
      });
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
      await boat.provider.stop({ sandboxId: "bx_1" });
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
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
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
    // A failed native subscription turn preserves safe reset evidence in the public report.
    const resetsAt = "2026-11-10T00:00:00.000Z";
    boat.sandbox("bx_1").events.push({
      id: "safe-plan-limit",
      at: 10,
      kind: "other",
      type: "usage_limit",
      promptId: "prompt_2",
      data: { code: "usage_limit_exceeded", resetsAt, message: "private-vendor-body" },
    });
    boat.finish("bx_1", "prompt_2", "failed");
    const exhausted = await call(mcp, "status", { id: launched.data.id });
    expect(exhausted.data).toMatchObject({
      status: "ready",
      prompt: {
        state: "failed",
        reason: `Plan limit reached. Resets at ${resetsAt}. Wait for the limit to reset, or switch to another account before sending the prompt again.`,
        limit: { code: "usage_limit_exceeded", resetsAt },
      },
    });
    expect(JSON.stringify(exhausted.data)).not.toContain("private-vendor-body");
    const health = await db.query(
      `select e.account_id, e.account_version, e.code, e.resets_at, e.event_at::text
       from account_exhaustion e join sandboxes s on s.credential_id=e.account_id and s.credential_version=e.account_version
       where s.id=$1`,
      [launched.data.id],
    );
    expect(health.rows).toMatchObject([
      { code: "usage_limit_exceeded", resets_at: new Date(resetsAt), event_at: "10" },
    ]);
  });

  test("status records a reset from retained provider evidence for an already cached native outcome", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
    const promptId = "prompt_1";
    const resetsAt = "2026-11-10T00:00:00.000Z";
    const limit = { code: "usage_limit_exceeded", resetsAt };
    const { model } = boat.prompts[0]!;
    await db.query("update sandbox_turn_models set evidence=$3::jsonb where sandbox_id=$1 and prompt_id=$2", [
      launched.data.id,
      promptId,
      JSON.stringify({
        requestedModel: model,
        observedModel: model,
        modelSelectionReason: null,
        modelSelectionMessage: null,
        terminalOutcome: { state: "failed", reason: "Plan limit reached.", limit },
      }),
    ]);
    boat.sandbox("bx_1").events.push({
      id: "limit",
      promptId,
      at: 10,
      kind: "other",
      type: "usage_limit",
      data: limit,
    });
    boat.finish("bx_1", promptId, "failed");

    const status = await call(mcp, "status", { id: launched.data.id, prompt_id: promptId });
    expect(status.data.prompt).toMatchObject({ state: "failed", limit });
    const health = await db.query("select resets_at,event_at::text from account_exhaustion");
    expect(health.rows).toEqual([{ resets_at: new Date(resetsAt), event_at: "10" }]);
  });

  test("retained native Modal exhaustion is attributed to the turn's account after a rebind", async () => {
    const { db, people, boat, clock } = await start();
    const golden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
          modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'modal','org','modal','master','image','workspace','main','app','{"repos":[],"init":[]}')
       returning id`,
        [people.org, people.owner],
      )
    ).rows[0]!;
    const accounts = (
      await db.query<{ id: string; version: number }>(
        "select id,version from credentials where kind='claude_oauth' and owner_id in ($1,$2) order by scope",
        [people.org, people.owner],
      )
    ).rows;
    const [original, replacement] = [accounts[0]!, accounts[1]!];
    const provider = { ...boat.provider, id: "modal" as const };
    const native = await provider.fork({ from: "image" });
    const { promptId } = await provider.prompt({ sandboxId: native.id, harness: "claude", text: "work" });
    const row = await createSqlSandboxStore(db).insert({
      id: crypto.randomUUID(),
      provider: "modal",
      providerSandboxId: native.id,
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "ready",
      model: "claude-sonnet-4-6",
      reasoningEffort: "default",
      credentialId: replacement.id,
      credentialVersion: replacement.version,
    });
    const { sandboxes } = createSqlData(db)({
      userId: people.owner,
      via: "service",
      orgs: [{ orgId: people.org, role: "member" }],
    });
    await sandboxes.recordTurnModel!(row.id, promptId, null, {
      credentialId: original.id,
      credentialVersion: original.version,
    });
    const resetsAt = "2026-11-10T00:00:00.000Z";
    boat.sandbox(native.id).events.push({
      id: "limit",
      kind: "other",
      type: "usage_limit",
      data: { code: "rate_limited", resetsAt },
      promptId,
      at: clock.now.getTime(),
    });
    boat.finish(native.id, promptId, "finished");
    await readStatus(provider, sandboxes, (await sandboxes.get(row.id))!, { promptId, now: clock.now, stored: true });
    const health = await db.query("select account_id,account_version,resets_at from account_exhaustion");
    expect(health.rows).toEqual([
      { account_id: original.id, account_version: original.version, resets_at: new Date(resetsAt) },
    ]);
  });

  test("launch takes the org that has the golden for a session in several orgs", async () => {
    const { session, client, people, boat, db } = await start();
    const mcp = await client(session(people.member, [people.org, people.otherOrg]));
    const elsewhere = await call(mcp, "launch", { provider: "boat", golden: "elsewhere", harness: "claude" });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain("error code: missing_credential");
    expect(boat.forks).toHaveLength(0);

    const shared = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(shared.isError).toBe(false);
    expect(boat.keys.at(-1)).toBe(SECRETS.orgBoat);

    await db.query(
      `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
       select $1, 'shared', 'org', $2, $3, config from goldens where name = 'shared'`,
      [people.otherOrg, people.member, `a${"4".repeat(62)}`],
    );
    const ambiguous = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(ambiguous.text).toContain("several of your orgs");
    const chosen = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", org: "example" });
    expect(chosen.isError).toBe(false);
    const outsider = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
      org: crypto.randomUUID(),
    });
    expect(outsider.text).toContain("not a member");
  });

  test("Codex without response models and legacy turns stay finished with neutral evidence", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "codex",
      prompt: "work",
    });
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
        // Stored journal projection is allowed; native collection is not.
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
    expect(writes).toEqual(["usage"]);
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

  test("running status stays unsettled; transient terminal gaps retry and long history does not hide the turn", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
      model: "chosen",
      prompt: "work",
    });
    const original = boat.provider.events;
    const running = await call(mcp, "status", { id: launched.data.id });
    expect(running.data).toMatchObject({
      status: "running",
      settled: false,
      prompt: { state: "running", rateLimit: null },
    });
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
    // This case creates a trigger: keep it off the row-only shared connection.
    server = await harness();
    const { token, client, people, boat, db } = server;
    const mcp = await client(await token(people.member));
    await db.exec(
      `create function reject_model_record() returns trigger language plpgsql as $$ begin raise exception 'record unavailable'; end $$; create trigger reject_model_record before insert on sandbox_turn_models for each row execute function reject_model_record();`,
    );
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
      prompt: "work",
    });
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
      provider: "boat",
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
    const waited = await call(mcp, "status", { wait: true, id, timeout_seconds: 1 });
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

  test("status with wait returns once the turn ends, and timedOut when it does not", async () => {
    const { token, client, people, boat, clock } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
    const before = clock.now.getTime();
    const waiting = await call(mcp, "status", { wait: true, id: launched.data.id, timeout_seconds: 3 });
    expect(waiting.data).toMatchObject({ timedOut: true, settled: false, status: "running" });
    expect(clock.now.getTime() - before).toBe(3000);

    boat.finish("bx_1", "prompt_1", "finished");
    const done = await call(mcp, "status", { wait: true, id: launched.data.id, timeout_seconds: 3 });
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
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
    const events = boat.sandbox("bx_1").events;
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Wor", partial: true, tools: [] });
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Working", partial: false, tools: [] });
    const first = await call(mcp, "logs", { id: launched.data.id });
    expect((first.data.events as { id: string; text: string }[]).map((event) => [event.id, event.text])).toEqual([
      [
        "ev_prompt_1",
        "go\n\nSave any deliverable files directly in /home/user/outputs. Create that directory if needed.",
      ],
      ["ev_msg", "Working"],
    ]);
    expect(first.data).toMatchObject({ cursor: "3", hasMore: false });
    const next = await call(mcp, "logs", { id: launched.data.id, since_cursor: first.data.cursor });
    expect(next.data).toMatchObject({ events: [], cursor: "3" });
  });

  test("logs reads every page only when all is requested and advances the cursor", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
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
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "codex",
      credentialId: first.id,
    });
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
      (await call(admin, "send", { id: launched.data.id, steer: true, prompt: "Cannot restart with owner's account" }))
        .isError,
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
    const steerRefused = await call(mcp, "send", { id: launched.data.id, steer: true, prompt: "Must not restart" });
    expect(steerRefused.isError).toBe(true);
    expect(steerRefused.text).toContain("No fallback was used");
    expect(boat.steers).toHaveLength(steerCount);
  });

  test("a stop without a retained recovery disk remains terminal on later sends", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "codex" });
    const get = boat.provider.get.bind(boat.provider);
    boat.provider.get = async (id) => {
      const info = await get(id);
      return info.state === "stopped" ? { ...info, stopNote: "checkpoint_failed_disk_not_retained" } : info;
    };
    const stopped = await call(mcp, "stop", { id: launched.data.id });
    expect(stopped.data).toMatchObject({ status: "failed" });
    const sent = await call(mcp, "send", { id: launched.data.id, prompt: "must not resume" });
    expect(sent.text).toContain("sandbox_terminal");
    expect(boat.prompts).toHaveLength(0);
  });

  test("an idle launch keeps its model and effort for every send, across stop, and an override lasts one turn", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const refused = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "codex",
      reasoningEffort: "extreme",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Use one of: low, medium, high, xhigh, max, ultra");
    expect(boat.forks).toHaveLength(0);

    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "codex",
      model: "gpt-6.1-terra",
      reasoningEffort: "high",
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
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const codex = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "codex", prompt: "go" });
    const selected = await call(mcp, "send", {
      id: codex.data.id,
      steer: true,
      prompt: "Use bun",
      conversation_id: "selected-conversation",
      model: "gpt-5.4",
    });
    expect(selected.isError).toBe(true);
    expect(selected.text).toContain("Launch another sandbox");
    expect(selected.text).toContain("error code: conflict");
    await db.query("update sandboxes set conversation_ids=array['older','conv_1'] where id=$1", [codex.data.id]);
    expect((await call(mcp, "send", { id: codex.data.id, steer: true, prompt: "Use bun" })).data).toMatchObject({
      delivery: "restart",
    });
    expect(boat.steers.at(-1)?.conversationId).toBe("conv_1");
    const claude = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    // The list can see ready while a background observation owns the SQL lease.
    expect((await call(mcp, "list")).data.sandboxes).toContainEqual(
      expect.objectContaining({ id: claude.data.id, status: "ready" }),
    );
    const observing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await db.query("update sandboxes set reconcile_after=now()+interval '1 hour' where id<>$1", [claude.data.id]);
    const lifecycle = createSandboxLifecycle(bunLikeSql(db), async () => ({
      ...boat.provider,
      get: async (id) => {
        const info = await boat.provider.get(id);
        observing.resolve();
        await release.promise;
        return { ...info, state: "stopped" as const, retainedSnapshot: "usable" as const };
      },
    }));
    const tick = lifecycle.reconcileOne();
    try {
      await observing.promise;
      const refused = await call(mcp, "send", { id: claude.data.id, steer: true, prompt: "Use bun" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Use send");
    } finally {
      release.resolve();
      await tick;
      await lifecycle.drain();
    }
    // The superseded observation cannot publish its stale terminal result.
    expect((await db.query("select status from sandboxes where id=$1", [claude.data.id])).rows[0]).toEqual({
      status: "ready",
    });
    await call(mcp, "send", { id: claude.data.id, prompt: "go" });
    expect((await call(mcp, "send", { id: claude.data.id, steer: true, prompt: "Use bun" })).data).toMatchObject({
      delivery: "native",
    });
    expect(boat.steers).toHaveLength(3);
  });

  test("exec redacts the agent's credentials from the output", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    boat.setExecOutput({ stdout: `CLAUDE_CODE_OAUTH_TOKEN=${SECRETS.orgClaude}\nok\n` });
    const ran = await call(mcp, "exec", { id: launched.data.id, command: "env" });
    expect(ran.data).toMatchObject({ exitCode: 0, stdout: "CLAUDE_CODE_OAUTH_TOKEN=***\nok\n" });
    expectNoSecret(ran.text);
  });

  test("stop with turn interrupts the current conversation and leaves compute up", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
      prompt: "work",
    });
    const interrupt = spyOn(boat.provider, "interrupt");
    const id = launched.data.id;
    await db.query("update sandboxes set conversation_ids=array['older','conv_1'] where id=$1", [id]);
    const selected = await call(mcp, "stop", { id, turn: true, conversation_id: "selected-conversation" });
    expect(selected.isError).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    const stopped = await call(mcp, "stop", { id, turn: true });
    expect(stopped.data).toEqual({ id, interrupted: true });
    expect(interrupt).toHaveBeenCalledWith({ sandboxId: "bx_1", conversationId: "conv_1" });
    expect(boat.stops).toEqual([]);
  });

  test.each(["running", "failed"])(
    "a mid-turn stop queues until interruption settles and retains %s state",
    async (state) => {
      const { token, client, people, boat, db } = await start();
      const mcp = await client(await token(people.member));
      const launched = await call(mcp, "launch", {
        provider: "boat",
        golden: "shared",
        harness: "claude",
        prompt: "work",
      });
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
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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
    const launched = await call(mcp, "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
      prompt: "work",
    });
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
          tool === "exec" ? "exec" : "send",
          tool === "exec"
            ? { id, command: "touch after-capture" }
            : { id, steer: true, prompt: "change after capture" },
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
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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

  test("native send hands a fresh pre-dispatch retention refusal to the stop reconciler", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const { data } = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect((await call(mcp, "stop", { id: data.id })).data.status).toBe("stopped");
    boat.provider.prompt = async () => {
      boat.sandbox("bx_1").info.retainedSnapshot = "unconfirmed";
      throw new BoatRetentionUnconfirmed();
    };
    const refused = await call(mcp, "send", { id: data.id, prompt: "continue" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Boat retained data has not been verified");
    const row = (
      await db.query("select status, activity_lease_id, stop_requested_at from sandboxes where id=$1", [data.id])
    ).rows[0];
    expect(row).toMatchObject({ status: "stopping", activity_lease_id: null, stop_requested_at: expect.any(Date) });
    boat.sandbox("bx_1").info.retainedSnapshot = "usable";
    const lifecycle = createSandboxLifecycle(bunLikeSql(db), async () => boat.provider);
    expect(await lifecycle.reconcileOne()).toBe(true);
    expect((await call(mcp, "status", { id: data.id })).data.status).toBe("stopped");
    expect(boat.stops).toHaveLength(1);
  });

  test("user stop leaves an unverified archive in worker custody without dispatching another stop", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const { data } = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    const machine = boat.sandbox("bx_1");
    machine.info = { ...machine.info, state: "stopped", providerState: "archived", retainedSnapshot: "unconfirmed" };
    expect((await call(mcp, "stop", { id: data.id })).data.status).toBe("stopping");
    expect(boat.stops).toHaveLength(0);
  });

  test.each(["preserved", "clean"] as const)("user stop then lifecycle stop reuses its %s capture", async (result) => {
    const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
    process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
      const { token, client, people, boat, db, auth, clock } = await start();
      const bearer = await token(people.member);
      const mcp = await client(bearer);
      const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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
            state: result === "preserved" ? "stopping" : "stopped",
            providerState: result === "preserved" ? "archiving" : "archived",
            retainedSnapshot: "pending",
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
      expect((await call(mcp, "status", { wait: true, id, timeout_seconds: 0 })).data.timedOut).toBe(true);
      expect((await call(mcp, "stop", { id })).data.status).toBe("stopping");
      await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [id]);
      const lifecycle = createSandboxLifecycle(bunLikeSql(db), async () => boat.provider);
      expect(await lifecycle.reconcileOne()).toBe(true);
      expect(boat.stops).toHaveLength(1);
      boat.sandbox("bx_1").info = {
        ...boat.sandbox("bx_1").info,
        state: "stopped",
        providerState: "archived",
        retainedSnapshot: "usable",
      };
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
      const recovery = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandbox/recovery`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ id }),
        }),
        {
          authStore: auth,
          supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
          store: createSqlVaultStore(db),
          encryptionKey: ENCRYPTION_KEY,
          data: createSqlData(db),
          providers: { resolve: async () => boat.provider },
          now: () => clock.now,
        },
      );
      expect(recovery?.status).toBe(200);
      expect(await recovery?.json()).toEqual({ archive: result === "preserved" ? archive : null });
    } finally {
      if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
      else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
    }
  });

  test("user-stop trace places capture before physical dispatch", async () => {
    const { token, client, people, boat } = await start();
    const mcp = await client(await token(people.member));
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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
    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
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

  test("a member of another org sees none of this org's sandboxes", async () => {
    const { token, client, people } = await start();
    const launched = await call(await client(await token(people.member)), "launch", {
      provider: "boat",
      golden: "shared",
      harness: "claude",
    });
    const other = await client(await token(people.member, people.otherOrg));
    expect((await call(other, "list")).data.sandboxes).toEqual([]);
    expect((await call(other, "stop", { id: launched.data.id })).isError).toBe(true);
  });
});

// Token resolution in these fixtures must not leak audit records to stdout.
captureGitHubAuditLogs();

test("MCP launch preserves the closed busy account code and safe action", async () => {
  const { token, client, people, boat } = await start({
    providerFor: () => {
      throw new VaultError("credential_busy", "The model account is unavailable. Check its current credentials.");
    },
  });
  const mcp = await client(await token(people.owner));
  const result = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("error code: credential_busy");
  expect(result.text).toContain("The model account is unavailable. Check its current credentials.");
  expect(boat.forks).toHaveLength(0);
});

test("public MCP inventory and schemas expose operation contracts", async () => {
  const { token, client, people } = await start();
  const mcp = await client(await token(people.member));
  const { tools } = await mcp.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "exec",
    "launch",
    "list",
    "logs",
    "report",
    "send",
    "status",
    "stop",
  ]);
  for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  const launch = tools.find((tool) => tool.name === "launch");
  expect(launch?.inputSchema.anyOf).toEqual(
    ["boat", "modal"].map((provider) =>
      expect.objectContaining({
        properties: expect.objectContaining({ provider: expect.objectContaining({ const: provider }) }),
        required: expect.arrayContaining(["provider", "harness", "golden"]),
      }),
    ),
  );
});
