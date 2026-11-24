import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import { createSqlVaultStore, ProviderError, VaultError } from "@armada/core/server";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import helperManifest from "../../core/helper/manifest.json";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { recordRuntimeStartupFailure } from "../src/sandbox-lifecycle.ts";
import { reuseCollectorKeyPair } from "./fixtures/recovery-exec.ts";
import { enrolledLaunchPolicy } from "./launch-runtime.fixture.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { seedPersistedBoat } from "./persisted-boat.fixture.ts";
import {
  bunLikeSql,
  call,
  ENCRYPTION_KEY,
  GITHUB_APP,
  harness,
  PUBLIC_URL,
  SECRETS,
  seedDatabase,
  type TestServer,
} from "./support.ts";

let restoreCollectorKeys: (() => void) | undefined;
beforeAll(() => {
  restoreCollectorKeys = reuseCollectorKeyPair();
});
afterAll(() => restoreCollectorKeys?.());

let sharedDatabase: ReturnType<typeof migratedDatabase> | undefined;
let pendingServer: Promise<TestServer> | undefined;

beforeAll(async () => {
  sharedDatabase = migratedDatabase();
  await sharedDatabase;
});

afterAll(async () => {
  const pending = sharedDatabase;
  sharedDatabase = undefined;
  const db = await pending?.catch(() => undefined);
  await db?.close();
});

afterEach(async () => {
  const pending = pendingServer;
  pendingServer = undefined;
  const server = await pending?.catch(() => undefined);
  await server?.close();
});

function start(options: Parameters<typeof harness>[0] = {}) {
  if (!sharedDatabase) throw new Error("Server database is not open");
  const pending = sharedDatabase.then(async (db) => {
    await db.exec(`
    reset role;
    reset all;
    set search_path=public;
    truncate members cascade;
    delete from provider_launch_requests;
    delete from ordinary_launch_receipts;
    delete from sandboxes;
    delete from account_exhaustion;
    delete from account_spend;
    delete from credentials;
    delete from orgs;
    delete from auth.users;
    delete from mcp_invalidations;
  `);
    return harness({ enrolledLaunch: true, ...options }, await seedDatabase(db));
  });
  pendingServer = pending;
  return pending.then((server) => {
    if (pendingServer !== pending) throw new Error("Server fixture teardown has started");
    return server;
  });
}

const allSecrets = Object.values(SECRETS);

function expectNoSecret(text: string) {
  for (const secret of allSecrets) expect(text).not.toContain(secret);
}

