import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken } from "@armada/auth";
import { githubCallbackOperations, githubReposResponse } from "@armada/core/contract";
import { createSqlVaultStore, encryptSecret, type Sql } from "@armada/core/server";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createGitHubAccountApi } from "../src/github-account.ts";
import { useMigratedDatabase } from "./migrated-database.ts";

const { githubOAuthCallback, githubOAuthRelay } = githubCallbackOperations;

const auditEvents = captureGitHubAuditLogs();

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const key = Buffer.alloc(32, 7).toString("base64");
const bearer = (user: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`;

const database = useMigratedDatabase();

test("authenticated GitHub handoff binds owner, encrypts grants, rejects replay and disconnect cancels in-flight callback", async () => {
  const db = database();
  try {
    await db.query("insert into auth.users(id) values ($1),($2)", [owner, other]);
    const authStore = createMemoryAuthStore();
    let tokenExchanges = 0;
    let rejectExchange = false;
    let duringExchange: (() => Promise<void>) | undefined;
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        tokenExchanges++;
        expect(JSON.parse(String(init?.body)).redirect_uri).toBe("https://dashboard.test/github/callback");
        await duringExchange?.();
        if (rejectExchange) throw new Error("private upstream code/state failure detail");
        return Response.json({
          access_token: "ghu_test_ephemeral",
          refresh_token: "ghr_test_ephemeral",
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        });
      }
      if (url === "https://api.github.com/user") return Response.json({ id: 123, login: "octocat", name: "Octo" });
      if (url.includes("/user/installations"))
        return Response.json({
          installations: [
            {
              id: 42,
              app_id: 1,
              app_slug: "armada",
              account: { login: "team", type: "Organization" },
              repository_selection: "all",
            },
          ],
        });
      throw new Error("Unexpected upstream request.");
    }) as typeof fetch;
    const options: ControlOptions = {
      authStore,
      store: createSqlVaultStore(db),
      encryptionKey: key,
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "anon",
        fetch: async (_input, init) => {
          const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
          return Response.json({ id: token === bearer(other) ? other : owner });
        },
      },
      githubAccount: createGitHubAccountApi({
        sql: db,
        app: { clientId: "app-test", clientSecret: "app-test-secret" },
        dashboardUrl: "https://dashboard.test",
        encryptionKey: key,
        slug: "armada",
        fetch: upstream,
      }),
    };
    async function command(action: string, body = {}, user = owner) {
      const result = await handleControlRequest(
        new Request(`https://armada.test/api/v1/github/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer(user)}` },
          body: JSON.stringify(body),
        }),
        options,
      );
      if (!result) throw new Error("No route.");
      return result;
    }
    async function start(body = {}) {
      const response = await command("connect", body);
      expect(response.status).toBe(200);
      return (await response.json()) as { flowId: string; authorizationUrl: string };
    }
    async function relay(
      raw: string,
      contentType = "application/json",
      query = "",
      extraHeaders: Record<string, string> = {},
    ) {
      const result = await handleControlRequest(
        new Request(`https://armada.test/api/v1/github/oauth/callback${query}`, {
          method: "POST",
          headers: { "content-type": contentType, ...extraHeaders },
          body: raw,
        }),
        options,
      );
      if (!result) throw new Error("No callback route.");
      return result;
    }
    async function callback(authorizationUrl: string, method: "POST" | "GET" = "POST") {
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (method === "POST") return relay(JSON.stringify({ state, code: "one-use-test-code" }));
      const response = await handleControlRequest(
        new Request(`https://armada.test/api/v1/github/oauth/callback?state=${state}&code=one-use-test-code`),
        options,
      );
      if (!response) throw new Error("No callback route.");
      return response;
    }
    authStore.addMembership(owner, { orgId: other, name: "Scoped", role: "admin" });
    const delegated = await createServiceToken(authStore, { userId: owner, orgName: "Scoped", now: new Date() });
    const delegatedStatus = await handleControlRequest(
      new Request("https://armada.test/api/v1/github/status", {
        method: "POST",
        headers: { authorization: `Bearer ${delegated.token}` },
        body: "{}",
      }),
      options,
    );
    expect(delegatedStatus?.status).toBe(403);
    const started = await start({
      returnUrl: "https://untrusted.test/callback",
      redirectUri: "https://untrusted.test/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    expect(state).toMatch(/^armada_cli_[0-9a-f-]{72}$/);
    const pending = async () =>
      (await db.query<{ status: string }>("select status from github_authorizations where id = $1", [started.flowId]))
        .rows[0]?.status;
    const invalid = [
      JSON.stringify({ state, code: "test", returnUrl: "https://untrusted.test" }),
      `{"state":${JSON.stringify(state)},"state":${JSON.stringify(state)},"code":"test"}`,
      `{"state":${JSON.stringify(state)},"code":"test","code":"other"}`,
      `{"state":${JSON.stringify(state)},"\\u0073tate":${JSON.stringify(state)},"code":"test"}`,
      JSON.stringify({ state, code: "x".repeat(1025) }),
      JSON.stringify({ state: `${state}extra`, code: "test" }),
      JSON.stringify({ state: `normal_web_${state}`, code: "test" }),
      JSON.stringify({ state: `armada_cli_${"0".repeat(72)}`, code: "test" }),
      JSON.stringify({ state, code: "test" }).slice(0, -1),
      JSON.stringify({ state, code: "test" }) + " ".repeat(8192),
    ];
    for (const raw of invalid) {
      const response = await relay(raw);
      expect(response.status).toBe(400);
      expect(githubOAuthRelay.errorOutput.parse(await response.json())).toEqual({ ok: false, status: "failed" });
      expect(await pending()).toBe("pending");
    }
    expect((await relay(JSON.stringify({ state, code: "test" }), "text/plain")).status).toBe(400);
    expect((await relay(JSON.stringify({ state, code: "test" }), "application/json", `?state=${state}`)).status).toBe(
      400,
    );
    const duplicateGet = await handleControlRequest(
      new Request(`https://armada.test/api/v1/github/oauth/callback?state=${state}&state=${state}&code=test`),
      options,
    );
    expect(duplicateGet?.status).toBe(400);
    githubOAuthCallback.errorOutput.parse(await duplicateGet?.json());
    for (const length of ["999999", "1", "bad"])
      expect(
        (await relay(JSON.stringify({ state, code: "test" }), "application/json", "", { "content-length": length }))
          .status,
      ).toBe(400);
    const nonCliState = "normal_dashboard_cookie_state";
    const nonCliFlow = crypto.randomUUID();
    const stateHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonCliState)),
    ).toString("hex");
    await db.query(
      "insert into github_authorizations(id,user_id,state_hash,status,expires_at) values ($1,$2,$3,'pending',$4)",
      [nonCliFlow, owner, stateHash, new Date(Date.now() + 600_000)],
    );
    expect((await relay(JSON.stringify({ state: nonCliState, code: "test" }))).status).toBe(400);
    expect(
      (await db.query<{ status: string }>("select status from github_authorizations where id = $1", [nonCliFlow]))
        .rows[0]?.status,
    ).toBe("pending");
    expect(tokenExchanges).toBe(0);
    expect(await pending()).toBe("pending");
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://dashboard.test/github/callback",
    );
    expect((await command("status", { flowId: started.flowId }, other)).status).toBe(404);
    const completed = await callback(started.authorizationUrl);
    expect(completed.status).toBe(200);
    expect(auditEvents).toEqual([
      {
        event: "github_connection_replaced",
        caller: "account_callback",
        reason: "oauth_connect",
        ownerId: owner,
        accessTokenCached: true,
        accessExpiresAt: expect.any(String),
        observedRemainingLifetimeMs: expect.any(Number),
      },
    ]);
    expect(githubOAuthRelay.output.parse(await completed.json())).toEqual({ ok: true, status: "connected" });
    expect(completed.headers.get("location")).toBeNull();
    expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
    const status = await (await command("status", { flowId: started.flowId })).json();
    expect(status).toMatchObject({ flowStatus: "connected", connection: { status: "connected", login: "octocat" } });
    expect(JSON.stringify(status)).not.toContain("ghu_test");
    expect(JSON.stringify(status)).not.toContain("ghr_test");
    expect((await callback(started.authorizationUrl)).status).toBe(400);
    expect(tokenExchanges).toBe(1);
    const stored = (
      await db.query<{ encoded: string }>(
        "select encode(refresh_token_enc,'escape') as encoded from github_connections",
      )
    ).rows[0];
    expect(stored?.encoded).not.toContain("ghr_test_ephemeral");
    const expired = await start();
    await db.query("update github_authorizations set expires_at = $1 where id = $2", [new Date(0), expired.flowId]);
    const exchangesBeforeExpiry = tokenExchanges;
    expect((await callback(expired.authorizationUrl)).status).toBe(400);
    expect(tokenExchanges).toBe(exchangesBeforeExpiry);
    const superseded = await start();
    const replacement = await start();
    const exchangesBefore = tokenExchanges;
    expect((await callback(superseded.authorizationUrl)).status).toBe(400);
    expect(tokenExchanges).toBe(exchangesBefore);
    const priorEpoch = (
      await db.query<{ connection_epoch: string }>("select connection_epoch from github_connections where user_id=$1", [
        owner,
      ])
    ).rows[0]?.connection_epoch;
    const browserCallback = await callback(replacement.authorizationUrl, "GET");
    expect(browserCallback.status).toBe(200);
    githubOAuthCallback.output.parse(await browserCallback.json());
    const nextEpoch = (
      await db.query<{ connection_epoch: string }>("select connection_epoch from github_connections where user_id=$1", [
        owner,
      ])
    ).rows[0]?.connection_epoch;
    expect(nextEpoch).not.toBe(priorEpoch);
    expect((await command("disconnect")).status).toBe(200);
    expect(auditEvents.at(-1)).toEqual({
      event: "github_connection_disconnected",
      caller: "account_disconnect",
      ownerId: owner,
      reason: "user_disconnect",
    });
    const racing = await start();
    duringExchange = async () => {
      expect((await command("disconnect")).status).toBe(200);
    };
    expect((await callback(racing.authorizationUrl)).status).toBe(400);
    expect((await db.query("select user_id from github_connections")).rows).toEqual([]);
    duringExchange = undefined;
    rejectExchange = true;
    const refused = await start();
    const refusal = await callback(refused.authorizationUrl);
    expect(refusal.status).toBe(400);
    expect(await refusal.json()).toEqual({ ok: false, status: "failed" });
    const defaultAccountApi = createGitHubAccountApi({
      sql: db,
      app: { clientId: "app-test", clientSecret: "app-test-secret" },
      encryptionKey: key,
    });
    const defaultStarted = await handleControlRequest(
      new Request("https://armada.test/api/v1/github/connect", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer(owner)}` },
        body: JSON.stringify({ redirectUri: "https://untrusted.test" }),
      }),
      { ...options, githubAccount: defaultAccountApi },
    );
    const defaultFlow = (await defaultStarted?.json()) as { authorizationUrl: string };
    expect(new URL(defaultFlow.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://armada.thevibecompany.co/github/callback",
    );
    await db.exec("set role authenticated");
    await expect(db.query("select state_hash from github_authorizations")).rejects.toThrow();
  } finally {
    await db.exec("reset role");
  }
});

const instFixture = (id: number, login: string, selection = "all", appId = 1, appSlug = "armada") => ({
  id,
  app_id: appId,
  app_slug: appSlug,
  account: { login, type: "Organization" as const },
  repository_selection: selection,
});
const storedFixture = (id: number, account: string) => ({
  id,
  app_id: 1,
  app_slug: "armada",
  account,
  account_type: "Organization",
  repository_selection: "all",
});
const repoFixture = (id: number, ownerLogin: string, name: string, archived = false) => ({
  id,
  name,
  owner: { login: ownerLogin },
  private: true,
  default_branch: "main",
  archived,
  pushed_at: archived ? null : "2026-11-27T12:00:00Z",
});

async function resetAndSeedConnection(db: ReturnType<typeof database>, now: Date, installations: unknown[] = []) {
  await db.query("insert into auth.users(id) values ($1),($2) on conflict do nothing", [owner, other]);
  await db.query("delete from public.github_authorizations");
  await db.query("delete from public.github_connections");
  const accessEnc = await encryptSecret("ghu_test_cached", key);
  const refreshEnc = await encryptSecret("ghr_test_cached", key);
  await db.query(
    `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,refresh_expires_at,access_token_enc,access_expires_at,installations)
     values ($1,123,'octocat','Octo',$2,$3,$4,$5,$6::jsonb)`,
    [
      owner,
      refreshEnc,
      new Date(now.getTime() + 86_400_000),
      accessEnc,
      new Date(now.getTime() + 3_600_000),
      JSON.stringify(installations),
    ],
  );
}

function makeAccountOptions(
  db: ReturnType<typeof database>,
  upstream: typeof fetch,
  overrides: {
    sql?: Sql;
    app?: Parameters<typeof createGitHubAccountApi>[0]["app"];
    slug?: string | undefined;
    appId?: string | number | undefined;
    now?: () => Date;
  } = {},
  authStore = createMemoryAuthStore(),
) {
  const slug = "slug" in overrides ? overrides.slug : "armada";
  const appId = "appId" in overrides ? overrides.appId : "1";
  return {
    authStore,
    store: createSqlVaultStore(db),
    encryptionKey: key,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      fetch: async (_input, init) => {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        return Response.json({ id: token === bearer(other) ? other : owner });
      },
    },
    githubAccount: createGitHubAccountApi({
      sql: overrides.sql ?? db,
      app: "app" in overrides ? (overrides.app ?? null) : { clientId: "app-test", clientSecret: "app-test-secret" },
      dashboardUrl: "https://dashboard.test",
      encryptionKey: key,
      ...(slug !== undefined ? { slug } : {}),
      ...(appId !== undefined ? { appId } : {}),
      ...(overrides.now ? { now: overrides.now } : {}),
      fetch: upstream,
    }),
  } satisfies ControlOptions;
}

const postControl = (
  path: string,
  options: ControlOptions,
  body: Record<string, unknown> = {},
  authHeader?: string,
  signal?: AbortSignal,
) =>
  handleControlRequest(
    new Request(`https://armada.test/api/v1/${path}`, {
      method: "POST",
      headers: authHeader ? { authorization: authHeader } : {},
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
    options,
  );

