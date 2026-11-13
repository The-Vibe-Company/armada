import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlMcpLeasePort, createSqlMcpRegistry, createSqlVaultStore } from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const f = await runtimeFixture(),
    registry = createSqlMcpRegistry(f.sql, ENCRYPTION_KEY);
  const secret = `upstream-private-${crypto.randomUUID()}`;
  const c = await registry.save(f.people.owner, f.people.org, {
    name: "Runtime remote",
    scope: "personal",
    transport: "http",
    url: "https://upstream.example/mcp",
    authType: "bearer",
    authentication: secret,
  });
  // Seed an already-connected remote definition; the SDK gateway call below verifies actual delivery.
  await f.db.query("update mcp_grants set status='connected' where connection_id=$1", [c.id]);
  const service = createRuntimeMcp({
    sql: f.sql,
    key: ENCRYPTION_KEY,
    origin: "https://armada.test",
    commands: f.bridge,
  });
  const input = { id: f.row.id, connections: [c.id] };
  const authStore = createMemoryAuthStore();
  authStore.addMembership(f.people.owner, { orgId: f.people.org, name: "Fixture", role: "member" });
  const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: f.people.owner })).replace(/=+$/, "")}.sig`;
  return {
    f,
    c,
    secret,
    service,
    input,
    registry,
    authStore,
    async api(path: string, body: object) {
      const response = await handleControlRequest(
        new Request(`https://armada.test/api/v1/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify(body),
        }),
        {
          authStore,
          store: createSqlVaultStore(f.sql),
          encryptionKey: ENCRYPTION_KEY,
          supabase: {
            supabaseUrl: "https://supabase.test",
            anonKey: "fixture",
            fetch: async () => Response.json({ id: f.people.owner }),
          },
          data: createSqlData(f.sql),
          runtimeMcp: service,
          providers: {
            async resolve() {
              throw Error("MCP must not resolve native/provider tools");
            },
          },
        },
      );
      if (!response) throw Error("Missing API route");
      return response;
    },
    configuration() {
      const snapshot = f.mcpSnapshots.at(-1);
      if (!snapshot) throw Error("Runner did not pass MCP to driver");
      const server = Object.values(snapshot.servers)[0];
      if (!server || server.type !== "http") throw Error("Missing HTTP gateway snapshot");
      return {
        snapshot,
        server,
        hash: createHash("sha256").update(server.headers!.Authorization!.slice(7)).digest("hex"),
      };
    },
  };
}

describe("enrolled runtime remote MCP", () => {
  let x: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    x = await fixture();
  }, 20_000);
  afterAll(async () => {
    await x?.f.close();
  });
  test("authenticated setup reaches the real Runner and real MCP gateway; only scoped leases reach the driver", async () => {
    const { f } = x;
    expect(
      (await x.api("sandbox/mcp-preflight-v1", { runtimeVersion: 1, org: f.people.org, connections: [x.c.id] })).status,
    ).toBe(200);
    const response = await x.api("sandbox/configure-mcp-runtime-v1", x.input);
    expect(response.status).toBe(200);
    const result = (await response.json()) as Awaited<ReturnType<typeof x.service.refresh>>;
    expect(result).toMatchObject({ runtime: { kind: "armada", epoch: "1" }, connections: [x.c.id] });
    expect(/armada_gw_|upstream-private/.test(JSON.stringify(result))).toBe(false);
    await f.send(f.caller, f.input("use configured MCP"));
    const { snapshot, server, hash } = x.configuration();
    expect(JSON.stringify(snapshot).includes(x.secret)).toBe(false);
    const raw = server.headers!.Authorization!.slice(7);
    expect(f.journal.redact(raw).includes(raw)).toBe(false);
    expect(f.journal.redact(server.headers!.Authorization!).includes(server.headers!.Authorization!)).toBe(false);
    expect(await createSqlMcpLeasePort(f.sql).validate(hash, "tools")).not.toBeNull();
    await expect(x.service.refresh({ ...f.caller, userId: f.people.admin }, x.input)).rejects.toThrow();
    const servers: McpServer[] = [],
      transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
    let calls = 0;
    const upstream: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      expect(request.headers.get("authorization") === `Bearer ${x.secret}`).toBe(true);
      let transport = transports.get(request.headers.get("mcp-session-id") ?? "");
      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          keepAliveMs: 0,
        });
        const remote = new McpServer({ name: "Independent remote", version: "1" });
        remote.registerTool("read_counter", { annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: `remote result ${++calls}` }],
        }));
        await remote.connect(transport);
        servers.push(remote);
      }
      const response = await transport.handleRequest(request);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return response;
    };
    const gateway = createMcpHttpIntegration({
      sql: f.sql,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
      authStore: x.authStore,
      supabase: { supabaseUrl: "https://supabase.test", anonKey: "fixture" },
      fetch: upstream,
      deferBackground: true,
    });
    const client = new Client({ name: "Runtime MCP consumer", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
          fetch: async (input, init) =>
            (await gateway.route(new Request(String(input), init))) ?? new Response(null, { status: 404 }),
        }),
      );
      expect(await client.callTool({ name: "read_counter", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "remote result 1" }],
      });
      expect(calls).toBe(1);
      expect(
        await createRuntimeMcp({
          sql: f.sql,
          key: ENCRYPTION_KEY,
          origin: "https://armada.test",
          commands: f.bridge,
        }).refresh(f.caller, x.input),
      ).toEqual(result);
      await f.db.query("update mcp_grants set generation=generation+1 where connection_id=$1", [x.c.id]);
      await expect(x.service.refresh(f.caller, x.input)).rejects.toMatchObject({ code: "conflict" });
      expect(await createSqlMcpLeasePort(f.sql).validate(hash, "tools")).toBeNull();
    } finally {
      await client.close().catch(() => {});
      await gateway.close();
      for (const server of servers) await server.close();
    }
  });
});

