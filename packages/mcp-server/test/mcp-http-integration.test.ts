import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore, generateToken, sha256Hex } from "@armada/auth";
import type { McpConnectionDto } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { endpoint } from "../../mcp-gateway/src/index.ts";
import { configFromEnv } from "../src/config.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpOAuthStore, createMcpSecretBox } from "../src/mcp-integration.ts";

test("HTTP connection control keeps credentials private, scopes organizations, and refuses service-token callbacks", async () => {
  const db = await openDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    await applyMigrations(db);
    const user = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'MCP HTTP')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    const authStore = createSqlAuthStore(db);
    const { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    const secondOrg = crypto.randomUUID();
    await db.query("insert into public.orgs(id,name) values($1,'Second MCP org')", [secondOrg]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [secondOrg, user]);
    const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    integration = createMcpHttpIntegration({
      sql: db,
      encryptionKey,
      dashboardUrl: "https://dashboard.example",
      publicUrl: "https://armada.example",
      authStore,
      supabase: { supabaseUrl: "https://supabase.example", anonKey: "public-anon" },
    });
    const route = integration.route;
    const post = async (action: string, body: unknown, bearer = token) => {
      const response = await route(
        new Request(`https://armada.example/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (!response) throw Error("Route missing");
      return {
        status: response.status,
        body: (await response.json()) as { connection: McpConnectionDto; connections: McpConnectionDto[]; ok: boolean },
      };
    };
    const catalog = await post("catalog", { org });
    expect(catalog.status).toBe(200);
    expect(
      (catalog.body as unknown as { services: { id: string; availability: string }[] }).services.find(
        (s) => s.id === "slack",
      )?.availability,
    ).toBe("setup_required");
    const preset = await post("create", {
      org,
      serviceId: "linear",
      name: "Work",
      scope: "personal",
      url: "https://untrusted.example",
    });
    expect(preset.body.connection.url).toBe("https://mcp.linear.app/mcp");
    const beforeMetadata = (
      await db.query("select * from mcp_grants where connection_id=$1", [preset.body.connection.id])
    ).rows;
    const renamed = await post("metadata", {
      org,
      id: preset.body.connection.id,
      name: "Work renamed",
      defaultForLaunch: true,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection).toMatchObject({
      id: preset.body.connection.id,
      name: "Work renamed",
      defaultForLaunch: true,
      catalogId: "linear",
    });
    expect(
      (await db.query("select * from mcp_grants where connection_id=$1", [preset.body.connection.id])).rows,
    ).toEqual(beforeMetadata);
    expect((await post("metadata", { org: secondOrg, id: preset.body.connection.id, name: "Wrong org" })).status).toBe(
      403,
    );
    expect((await post("delete", { org, id: preset.body.connection.id })).status).toBe(200);
    const secret = crypto.randomUUID();
    const created = await post("create", {
      org: org,
      name: "Private endpoint",
      scope: "personal",
      transport: "http",
      url: "https://example.com/mcp?region=eu",
      authType: "bearer",
      authentication: secret,
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(created.body.connection.status).toBe("not_connected");
    const list = await post("list", { org: org });
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0]?.url).toBe("https://example.com/mcp?region=eu");
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect((await post("list", { org: secondOrg })).status).toBe(403);
    const mcp = generateToken("access");
    await authStore.insertToken("mcp", {
      userId: user,
      orgId: org,
      hash: await sha256Hex(mcp),
      label: "access",
      createdAt: new Date().toISOString(),
    });
    const oauthStore = createMcpOAuthStore(db, encryptionKey),
      box = createMcpSecretBox(encryptionKey);
    const state = crypto.randomUUID(),
      stateHash = await sha256Hex(state);
    await oauthStore.putPending(stateHash, {
      actorId: user,
      connectionId: created.body.connection.id,
      expiresAt: Date.now() + 60000,
      sealed: await box.seal(JSON.stringify({ generation: await oauthStore.generation(created.body.connection.id) })),
    });
    for (const bearer of [token, mcp]) {
      expect((await post("oauth/callback", { org: secondOrg, state, code: crypto.randomUUID() }, bearer)).status).toBe(
        403,
      );
    }
    expect(await oauthStore.takePending(stateHash, user, Date.now())).not.toBeNull();
    expect(await route(new Request("https://armada.example/api/control/mcp/list", { method: "POST" }))).toBeNull();
    const metadata = await route(new Request("https://armada.example/.well-known/armada-mcp-client.json"));
    if (!metadata) throw Error("Metadata missing");
    expect(((await metadata.json()) as { redirect_uris: string[] }).redirect_uris).toEqual([
      "https://dashboard.example/auth/mcp/callback",
    ]);
    expect(
      (
        await route(
          new Request(`https://armada.example/mcp/gateway/${created.body.connection.id}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      )?.status,
    ).toBe(403);
    expect((await post("update", { org, id: created.body.connection.id, name: "partial update" })).status).toBe(400);
    const replacement = {
      org,
      id: created.body.connection.id,
      name: "Replaced definition",
      scope: "personal",
      transport: "http",
      url: "https://example.com/mcp?region=eu",
      authType: "bearer",
    };
    expect((await post("update", { ...replacement, scope: "org" })).status).toBe(400);
    expect((await post("update", replacement)).body.connection.status).toBe("not_connected");
    expect(
      (
        await db.query<{ value_enc: Uint8Array | null }>(
          "select value_enc from public.mcp_grants where connection_id=$1",
          [created.body.connection.id],
        )
      ).rows[0]?.value_enc,
    ).toBeNull();
    expect(
      (await post("set-enabled", { org: org, id: created.body.connection.id, enabled: false })).body.connection.status,
    ).toBe("disabled");
    const revoked = await post("revoke", { org: org, id: created.body.connection.id });
    expect(revoked.body.ok).toBe(true);
  } finally {
    await integration?.close();
    await db.close();
  }
});

test("actual MCP integration construction preserves explicitly configured development dashboard callback origin", async () => {
  const db = await openDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    await applyMigrations(db);
    const config = configFromEnv({
      NODE_ENV: "development",
      ARMADA_DATABASE_URL: "postgres://fixture",
      SUPABASE_URL: "https://auth.example",
      SUPABASE_ANON_KEY: "public",
      ARMADA_AUTH_SECRET: "fixture-auth-secret-long-enough",
      ARMADA_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      ARMADA_PUBLIC_URL: "https://gateway.example",
      ARMADA_DASHBOARD_URL: "http://localhost:3000",
    });
    const options = {
      sql: db,
      authStore: createSqlAuthStore(db),
      encryptionKey: config.encryptionKey,
      publicUrl: config.publicUrl,
      dashboardUrl: config.dashboardUrl,
      supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    };
    expect(() => createMcpHttpIntegration(options)).toThrow("ARMADA_DASHBOARD_URL");
    integration = createMcpHttpIntegration({ ...options, development: config.development });
    const response = await integration.route(new Request("https://gateway.example/.well-known/armada-mcp-client.json"));
    expect(response?.status).toBe(200);
    if (!response) throw Error("Missing client metadata route");
    expect(((await response.json()) as { redirect_uris: string[] }).redirect_uris).toEqual([
      "http://localhost:3000/auth/mcp/callback",
    ]);
    expect(() => endpoint("http://localhost:3000/upstream")).toThrow();
  } finally {
    await integration?.close();
    await db.close();
  }
});
