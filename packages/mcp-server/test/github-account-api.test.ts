import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken } from "@armada/auth";
import { createSqlVaultStore } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createGitHubAccountApi } from "../src/github-account.ts";

const auditEvents = captureGitHubAuditLogs();

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const key = Buffer.alloc(32, 7).toString("base64");
const bearer = (user: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`;

test("authenticated GitHub handoff binds owner, encrypts grants, rejects replay and disconnect cancels in-flight callback", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values ($1),($2)", [owner, other]);
    const authStore = createMemoryAuthStore();
    let logoutCalls = 0;
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
        fetch: async (input, init) => {
          if (String(input).includes("/auth/v1/logout")) {
            logoutCalls++;
            return new Response(null, { status: 204 });
          }
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
      expect(await response.json()).toEqual({ ok: false, status: "failed" });
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
    expect(await completed.json()).toEqual({ ok: true, status: "connected" });
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
    expect((await callback(replacement.authorizationUrl, "GET")).status).toBe(200);
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
    const signedOut = await handleControlRequest(
      new Request("https://armada.test/api/v1/account/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer(owner)}` },
        body: "{}",
      }),
      options,
    );
    expect(signedOut?.status).toBe(200);
    expect(logoutCalls).toBe(1);
    await db.exec("set role authenticated");
    await expect(db.query("select state_hash from github_authorizations")).rejects.toThrow();
  } finally {
    await db.close();
  }
});