async function seedRunningSandbox({ db, boat, people }: TestServer) {
  const machine = await boat.provider.fork({ from: "shared" });
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
     select $1,id,org_id,$2,'boat',$3,'claude','running'
     from goldens where org_id=$4 and name='shared'`,
    [id, people.member, machine.id, people.org],
  );
  return { id, machine };
}

async function logsFixture() {
  const server = await start();
  const { boat, people, client, token } = server;
  const { id, machine } = await seedRunningSandbox(server);
  await boat.provider.prompt({ sandboxId: machine.id, harness: "claude", text: "go" });
  const mcp = await client(await token(people.member));
  return { id, mcp, events: boat.sandbox(machine.id).events };
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
    const { handler, session, signOut, supabaseCalls, people } = await start();
    const jwt = session(people.member);
    const dashboard = rpc(handler, jwt);

    for (let i = 0; i < 2; i++) {
      const listed = await dashboard.tool("list", {});
      expect(listed.result?.structuredContent).toMatchObject({ sandboxes: [] });
    }
    expect(supabaseCalls).toHaveLength(2);

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

test("HTTP request logs use a fixed route template in place of request path parameters and query values", async () => {
  const lines: string[] = [];
  const { handler } = await start({ log: (line) => lines.push(line) });
  const response = await handler(new Request(`${PUBLIC_URL}/mcp/gateway/private-connection?query=private-value`));
  expect(response.status).toBe(404);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "http_request", path: "/mcp/gateway/:connectionId" });
  expect(lines[0]).not.toContain("private-connection");
  expect(lines[0]).not.toContain("private-value");
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
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "http_request",
      requestId: response.headers.get("x-request-id"),
      path: "/mcp",
      status: 503,
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
    expect(started.result?.structuredContent).toMatchObject({ sandbox: { id: expect.any(String) } });
  });
});

describe("on the database client production uses", () => {
  test("a Supabase session reads and stops a sandbox through the server SQL driver", async () => {
    const { session, client, boat, people, db } = await start({
      sql: (db) => bunLikeSql(db),
      authStore: (db) => createSqlAuthStore(bunLikeSql(db)),
    });
    const mcp = await client(session(people.member, []));

    const launched = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude", prompt: "go" });
    expect(launched.isError).toBe(false);
    const sandboxId = await seedPersistedBoat({ db, boat, people }, { prompt: "go" });

    const listed = await call(mcp, "list");
    expect(listed.isError).toBe(false);
    expect(listed.data.sandboxes).toHaveLength(2);
    expect((await call(mcp, "list", { status: ["ready", "running"] })).isError).toBe(false);
    expect((await call(mcp, "status", { id: sandboxId })).isError).toBe(false);
    const logs = await call(mcp, "logs", { id: sandboxId });
    expect(logs.isError).toBe(false);
    expect(logs.data.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "prompt" })]));
    const stopped = await call(mcp, "stop", { id: sandboxId });
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
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    // The SDK validates callTool receipts against the schemas cached by listTools.
    await mcp.listTools();
    const sandboxId = await seedPersistedBoat({ db, boat, people }, { harness: "codex", prompt: "go" });
    const status = await call(mcp, "status", { id: sandboxId });
    expect(status.isError).not.toBe(true);
    expect(status.data).toMatchObject({ usage: { tokenTotals: { incomplete: true } } });
    const listed = await call(mcp, "list");
    expect(listed.isError).not.toBe(true);
    expect(listed.data).toMatchObject({
      sandboxes: expect.arrayContaining([
        expect.objectContaining({
          id: sandboxId,
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
    const request = { provider: "boat", golden: "shared", harness: "claude", prompt: "Fix the build" };
    const unsupported = await call(helperClient, "launch", { ...request, helperCapabilities: ["diagnose"] });
    expect(unsupported).toMatchObject({ isError: true, text: expect.stringContaining("does not yet support helpers") });
    expect(boat.forks).toHaveLength(0);
    const launched = await call(helperClient, "launch", request);
    expect(launched.isError).toBe(false);
    expect(launched.data).toMatchObject({
      golden: { name: "shared" },
      sandbox: { harness: "claude", status: "running" },
      promptId: "prompt_1",
      helper: { status: "supported", protocol: 1, capabilities: ["diagnose"] },
    });
    expect(boat.forks[0]).toMatchObject({ noEnv: true, env: {} });
    expect(boat.keys.at(-1)).toBe(SECRETS.orgBoat);
    expect(
      (
        await db.query(`select c.scope,c.owner_id,c.kind from sandboxes s
      join credentials c on c.id=s.credential_id`)
      ).rows,
    ).toEqual([{ scope: "org", owner_id: people.org, kind: "claude_oauth" }]);
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
    expect(boat.forks[0]?.env).toEqual({});
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
        launch: { runtime: enrolledLaunchPolicy(s.db) },
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
    expect(mcp.text).toContain("armada account login github");
    expect(s.boat.forks).toHaveLength(0);
    expect((await s.db.query("select id from sandboxes order by id")).rows).toEqual(before);
  });

  test("launch with connected GitHub configures the enrolled runtime as the caller and rotates the refresh token", async () => {
    const { token, client, people, boat, github, db } = await start();
    await github.connect(people.member, "octocat", 583231);
    const mcp = await client(await token(people.member));

    const first = await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(first.data.github).toEqual({
      status: "connected",
      login: "octocat",
      tokenExpiresAt: expect.any(String),
      message: null,
    });
    expect(boat.forks[0]?.env).toEqual({});
    expect(github.runtimeIdentities).toEqual([{ name: "octocat", email: "583231+octocat@users.noreply.github.com" }]);
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
    expect(boat.forks[0]?.env).toEqual({});

    await call(mcp, "launch", { provider: "boat", golden: "shared", harness: "claude" });
    expect(github.refreshed).toHaveLength(1);
  });

  test("exec output masks GitHub and narrow MCP gateway credentials", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const sandboxId = await seedPersistedBoat({ db, boat, people });
    const narrow = `armada_gw_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    boat.setExecOutput({ stdout: `GH_TOKEN=ghu_${"0123456789abcdefghijABCDEFGHIJ0123"} MCP=${narrow}` });
    const ran = await call(mcp, "exec", { id: sandboxId, command: "env" });
    expect(String(ran.data.stdout).includes(narrow)).toBe(false);
    expect(ran.data.stdout).toBe("GH_TOKEN=*** MCP=***");
  });

  test("launch of a private golden uses its owner's own credential and personal boat key", async () => {
    const { token, client, people, boat, db } = await start();
    const launched = await call(await client(await token(people.owner)), "launch", {
      provider: "boat",
      golden: "mine",
      harness: "claude",
    });
    expect(launched.data).toMatchObject({ sandbox: { status: "ready", conversationIds: [] }, promptId: null });
    expect(boat.forks[0]?.env).toEqual({});
    expect(
      (
        await db.query(`select c.scope,c.owner_id,c.kind from sandboxes s
      join credentials c on c.id=s.credential_id`)
      ).rows,
    ).toEqual([{ scope: "user", owner_id: people.owner, kind: "claude_oauth" }]);
    expect(boat.keys).toEqual([SECRETS.personalBoat]);
  });

  test.each(["accepted", "superseded", "journal failure", "receipt failure"] as const)(
    "prompted enrolled launch settlement (%s)",
    async (scenario) => {
      const { boat, client, db, people, token } = await start({
        modelAuth: (db) => createModelAuthOwnership(db, ENCRYPTION_KEY),
      });
      const mcp = await client(await token(people.member));
      await db.exec("update credentials set max_agents=1 where kind='claude_oauth'");
      const prompt = boat.provider.prompt.bind(boat.provider);
      let reservedAtDispatch = false;
      boat.provider.prompt = async (request) => {
        reservedAtDispatch = (await db.query("select sandbox_id from account_agent_reservations")).rows.length === 1;
        const receipt = await prompt(request);
        if (scenario === "superseded") await db.exec("update sandboxes set status='stopping' where status='starting'");
        return receipt;
      };
      if (scenario === "journal failure")
        await db.exec(`alter table sandbox_transitions add constraint reject_enrolled_launch_journal
          check (code <> 'runtime_enrolled')`);
      if (scenario === "receipt failure")
        await db.exec(`alter table sandboxes add constraint reject_enrolled_launch_receipt
          check (task_prompt_id is null)`);

      const launched = await call(mcp, "launch", {
        provider: "boat",
        golden: "shared",
        harness: "claude",
        prompt: "hello",
      }).finally(async () => {
        if (scenario === "journal failure")
          await db.exec("alter table sandbox_transitions drop constraint reject_enrolled_launch_journal");
        if (scenario === "receipt failure")
          await db.exec("alter table sandboxes drop constraint reject_enrolled_launch_receipt");
      });

      const accepted = scenario === "accepted";
      const superseded = scenario === "superseded";
      expect(reservedAtDispatch).toBe(true);
      expect((await db.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
      expect(launched.isError).toBe(!accepted);
      if (accepted) expect(launched.data).toMatchObject({ sandbox: { status: "running" }, promptId: "prompt_1" });
      expect(
        (
          await db.query(`select status, lifecycle_generation::int as generation, activity_lease_id,
          task_prompt_id, conversation_ids from sandboxes`)
        ).rows,
      ).toEqual([
        {
          status: accepted ? "running" : superseded ? "stopping" : "failed",
          generation: accepted || superseded ? 1 : 2,
          activity_lease_id: superseded ? expect.any(String) : null,
          task_prompt_id: accepted ? "prompt_1" : null,
          conversation_ids: accepted ? [expect.any(String)] : [],
        },
      ]);
      expect(
        (
          await db.query(`select from_status, actor, code, generation::int from sandbox_transitions
          where to_status='running'`)
        ).rows,
      ).toEqual(
        accepted
          ? [{ from_status: "starting", actor: "runtime_enrolment", code: "runtime_enrolled", generation: 1 }]
          : [],
      );
    },
  );

  test.each(["applied", "superseded", "reported", "rollback"] as const)(
    "launch failure settlement (%s)",
    async (scenario) => {
      const { boat, client, db, people, token } = await start();
      const mcp = await client(await token(people.member));
      if (scenario === "rollback")
        await db.exec(`alter table sandboxes add constraint reject_launch_diagnostic
        check (status_reason is null or status_reason='launch_failed')`);
      boat.provider.prompt = async () => {
        if (scenario === "superseded") await db.exec("update sandboxes set status='stopping' where status='starting'");
        if (scenario === "reported") {
          await bunLikeSql(db).transaction!(async (tx) => {
            const {
              rows: [launch],
            } = await tx.query<{ id: string; generation: string }>(
              "select id, lifecycle_generation::text as generation from sandboxes where status='starting'",
            );
            if (!launch) throw new Error("Missing starting launch");
            await recordRuntimeStartupFailure(
              tx,
              launch.id,
              launch.generation,
              "bootstrap_failed",
              "Startup already reported a failure",
            );
          });
        }
        throw new Error("Initial prompt submission failed.");
      };

      const launched = await call(mcp, "launch", {
        provider: "boat",
        golden: "shared",
        harness: "claude",
        prompt: "hello",
      }).finally(async () => {
        if (scenario === "rollback") await db.exec("alter table sandboxes drop constraint reject_launch_diagnostic");
      });
      expect(launched.isError).toBe(true);
      const { rows } = await db.query(
        "select status, status_reason, lifecycle_generation::int, activity_lease_id from sandboxes",
      );
      const settled = scenario === "applied" || scenario === "reported";
      const reason =
        scenario === "applied"
          ? expect.stringContaining("Initial prompt submission failed.")
          : scenario === "reported"
            ? "Startup already reported a failure"
            : null;
      const state = settled ? "failed" : scenario === "superseded" ? "stopping" : "starting";
      expect(rows).toEqual([
        {
          status: state,
          status_reason: reason,
          lifecycle_generation: settled ? 2 : 1,
          activity_lease_id: settled ? null : expect.any(String),
        },
      ]);
      const journal = await db.query(
        "select from_status, actor, code, generation::int from sandbox_transitions where to_status='failed'",
      );
      expect(journal.rows).toEqual(
        scenario === "applied"
          ? [{ from_status: "starting", actor: "lifecycle_runner", code: "launch_failed", generation: 2 }]
          : scenario === "reported"
            ? [{ from_status: "starting", actor: "lifecycle_runner", code: "bootstrap_failed", generation: 1 }]
            : [],
      );
    },
  );

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
    const { token, client, people, boat, db } = await start();
    const mine = await seedPersistedBoat({ db, boat, people }, { ownerId: people.owner, golden: "mine" });
    const member = await client(await token(people.member));
    const listed = await call(member, "list");
    expect(listed.data.sandboxes).toMatchObject([{ id: mine, canOpen: false, canManage: false }]);
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
      const denied = await call(member, name, { id: mine, ...args });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("No sandbox");
    }
    expect({ keys: boat.keys.length, execs: boat.execs.length, stops: boat.stops.length }).toEqual(before);
    const admin = await client(await token(people.admin));
    expect((await call(admin, "list")).data.sandboxes).toMatchObject([{ canOpen: true, canManage: true }]);
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

  test("logs pass the cursor through and keep one body per event id, the newest", async () => {
    const { id, mcp, events } = await logsFixture();
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Wor", partial: true, tools: [] });
    events.push({ id: "ev_msg", at: 2, kind: "message", text: "Working", partial: false, tools: [] });
    const first = await call(mcp, "logs", { id });
    expect((first.data.events as { id: string; text: string }[]).map((event) => [event.id, event.text])).toEqual([
      ["ev_prompt_1", "go"],
      ["ev_msg", "Working"],
    ]);
    expect(first.data).toMatchObject({ cursor: "3", hasMore: false });
    const next = await call(mcp, "logs", {
      id,
      since_cursor: first.data.cursor,
    });
    expect(next.data).toMatchObject({ events: [], cursor: "3" });
  });

  test("logs reads every page only when all is requested and advances the cursor", async () => {
    const { id, mcp, events } = await logsFixture();
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
    const first = await call(mcp, "logs", { id });
    expect(first.data.events).toHaveLength(100);
    expect(first.data).toMatchObject({ cursor: "100", hasMore: true });
    const all = await call(mcp, "logs", { id, all: true });
    expect(all.data.events).toHaveLength(206);
    expect(all.data).toMatchObject({ cursor: "206", hasMore: false });
  });

  test("a stop without a retained recovery disk remains terminal on later sends", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const sandboxId = await seedPersistedBoat({ db, boat, people }, { harness: "codex" });
    const get = boat.provider.get.bind(boat.provider);
    boat.provider.get = async (id) => {
      const info = await get(id);
      return info.state === "stopped" ? { ...info, stopNote: "checkpoint_failed_disk_not_retained" } : info;
    };
    const stopped = await call(mcp, "stop", { id: sandboxId });
    expect(stopped.data).toMatchObject({ status: "failed" });
    const journal = await db.query(
      "select actor, code from sandbox_transitions where sandbox_id=$1 and from_status='stopping' and to_status='failed'",
      [sandboxId],
    );
    expect(journal.rows).toEqual([{ actor: "lifecycle_runner", code: "owner_stop_settled" }]);
    const sent = await call(mcp, "send", {
      id: sandboxId,
      prompt: "must not resume",
    });
    expect(sent.text).toContain("sandbox_terminal");
    expect(boat.prompts).toHaveLength(0);
  });

  test("exec redacts the agent's credentials from the output", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const sandboxId = await seedPersistedBoat({ db, boat, people });
    boat.setExecOutput({ stdout: `CLAUDE_CODE_OAUTH_TOKEN=${SECRETS.orgClaude}\nok\n` });
    const ran = await call(mcp, "exec", { id: sandboxId, command: "env" });
    expect(ran.data).toMatchObject({ exitCode: 0, stdout: "CLAUDE_CODE_OAUTH_TOKEN=***\nok\n" });
    expectNoSecret(ran.text);
  });

  test("stop with turn interrupts the agent and leaves compute up", async () => {
    const { token, client, people, boat, db } = await start();
    const mcp = await client(await token(people.member));
    const id = await seedPersistedBoat({ db, boat, people }, { prompt: "work" });
    const interrupt = spyOn(boat.provider, "interrupt");
    const selected = await call(mcp, "stop", { id, turn: true, conversation_id: "selected-conversation" });
    expect(selected.isError).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    const stopped = await call(mcp, "stop", { id, turn: true });
    expect(stopped.data).toEqual({ id, interrupted: true });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(boat.stops).toEqual([]);
  });

  test("pending successful stop blocks workspace exec", async () => {
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
    const id = await seedPersistedBoat({ db, boat, people }, { prompt: "work" });
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
    const commands = boat.execs.length;
    expect((await call(mcp, "exec", { id, command: "touch after-capture" })).isError).toBe(true);
    expect(boat.execs).toHaveLength(commands);
    expect(preparations).toBe(prepared);
  });

  test("user stop leaves an unverified archive in worker custody without dispatching another stop", async () => {
    const server = await start();
    const { token, client, people, boat } = server;
    const mcp = await client(await token(people.member));
    const { id, machine: physical } = await seedRunningSandbox(server);
    const machine = boat.sandbox(physical.id);
    machine.info = { ...machine.info, state: "stopped", providerState: "archived", retainedSnapshot: "unconfirmed" };
    expect((await call(mcp, "stop", { id })).data.status).toBe("stopping");
    expect(boat.stops).toHaveLength(0);
  });

  test("stop without a provider timestamp retains observed compute time", async () => {
    const { token, client, people, boat, db, clock } = await start();
    const mcp = await client(await token(people.member));
    const sandboxId = await seedPersistedBoat({ db, boat, people });
    await db.query("update sandboxes set usage_running_since=$2::timestamptz - interval '12 seconds' where id=$1", [
      sandboxId,
      clock.now.toISOString(),
    ]);
    expect((await call(mcp, "stop", { id: sandboxId })).data).toMatchObject({
      status: "stopped",
    });
    expect(boat.stops).toEqual(["bx_1"]);
    const row = await db.query<{ status: string; stopped_at: Date | null; seconds: number | null }>(
      "select status::text as status, stopped_at, usage_runtime_seconds as seconds from sandboxes where id = $1",
      [sandboxId],
    );
    expect(row.rows[0]?.status).toBe("stopped");
    expect(row.rows[0]?.stopped_at?.toISOString()).toBe(clock.now.toISOString());
    expect(row.rows[0]?.seconds).toBe(12);
  });

  test("a member of another org sees none of this org's sandboxes", async () => {
    const { token, client, people, boat, db } = await start();
    const id = await seedPersistedBoat({ db, boat, people });
    const other = await client(await token(people.member, people.otherOrg));
    expect((await call(other, "list")).data.sandboxes).toEqual([]);
    expect((await call(other, "stop", { id })).isError).toBe(true);
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