test("github/status persists refreshed multi-org installations without rotating connection_epoch and tolerates failures", async () => {
  const db = database();
  const now = new Date("2026-11-27T16:00:00Z");
  await resetAndSeedConnection(db, now, [storedFixture(10, "org-alpha")]);
  const readRow = async () =>
    (
      await db.query<{ connection_epoch: string; installations: { id: number; account: string }[] }>(
        "select connection_epoch, installations from github_connections where user_id=$1",
        [owner],
      )
    ).rows[0]!;
  const initialEpoch = (await readRow()).connection_epoch;
  let mode: "multi" | "empty" | "fail" | "race" = "multi";
  const upstream = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://api.github.com/user") return Response.json({ id: 123, login: "octocat", name: "Octo" });
    if (!url.includes("/user/installations")) throw new Error(`Unexpected URL: ${url}`);
    if (mode === "fail") return new Response("upstream secret detail", { status: 500 });
    if (mode === "empty") return Response.json({ installations: [] });
    if (mode === "race") {
      await db.query(
        "update public.github_connections set connection_epoch = gen_random_uuid(), installations = $2::jsonb where user_id = $1",
        [owner, JSON.stringify([storedFixture(99, "reconnected-org")])],
      );
      return Response.json({ installations: [instFixture(10, "stale-org")] });
    }
    return Response.json({
      installations: [
        instFixture(10, "org-alpha"),
        instFixture(20, "org-beta", "selected"),
        instFixture(30, "acme_emu"),
        instFixture(40, "foreign-org", "all", 999, "other-app"),
      ],
    });
  }) as typeof fetch;
  const options = makeAccountOptions(db, upstream, { now: () => now });
  const callStatus = (opts = options) => postControl("github/status", opts, {}, `Bearer ${bearer(owner)}`);

  const multiRes = await callStatus();
  expect(multiRes?.status).toBe(200);
  expect(multiRes?.headers.get("cache-control")).toBe("no-store");
  const multiBody = (await multiRes?.json()) as {
    connection: { status: string; installations: { account: string }[] };
  };
  expect(multiBody.connection.status).toBe("connected");
  expect(multiBody.connection.installations.map((i) => i.account)).toEqual(["org-alpha", "org-beta", "acme_emu"]);
  expect((await readRow()).connection_epoch).toBe(initialEpoch);
  expect((await readRow()).installations.map((i) => i.account)).toEqual(["org-alpha", "org-beta", "acme_emu"]);

  mode = "fail";
  const failBody = (await (await callStatus())?.json()) as {
    connection: { status: string; installations: { account: string }[] };
  };
  expect(failBody.connection.status).toBe("unavailable");
  expect(failBody.connection.installations.map((i) => i.account)).toEqual(["org-alpha", "org-beta", "acme_emu"]);
  expect((await readRow()).installations.map((i) => i.account)).toEqual(["org-alpha", "org-beta", "acme_emu"]);
  expect((await readRow()).connection_epoch).toBe(initialEpoch);

  mode = "empty";
  expect(await (await callStatus())?.json()).toMatchObject({ connection: { status: "connected", installations: [] } });
  expect((await readRow()).installations).toEqual([]);
  expect((await readRow()).connection_epoch).toBe(initialEpoch);

  mode = "multi";
  const failingSql: Sql = {
    query: (text, params) => db.query(text, params),
    transaction: async () => {
      throw new Error("synthetic persist error");
    },
  };
  const degradedRes = await callStatus(makeAccountOptions(db, upstream, { sql: failingSql, now: () => now }));
  expect(degradedRes?.status).toBe(200);
  expect(await degradedRes?.json()).toMatchObject({
    connection: { status: "connected", installations: expect.arrayContaining([expect.objectContaining({ id: 20 })]) },
  });

  mode = "race";
  expect((await callStatus())?.status).toBe(200);
  expect((await readRow()).installations.map((i) => i.account)).toEqual(["reconnected-org"]);
});

