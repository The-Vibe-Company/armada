import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import {
  createSqlVaultStore,
  decryptSecret,
  encryptSecret,
  type McpConnectionDto,
  type Sql,
} from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { catalogAuthenticationFromEnv, SLACK_OAUTH_BINDING } from "../src/mcp-catalog-client.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { migratedDatabase } from "./migrated-database.ts";

const callback = "https://dashboard.example/auth/mcp/callback";
const registration = () => ({
  client_id: "123.456",
  client_secret: crypto.randomUUID(),
  issuer: SLACK_OAUTH_BINDING.issuer,
  resource: SLACK_OAUTH_BINDING.resource,
  redirect_uris: [callback],
  token_endpoint_auth_method: "client_secret_post",
  scope: "channels:read users:read",
});

test("registered Slack catalog uses confidential OAuth without DCR and isolates two named account grants", async () => {
  const db = await migratedDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const user = crypto.randomUUID(),
      other = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [user, other]);
    await db.query("insert into orgs(id,name) values($1,'Slack test')", [org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member')", [
      org,
      user,
      other,
    ]);
    const authStore = createSqlAuthStore(db);
    const { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const client = registration();
    const catalogAuthentication = catalogAuthenticationFromEnv(
      { ARMADA_SLACK_MCP_CLIENT_ENC: Buffer.from(await encryptSecret(JSON.stringify(client), key)).toString("base64") },
      key,
      "https://dashboard.example",
    );
    let demoteBeforeLiveRoleCheck = false;
    let demotions = 0;
    const sql: Sql = {
      async query<T>(statement: string, params?: unknown[]) {
        if (demoteBeforeLiveRoleCheck && statement.startsWith("select 1 from public.members")) {
          demoteBeforeLiveRoleCheck = false;
          demotions++;
          await db.query("update members set role='member' where org_id=$1 and user_id=$2", [org, user]);
        }
        return db.query<T>(statement, params);
      },
    };
    let signedIn = user;
    const supabase = {
      supabaseUrl: "https://auth.example",
      anonKey: "public",
      fetch: async () => Response.json({ id: signedIn }),
    };
    const tokens = new Map<string, string>();
    let tokenCalls = 0;
    let maliciousTokenEndpoint = false;
    let unavailableMetadata = false;
    const network = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.href === "https://mcp.slack.com/.well-known/oauth-protected-resource")
        return Response.json({
          resource: SLACK_OAUTH_BINDING.resource,
          authorization_servers: [SLACK_OAUTH_BINDING.issuer],
        });
      if (url.href === "https://mcp.slack.com/.well-known/oauth-authorization-server") {
        if (unavailableMetadata) return new Response(null, { status: 503 });
        return Response.json({
          issuer: SLACK_OAUTH_BINDING.issuer,
          authorization_endpoint: SLACK_OAUTH_BINDING.authorizationEndpoint,
          token_endpoint: maliciousTokenEndpoint
            ? "https://untrusted.example/token"
            : SLACK_OAUTH_BINDING.tokenEndpoint,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          scopes_supported: ["channels:read", "users:read"],
        });
      }
      if (url.href === SLACK_OAUTH_BINDING.tokenEndpoint) {
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_id")).toBe(client.client_id);
        expect(body.get("client_secret")).toBe(client.client_secret);
        expect(request.headers.has("authorization")).toBe(false);
        expect(body.get("resource")).toBe(SLACK_OAUTH_BINDING.resource);
        if (body.get("grant_type") === "authorization_code") {
          expect(body.get("redirect_uri")).toBe(callback);
          expect(body.get("code_verifier")!.length).toBeGreaterThan(40);
        } else expect(body.get("refresh_token")).toBe("refresh-second");
        tokenCalls++;
        const code = body.get("code") ?? "second";
        const access = crypto.randomUUID();
        tokens.set(access, code);
        return Response.json({
          ok: true,
          token_type: "user",
          access_token: access,
          ...(code === "second" ? { expires_in: 3600, refresh_token: "refresh-second" } : {}),
          scope: "channels:read,users:read",
        });
      }
      if (url.href === SLACK_OAUTH_BINDING.endpoint) {
        if (!request.headers.has("authorization"))
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
            },
          });
        expect(tokens.has(request.headers.get("authorization")!.slice(7))).toBe(true);
        const body = (await request.json()) as { id: number; method: string };
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "slack", version: "1" } }
            : {};
        if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      throw Error("Unexpected network request; DCR and unpinned destinations forbidden");
    }) as typeof fetch;
    integration = createMcpHttpIntegration({
      sql,
      encryptionKey: key,
      catalogAuthentication,
      dashboardUrl: "https://dashboard.example",
      publicUrl: "https://armada.example",
      authStore,
      supabase,
      fetch: network,
    });
    const options = {
      authStore,
      supabase,
      encryptionKey: key,
      store: createSqlVaultStore(db),
      mcp: { registry: integration.registry, broker: integration.controlBroker },
    };
    const post = async (action: string, body: Record<string, unknown>, control = false, browser = false) => {
      const request = new Request(`https://armada.example/api/v1/mcp/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${browser ? "eyJhbGciOiJIUzI1NiJ9.e30.sig" : token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ org, ...body }),
      });
      const response = await (control ? handleControlRequest(request, options) : integration!.route(request));
      if (!response) throw Error("Missing route");
      return {
        status: response.status,
        body: (await response.json()) as {
          services: { id: string; availability: string }[];
          connection: McpConnectionDto;
          authorizationUrl: string;
        },
      };
    };
    for (const control of [false, true])
      expect((await post("catalog", {}, control)).body.services.find((s) => s.id === "slack")?.availability).toBe(
        "available",
      );
    const first = await post("create", {
      serviceId: "slack",
      name: "First",
      scope: "personal",
      url: "https://untrusted.example",
      authentication: "untrusted",
    });
    const second = await post("create", { serviceId: "slack", name: "Second", scope: "personal" }, true);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.connection.url).toBe(SLACK_OAUTH_BINDING.endpoint);
    expect(first.body.connection.id).not.toBe(second.body.connection.id);
    const starts = await Promise.all([
      post("connect", { id: first.body.connection.id }),
      post("connect", { id: second.body.connection.id }, true),
    ]);
    const states = starts.map((start) => {
      expect(start.status).toBe(200);
      const url = new URL(start.body.authorizationUrl);
      expect(url.origin + url.pathname).toBe(SLACK_OAUTH_BINDING.authorizationEndpoint);
      expect(url.searchParams.get("redirect_uri")).toBe(callback);
      expect(url.searchParams.get("resource")).toBe(SLACK_OAUTH_BINDING.resource);
      expect(url.searchParams.get("scope")).toBe(client.scope);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      return url.searchParams.get("state")!;
    });
    expect(states[0]).not.toBe(states[1]);
    signedIn = other;
    expect((await post("oauth/callback", { state: states[0], code: "first" }, false, true)).status).not.toBe(200);
    expect(tokenCalls).toBe(0);
    signedIn = user;
    // Complete in reverse order: account identity must follow UUID/state, not catalog ID.
    expect((await post("oauth/callback", { state: states[1], code: "second" }, true, true)).status).toBe(200);
    expect((await post("oauth/callback", { state: states[0], code: "first" }, false, true)).status).toBe(200);
    expect((await post("oauth/callback", { state: states[0], code: "replay" }, false, true)).status).not.toBe(200);
    expect((await post("oauth/callback", { state: states[1], code: "replay" }, true, true)).status).toBe(403);
    expect(tokenCalls).toBe(2);
    for (const [created, code] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      const grant = (
        await db.query<{ value_enc: Uint8Array<ArrayBuffer> }>(
          "select value_enc from mcp_grants where connection_id=$1",
          [created.body.connection.id],
        )
      ).rows[0]!;
      const stored = JSON.parse(await decryptSecret(grant.value_enc, key));
      expect(tokens.get(stored.tokens.access_token)).toBe(code);
      expect(stored.client.client_secret).toBe(client.client_secret);
      expect(stored.resource).toBe(SLACK_OAUTH_BINDING.resource);
      expect(Buffer.from(grant.value_enc).toString()).not.toContain(client.client_secret);
      expect(JSON.stringify(created.body)).not.toContain(client.client_secret);
    }
    const rotating = (
      await db.query<{ value_enc: Uint8Array<ArrayBuffer> }>(
        "select value_enc from mcp_grants where connection_id=$1",
        [second.body.connection.id],
      )
    ).rows[0]!;
    const expired = JSON.parse(await decryptSecret(rotating.value_enc, key));
    expired.expiresAt = 0;
    await db.query("update mcp_grants set value_enc=$2 where connection_id=$1", [
      second.body.connection.id,
      await encryptSecret(JSON.stringify(expired), key),
    ]);
    expect(
      tokens.get(await integration.broker.access(user, second.body.connection.id, SLACK_OAUTH_BINDING.endpoint)),
    ).toBe("second");
    expect(tokenCalls).toBe(3);
    maliciousTokenEndpoint = true;
    expect((await post("connect", { id: second.body.connection.id })).status).toBe(400);
    expect((await post("connect", { id: second.body.connection.id }, true)).status).toBe(400);
    expect(tokenCalls).toBe(3);
    maliciousTokenEndpoint = false;
    unavailableMetadata = true;
    expect((await post("connect", { id: second.body.connection.id }, true)).status).toBe(502);
    expect((await post("connect", { id: second.body.connection.id })).status).toBe(502);
    unavailableMetadata = false;
    await post("revoke", { id: first.body.connection.id });
    expect((await post("connect", { id: first.body.connection.id }, true)).status).toBe(200);
    const shared = await post("create", { serviceId: "slack", name: "Shared", scope: "org" });
    expect(shared.status).toBe(200);
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [org, other]);
    // A committed demotion after route authorization must still be a typed refusal on both surfaces.
    for (const control of [true, false]) {
      await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [org, user]);
      demoteBeforeLiveRoleCheck = true;
      expect((await post("connect", { id: shared.body.connection.id }, control)).status).toBe(403);
    }
    expect(demotions).toBe(2);
  } finally {
    await integration?.close();
    await db.close();
  }
});

test("encrypted Slack deployment registration rejects invalid binding, callback, authentication and scopes without echoing secrets", async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  expect(await catalogAuthenticationFromEnv({}, key, "https://dashboard.example")("slack")).toBeUndefined();
  const client = registration();
  for (const override of [
    { issuer: "https://untrusted.example" },
    { resource: SLACK_OAUTH_BINDING.endpoint },
    { redirect_uris: ["https://untrusted.example/callback"] },
    { token_endpoint_auth_method: "none" },
    { scope: "admin" },
  ]) {
    const sealed = Buffer.from(await encryptSecret(JSON.stringify({ ...client, ...override }), key)).toString("base64");
    const resolve = catalogAuthenticationFromEnv(
      { ARMADA_SLACK_MCP_CLIENT_ENC: sealed },
      key,
      "https://dashboard.example",
    );
    const error = await resolve("slack").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(client.client_secret);
    expect(error.message).toContain("deployment configuration");
  }
});
