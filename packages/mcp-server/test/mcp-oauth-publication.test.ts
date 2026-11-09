import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpSecretBox } from "../src/mcp-integration.ts";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: () => finish() };
}
const cases = [
  "none",
  "demote",
  "remove",
  "demote_readd",
  "remove_readd",
  "revoke",
  "supersede",
  "callback_cancel",
  "refresh_cancel",
] as const;

// The real HTTP callback is suspended inside its upstream token POST, AFTER atomic state take.
// Current-role-only checks cannot pass remove/readd: publication must carry the durable epoch.
for (const change of cases)
  test(`OAuth callback publication fences ${change} while token exchange is in flight`, async () => {
    const db = await openDatabase();
    const started = deferred(),
      release = deferred(),
      refreshStarted = deferred(),
      refreshRelease = deferred();
    let tokenAborted = false,
      refreshAborted = false,
      refreshCalls = 0;
    const refreshToken = crypto.randomUUID(),
      controller = new AbortController();
    const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const servers: McpServer[] = [];
    const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
    let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
    let inFlight: Promise<Response> | undefined;
    const actor = crypto.randomUUID(),
      other = crypto.randomUUID(),
      org = crypto.randomUUID();
    const session = (user: string) =>
      `eyJhbGciOiJmaXh0dXJlIn0.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.fixture`;
    const actorSession = session(actor),
      otherSession = session(other);
    const access = crypto.randomUUID(),
      code = crypto.randomUUID();
    let challenge: string | undefined;
    const upstream: FetchLike = async (input, init) => {
      const request = new Request(String(input), init),
        url = new URL(request.url);
      if (url.href === "https://issuer.example/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/authorize",
          token_endpoint: "https://issuer.example/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      if (url.href === "https://upstream.example/.well-known/oauth-protected-resource")
        return Response.json({
          resource: "https://upstream.example/mcp",
          authorization_servers: ["https://issuer.example"],
          scopes_supported: ["tools"],
        });
      if (url.href === "https://issuer.example/token") {
        const form = new URLSearchParams(await request.text());
        if (form.get("grant_type") === "refresh_token") {
          refreshCalls++;
          expect(form.get("refresh_token") === refreshToken).toBe(true);
          request.signal.addEventListener(
            "abort",
            () => {
              refreshAborted = true;
            },
            { once: true },
          );
          refreshStarted.resolve();
          await refreshRelease.promise;
          return Response.json({
            access_token: access,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "tools",
            refresh_token: refreshToken,
          });
        }
        request.signal.addEventListener(
          "abort",
          () => {
            tokenAborted = true;
          },
          { once: true },
        );
        started.resolve();
        expect(request.method).toBe("POST");
        expect(form.get("code") === code).toBe(true);
        expect(form.get("redirect_uri")).toBe("https://dashboard.example/auth/mcp/callback");
        expect(form.get("resource")).toBe("https://upstream.example/mcp");
        const proof = Buffer.from(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")),
        ).toString("base64url");
        expect(proof === challenge).toBe(true);
        await release.promise;
        return Response.json({
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools",
          refresh_token: refreshToken,
        });
      }
      if (url.origin !== "https://upstream.example" || !["/mcp", "/public"].includes(url.pathname))
        throw Error("Unexpected fixture network destination");
      if (url.pathname === "/mcp" && request.headers.get("authorization") !== `Bearer ${access}`)
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://upstream.example/.well-known/oauth-protected-resource"',
          },
        });
      const id = request.headers.get("mcp-session-id");
      let transport = id ? transports.get(id) : undefined;
      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          keepAliveMs: 0,
        });
        const server = new McpServer({ name: "OAuth fixture", version: "1" });
        server.registerTool("check", {}, async () => ({ content: [{ type: "text", text: "ready" }] }));
        server.registerResource("document", "fixture://document", {}, async (uri) => ({
          contents: [{ uri: uri.href, text: "document" }],
        }));
        server.registerPrompt("review", {}, async () => ({
          messages: [{ role: "user", content: { type: "text", text: "review" } }],
        }));
        await server.connect(transport);
        servers.push(server);
      }
      const response = await transport.handleRequest(request);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return response;
    };
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users(id) values($1),($2)", [actor, other]);
      await db.query("insert into public.orgs(id,name) values($1,'OAuth publication')", [org]);
      await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
        org,
        actor,
        other,
      ]);
      integration = createMcpHttpIntegration({
        sql: db,
        encryptionKey,
        publicUrl: "https://gateway.example",
        dashboardUrl: "https://dashboard.example",
        authStore: createSqlAuthStore(db),
        fetch: upstream,
        supabase: {
          supabaseUrl: "https://auth.example",
          anonKey: "public",
          fetch: async (_input, init) => {
            const bearer = new Headers(init?.headers).get("authorization");
            if (bearer === `Bearer ${actorSession}`) return Response.json({ id: actor });
            if (bearer === `Bearer ${otherSession}`) return Response.json({ id: other });
            return new Response(null, { status: 401 });
          },
        },
      });
      const service = integration;
      const post = async (action: string, body: object, token = actorSession, signal?: AbortSignal) => {
        const response = await service.route(
          new Request(`https://gateway.example/api/v1/mcp/${action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          }),
        );
        if (!response) throw Error("Missing callback/control HTTP route");
        return response;
      };
      const create = async (name: string, url: string, authType: string) => {
        const response = await post(
          "create",
          { org, name, url, authType, scope: "org", transport: "http" },
          otherSession,
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { connection: { id: string } }).connection.id;
      };
      const unrelated = await create("Existing shared service", "https://upstream.example/public", "none");
      expect((await post("connect", { org, id: unrelated }, otherSession)).status).toBe(200);
      const unrelatedBefore = (
        await db.query<{ generation: number; status: string }>(
          "select generation,status from public.mcp_grants where connection_id=$1",
          [unrelated],
        )
      ).rows[0];
      expect(unrelatedBefore?.status).toBe("connected");
      const id = await create("New shared OAuth identity", "https://upstream.example/mcp", "oauth");
      const connected = await post("connect", { org, id });
      expect(connected.status).toBe(200);
      const authorization = ((await connected.json()) as { authorizationUrl: string }).authorizationUrl;
      const parsed = new URL(authorization),
        state = parsed.searchParams.get("state");
      challenge = parsed.searchParams.get("code_challenge") ?? undefined;
      if (!state || !challenge) throw Error("SDK did not produce PKCE state/challenge");
      const generationBefore = (
        await db.query<{ generation: number }>("select generation from public.mcp_grants where connection_id=$1", [id])
      ).rows[0]?.generation;
      inFlight = post(
        "oauth/callback",
        { org: crypto.randomUUID(), state, code, issuer: "https://issuer.example" },
        actorSession,
        change === "callback_cancel" ? controller.signal : undefined,
      );
      await started.promise;
      expect(
        (
          await db.query<{ count: number }>(
            "select count(*)::integer as count from public.mcp_pending_oauth where connection_id=$1",
            [id],
          )
        ).rows[0]?.count,
      ).toBe(0);
      if (change === "demote" || change === "demote_readd")
        await db.query("update public.members set role='member' where org_id=$1 and user_id=$2", [org, actor]);
      if (change === "remove" || change === "remove_readd")
        await db.query("delete from public.members where org_id=$1 and user_id=$2", [org, actor]);
      if (change === "demote_readd")
        await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [org, actor]);
      if (change === "remove_readd")
        await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, actor]);
      if (change === "revoke") expect((await post("revoke", { org, id }, otherSession)).status).toBe(200);
      if (change === "supersede") expect((await post("connect", { org, id }, otherSession)).status).toBe(200);
      if (change === "callback_cancel") controller.abort();
      else release.resolve();
      const response = await inFlight;
      if (change === "callback_cancel") {
        expect(tokenAborted).toBe(true);
        release.resolve();
      }
      const body = await response.text();
      expect(body.includes(code)).toBe(false);
      expect(body.includes(access)).toBe(false);
      const grant = (
        await db.query<{ value_enc: Uint8Array | null; status: string; generation: number }>(
          "select value_enc,status,generation from public.mcp_grants where connection_id=$1",
          [id],
        )
      ).rows[0];
      expect(grant).toBeDefined();
      if (change === "none" || change === "refresh_cancel") {
        expect(response.status).toBe(200);
        expect(JSON.parse(body).connection).toMatchObject({
          id,
          orgId: org,
          status: "connected",
          toolCount: 1,
          resourceCount: 1,
          promptCount: 1,
        });
        expect(grant?.value_enc !== null).toBe(true);
      } else {
        expect(response.status).not.toBe(200);
        expect(grant?.value_enc === null).toBe(true); // A post-publication 403 must not hide stored credentials.
        expect(grant?.status).not.toBe("connected");
      }
      if (change === "none") {
        const statuses = await Promise.all(Array.from({ length: 8 }, () => post("status", { org, id })));
        for (const status of statuses) {
          expect(status.status).toBe(200);
          expect(((await status.json()) as { connection: { status: string } }).connection.status).toBe("connected");
        }
      }
      if (change === "refresh_cancel") {
        // Real grant was created via callback; model its elapsed token lifetime, not a fake auth receipt.
        const row = (
          await db.query<{ value_enc: Uint8Array }>("select value_enc from public.mcp_grants where connection_id=$1", [
            id,
          ])
        ).rows[0];
        if (!row) throw Error("Persisted OAuth grant missing");
        const box = createMcpSecretBox(encryptionKey),
          saved = JSON.parse(await box.open(Buffer.from(row.value_enc).toString("base64"))) as { expiresAt: number };
        saved.expiresAt = Date.now() - 1;
        await db.query("update public.mcp_grants set value_enc=$2::bytea where connection_id=$1", [
          id,
          new Uint8Array(Buffer.from(await box.seal(JSON.stringify(saved)), "base64")),
        ]);
        const cancellation = new AbortController();
        const status = post("status", { org, id }, actorSession, cancellation.signal);
        await refreshStarted.promise;
        cancellation.abort();
        const reply = await status;
        expect(reply.status).toBe(200);
        expect(((await reply.json()) as { connection: { status: string } }).connection.status).not.toBe("connected");
        expect(refreshAborted).toBe(true);
        const fenced = (
          await db.query<{ refresh_consumed: boolean; status: string }>(
            "select refresh_consumed,status from public.mcp_grants where connection_id=$1",
            [id],
          )
        ).rows[0];
        expect(fenced?.refresh_consumed).toBe(true);
        expect(fenced?.status).not.toBe("connected");
        await post("status", { org, id });
        expect(refreshCalls).toBe(1);
        refreshRelease.resolve();
      }
      if (!["revoke", "supersede"].includes(change)) expect(grant?.generation).toBe(generationBefore);
      const unrelatedAfter = (
        await db.query<{ generation: number; status: string }>(
          "select generation,status from public.mcp_grants where connection_id=$1",
          [unrelated],
        )
      ).rows[0];
      expect(unrelatedAfter).toEqual(unrelatedBefore);
    } finally {
      release.resolve();
      refreshRelease.resolve();
      await inFlight?.catch(() => {});
      await integration?.close();
      await Promise.all(servers.map((s) => s.close()));
      await db.close();
    }
  });