test("github/repos lists multi-org repos with filters, enforces auth/validation, and maps failure states", async () => {
  const db = database();
  const now = new Date("2026-11-27T16:00:00Z");
  await resetAndSeedConnection(db, now);
  const authStore = createMemoryAuthStore();
  authStore.addMembership(owner, { orgId: other, name: "Scoped", role: "admin" });
  let upstreamCalls = 0;
  let failRepos = false;
  let seenSignal: AbortSignal | undefined;
  const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
    upstreamCalls++;
    seenSignal = init?.signal ?? undefined;
    const url = String(input);
    if (url === "https://api.github.com/user") return Response.json({ id: 123, login: "octocat", name: "Octo" });
    if (url.startsWith("https://api.github.com/user/installations?")) {
      return Response.json({
        installations: [
          instFixture(10, "org-alpha"),
          instFixture(20, "org-beta", "selected"),
          instFixture(30, "acme_emu"),
          instFixture(40, "ignored-org", "all", 2, "other-app"),
        ],
      });
    }
    if (failRepos) return new Response("secret upstream error body", { status: 502 });
    if (url.includes("/10/repositories"))
      return Response.json({ repositories: [repoFixture(101, "org-alpha", "api-core")] });
    if (url.includes("/20/repositories")) {
      return Response.json({
        repositories: [repoFixture(201, "org-beta", "web-app"), repoFixture(202, "org-beta", "api-gateway", true)],
      });
    }
    if (url.includes("/30/repositories"))
      return Response.json({ repositories: [repoFixture(301, "acme_emu", "emu-service")] });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  const options = makeAccountOptions(db, upstream, { appId: 1, now: () => now }, authStore);
  const callRepos = (body: Record<string, unknown>, authHeader?: string, signal?: AbortSignal, opts = options) =>
    postControl("github/repos", opts, body, authHeader, signal);

  expect((await callRepos({}))?.status).toBe(401);
  const service = await createServiceToken(authStore, { userId: owner, orgName: "Scoped", now });
  expect((await callRepos({}, `Bearer ${service.token}`))?.status).toBe(403);

  upstreamCalls = 0;
  for (const invalid of [{ account: "bad/org" }, { limit: 0 }, { limit: 501 }, { unknown: true }]) {
    const res = await callRepos(invalid, `Bearer ${bearer(owner)}`);
    expect(res?.status).toBe(400);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(await res?.json()).toMatchObject({ error: { code: "invalid" } });
  }
  expect(upstreamCalls).toBe(0);

  const allRes = await callRepos({}, `Bearer ${bearer(owner)}`);
  expect(allRes?.status).toBe(200);
  expect(allRes?.headers.get("cache-control")).toBe("no-store");
  const all = githubReposResponse.parse(await allRes?.json());
  expect(seenSignal).toBeInstanceOf(AbortSignal);
  expect(all.installations.map((i) => i.accountLogin)).toEqual(["org-alpha", "org-beta", "acme_emu"]);
  expect(all.repositories.map((r) => r.fullName)).toEqual([
    "acme_emu/emu-service",
    "org-alpha/api-core",
    "org-beta/api-gateway",
    "org-beta/web-app",
  ]);
  expect(all.truncated).toBe(false);
  expect(JSON.stringify(all)).not.toContain("ghu_test");
  expect(JSON.stringify(all)).not.toContain("ghr_test");

  const orgData = githubReposResponse.parse(
    await (await callRepos({ account: "ORG-BETA" }, `Bearer ${bearer(owner)}`))?.json(),
  );
  expect(orgData.installations).toHaveLength(3);
  expect(orgData.repositories.map((r) => r.fullName)).toEqual(["org-beta/api-gateway", "org-beta/web-app"]);

  const queryData = githubReposResponse.parse(
    await (await callRepos({ query: "api", limit: 1 }, `Bearer ${bearer(owner)}`))?.json(),
  );
  expect(queryData.repositories.map((r) => r.fullName)).toEqual(["org-alpha/api-core"]);
  expect(queryData.truncated).toBe(true);
  expect(
    githubReposResponse.parse(await (await callRepos({ account: "missing-org" }, `Bearer ${bearer(owner)}`))?.json()),
  ).toMatchObject({ repositories: [], truncated: false });

  expect((await callRepos({}, `Bearer ${bearer(other)}`))?.status).toBe(403);
  failRepos = true;
  const outage = await callRepos({}, `Bearer ${bearer(owner)}`);
  expect(outage?.status).toBe(503);
  const outageBody = await outage?.json();
  expect(outageBody).toMatchObject({ error: { code: "dependency_unavailable" } });
  expect(JSON.stringify(outageBody)).not.toContain("secret upstream error body");
  failRepos = false;

  const aborted = new AbortController();
  aborted.abort(new DOMException("Timed out", "TimeoutError"));
  expect((await callRepos({}, `Bearer ${bearer(owner)}`, aborted.signal))?.status).toBe(503);
  expect(
    (
      await callRepos(
        {},
        `Bearer ${bearer(owner)}`,
        undefined,
        makeAccountOptions(db, upstream, { app: null, now: () => now }),
      )
    )?.status,
  ).toBe(503);

  await db.query("update public.github_connections set revoked_at = now() where user_id = $1", [owner]);
  expect((await callRepos({}, `Bearer ${bearer(owner)}`))?.status).toBe(403);
});