test("checkpoint durably revokes MCP leases; a fresh epoch explicitly reauthorizes the same fixed selection", async () => {
  const x = await fixture(),
    { f } = x;
  try {
    await x.service.refresh(f.caller, x.input);
    await f.send(f.caller, f.input());
    const old = x.configuration();
    const cp = await createRuntimeCheckpoint(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
    )(f.caller, { id: f.row.id, request_id: crypto.randomUUID(), runtimeVersion: 1 });
    expect(
      (
        await f.db.query<{ revoked: boolean }>(
          "select revoked_at is not null as revoked from mcp_leases where hash=$1",
          [old.hash],
        )
      ).rows[0]?.revoked,
    ).toBe(true);
    expect(await createSqlMcpLeasePort(f.sql).validate(old.hash, "tools")).toBeNull();
    await expect(x.service.refresh(f.caller, x.input)).rejects.toThrow();
    await f.db.query("update sandboxes set status='starting' where id=$1", [f.row.id]);
    await f.reboot({ epoch: "1", watermark: cp.checkpoint.watermark, conversationId: f.first.conversationId });
    await f.db.query("update sandboxes set status='running' where id=$1", [f.row.id]);
    const refreshed = await x.service.refresh(f.caller, x.input);
    await f.send(f.caller, f.input());
    const next = x.configuration();
    expect(refreshed.runtime.epoch).toBe("2");
    expect(next.hash === old.hash).toBe(false);
    expect(await createSqlMcpLeasePort(f.sql).validate(old.hash, "tools")).toBeNull();
    expect(await createSqlMcpLeasePort(f.sql).validate(next.hash, "tools")).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("epoch replacement before RPC enqueue cannot install old configuration; old gateway replicas see durable revocation", async () => {
  const x = await fixture(),
    { f } = x;
  try {
    await x.service.refresh(f.caller, x.input);
    await f.send(f.caller, f.input());
    const old = x.configuration();
    const raced = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        async call(owner, command, options) {
          await f.authority.enrol(
            (await f.authority.issue({ sandboxId: f.row.id, ownerId: f.people.owner, configuration: {} }))
              .enrolmentToken,
          );
          return f.bridge.call(owner, command, options);
        },
      },
    });
    await expect(raced.refresh(f.caller, x.input)).rejects.toThrow();
    expect(
      (
        await f.db.query<{ revoked: boolean }>(
          "select revoked_at is not null as revoked from mcp_leases where hash=$1",
          [old.hash],
        )
      ).rows[0]?.revoked,
    ).toBe(true);
    expect(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::int as n from runtime_commands where sandbox_id=$1 and epoch=2",
          [f.row.id],
        )
      ).rows[0]?.n,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