test("github/install issues stateful CLI install URL, completes via callback, and requires GITHUB_APP_SLUG", async () => {
  const db = database();
  await db.query("insert into auth.users(id) values ($1) on conflict do nothing", [owner]);
  await db.query("delete from public.github_authorizations");
  await db.query("delete from public.github_connections");
  const upstream = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "ghu_test_install",
        refresh_token: "ghr_test_install",
        expires_in: 28800,
        refresh_token_expires_in: 15811200,
      });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 123, login: "octocat", name: "Octo" });
    if (url.includes("/user/installations")) {
      return Response.json({ installations: [instFixture(10, "org-alpha"), instFixture(20, "org-beta", "selected")] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  const options = makeAccountOptions(db, upstream, { slug: " armada ", appId: undefined });
  const installRes = await postControl("github/install", options, {}, `Bearer ${bearer(owner)}`);
  expect(installRes?.status).toBe(200);
  const started = (await installRes?.json()) as { flowId: string; authorizationUrl: string };
  expect(started.flowId).toMatch(/^[0-9a-f-]{36}$/);
  const parsedUrl = new URL(started.authorizationUrl);
  expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe("https://github.com/apps/armada/installations/new");
  const state = parsedUrl.searchParams.get("state");
  expect(state).toMatch(/^armada_cli_[0-9a-f-]{72}$/);

  const statusWithFlow = () =>
    postControl("github/status", options, { flowId: started.flowId }, `Bearer ${bearer(owner)}`);
  expect(await (await statusWithFlow())?.json()).toMatchObject({ flowStatus: "pending" });

  const relayed = await handleControlRequest(
    new Request("https://armada.test/api/v1/github/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, code: "install-code-1" }),
    }),
    options,
  );
  expect(relayed?.status).toBe(200);
  expect(githubOAuthRelay.output.parse(await relayed?.json())).toEqual({ ok: true, status: "connected" });
  expect(await (await statusWithFlow())?.json()).toMatchObject({
    flowStatus: "connected",
    connection: {
      status: "connected",
      installations: [
        expect.objectContaining({ id: 10, account: "org-alpha" }),
        expect.objectContaining({ id: 20, account: "org-beta" }),
      ],
    },
  });

  const missingSlug = await postControl(
    "github/install",
    makeAccountOptions(db, upstream, { slug: undefined }),
    {},
    `Bearer ${bearer(owner)}`,
  );
  expect(missingSlug?.status).toBe(503);
  expect(await missingSlug?.json()).toMatchObject({ error: { code: "dependency_unavailable" } });
});
