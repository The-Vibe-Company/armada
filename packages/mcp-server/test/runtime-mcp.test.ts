import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlMcpLeasePort, createSqlMcpRegistry, createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { createRuntimeResume } from "../src/runtime-resume.ts";
import { createRuntimeSelfFinish } from "../src/sandbox-finish.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(provider: "boat" | "modal" = "boat") {
  const f = await runtimeFixture(await sharedDatabase(), provider),
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
    probe: async () => ({ status: "connected", toolNames: ["read_counter"] }),
  });
  const input = { id: f.row.id, connections: [c.id] };
  await service.connections.validate({ userId: f.people.owner, orgId: f.people.org }, [c.id], "org");
  await service.connections.bind(f.row.id, [c.id]);
  const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, service.prepare);
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
    send,
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
          runtimeSend: send,
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

describe.each(["boat", "modal"] as const)("enrolled runtime remote MCP (%s)", (provider) => {
  let current: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeAll(async () => {
    current = await fixture(provider);
  }, 20_000);
  afterAll(async () => {
    const x = current;
    current = undefined;
    await x?.f.close();
  });
  test("authenticated setup reaches the real Runner and real MCP gateway; only scoped leases reach the driver", async () => {
    const x = current;
    if (!x) throw new Error("Runtime fixture is not open");
    const { f } = x;
    expect(
      (await x.api("sandbox/mcp-preflight-v1", { runtimeVersion: 1, org: f.people.org, connections: [x.c.id] })).status,
    ).toBe(200);
    const inventory = await x.api("sandbox/mcp-preflight-v1", {
      runtimeVersion: 1,
      org: f.people.org,
      connections: [x.c.id],
      toolInventory: true,
    });
    expect(await inventory.json()).toMatchObject({
      mcpToolInventory: [{ connectionId: x.c.id, tools: ["read_counter"] }],
    });
    const oldProbe = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: f.bridge,
      probe: async () => ({ status: "connected" }),
    });
    await expect(
      oldProbe.preflight(f.caller, { org: f.people.org, connections: [x.c.id], toolInventory: true }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const response = await x.api("sandbox/send", f.input("use configured MCP"));
    expect(response.status).toBe(200);
    const result = (await response.json()) as Awaited<ReturnType<typeof x.send>>;
    expect(result).toMatchObject({ runtime: { kind: "armada", epoch: "1" } });
    expect(/armada_gw_|upstream-private/.test(JSON.stringify(result))).toBe(false);
    const { snapshot, server, hash } = x.configuration();
    expect(JSON.stringify(snapshot).includes(x.secret)).toBe(false);
    const raw = server.headers!.Authorization!.slice(7);
    expect(f.journal.redact(raw).includes(raw)).toBe(false);
    expect(f.journal.redact(server.headers!.Authorization!).includes(server.headers!.Authorization!)).toBe(false);
    expect(await createSqlMcpLeasePort(f.sql).validate(hash, "tools")).not.toBeNull();
    expect(
      (await f.db.query<{ epoch: string }>("select runtime_epoch::text as epoch from mcp_leases where hash=$1", [hash]))
        .rows[0]?.epoch,
    ).toBe("1");
    await expect(x.service.prepare({ ...f.caller, userId: f.people.admin }, f.row.id)).rejects.toThrow();
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
        }).prepare(f.caller, f.row.id),
      ).toMatchObject({ revision: snapshot.revision });
    } finally {
      await client.close().catch(() => {});
      await gateway.close();
      for (const server of servers) await server.close();
    }
  });
});

test.each(["boat", "modal"] as const)(
  "checkpoint durably revokes MCP leases; a fresh epoch explicitly reauthorizes the same fixed selection (%s)",
  async (provider) => {
    const x = await fixture(provider),
      { f } = x;
    try {
      await x.send(f.caller, f.input());
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
      await expect(x.service.prepare(f.caller, f.row.id)).rejects.toThrow();
      await f.db.query("update sandboxes set status='stopping',stop_requested_at=now() where id=$1", [f.row.id]);
      await f.db.query("update sandboxes set status='stopped',stop_requested_at=null,stopped_at=now() where id=$1", [
        f.row.id,
      ]);
      const resume = createRuntimeResume(
        f.sql,
        ENCRYPTION_KEY,
        f.bridge,
        async () => ({
          start: async (_signal, restore) => f.reboot(restore),
          stop: async () => {
            throw Error("Healthy resume must not stop");
          },
        }),
        x.service.prepare,
      );
      const refreshed = await resume(f.caller, {
        id: f.row.id,
        request_id: crypto.randomUUID(),
        runtimeVersion: 1,
        conversation_id: f.first.conversationId,
        prompt: "first resumed MCP turn",
      });
      const next = x.configuration();
      expect(refreshed.sourceCheckpoint.watermark).toBe(cp.checkpoint.watermark);
      expect(refreshed.runtime.epoch).toBe("2");
      expect(next.hash === old.hash).toBe(false);
      expect(await createSqlMcpLeasePort(f.sql).validate(old.hash, "tools")).toBeNull();
      expect(await createSqlMcpLeasePort(f.sql).validate(next.hash, "tools")).not.toBeNull();
      await f.db.query("update sandboxes set status='stopping',stop_requested_at=now() where id=$1", [f.row.id]);
      expect(await createSqlMcpLeasePort(f.sql).validate(next.hash, "tools")).toBeNull();
      expect(
        (
          await f.db.query<{ revoked: boolean }>(
            "select revoked_at is not null as revoked from mcp_leases where hash=$1",
            [next.hash],
          )
        ).rows[0]?.revoked,
      ).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test.each(["boat", "modal"] as const)(
  "a refused MCP configuration on send records runtime outcomes under the HTTP request ID (%s)",
  async (provider) => {
    const x = await fixture(provider),
      { f } = x,
      lines: string[] = [];
    // The guest's own reply is the refusal: the shared command boundary must classify it.
    f.refuse("configureMcp");
    try {
      const response = await observeRequest(
        () => x.api("sandbox/send", f.input("use configured MCP")),
        (line) => lines.push(line),
      );
      expect(response.status).toBe(503);
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toBeTruthy();
      const events = lines.map((line) => JSON.parse(line));
      expect(events.filter((event) => event.event === "provider_call")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId, provider, operation: "runtime.health", outcome: "ok" }),
          expect.objectContaining({ requestId, provider, operation: "runtime.configureMcp", outcome: "error" }),
        ]),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "operator_failure",
          requestId,
          sandboxId: f.row.id,
          phase: "runtime.configureMcp",
          errorClass: "RuntimeCommandReply",
          message: "Runtime reply rejected (HTTP 503)",
        }),
      );
      expect(events.at(-1)).toMatchObject({ event: "http_request", requestId, status: 503 });
    } finally {
      await f.close();
    }
  },
);

test("epoch replacement after capability evidence cannot queue configuration in another epoch", async () => {
  const x = await fixture(),
    { f } = x;
  try {
    const raced = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        async call(owner, command, options) {
          const reply = await f.bridge.call(owner, command, options);
          if (command.op === "health")
            await f.authority.enrol(
              (await f.authority.issue({ sandboxId: f.row.id, ownerId: f.people.owner, configuration: {} }))
                .enrolmentToken,
            );
          return reply;
        },
      },
    });
    await expect(raced.prepare(f.caller, f.row.id)).rejects.toThrow();
    expect(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::int as n from runtime_commands where sandbox_id=$1 and epoch=2",
          [f.row.id],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (await f.db.query<{ n: number }>("select count(*)::int as n from mcp_leases where sandbox_id=$1", [f.row.id]))
        .rows[0]?.n,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

test("old runtime health cannot receive newly enabled MCP capabilities", async () => {
  const x = await fixture(),
    { f } = x,
    ops: string[] = [];
  try {
    const old = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        async call(owner, command, options) {
          ops.push(command.op);
          const reply = await f.bridge.call(owner, command, options);
          if (command.op !== "health") return reply;
          return { ...reply, body: { ...reply.body, result: { ready: true, generation: reply.epoch } } };
        },
      },
    });
    await expect(old.prepare(f.caller, f.row.id)).rejects.toMatchObject({ code: "unavailable" });
    expect(ops).toEqual(["health"]);
    expect(f.mcpSnapshots.at(-1)).toBeUndefined();
  } finally {
    await f.close();
  }
});

describe("automatic MCP authority updates", () => {
  let current: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeAll(async () => {
    const x = await fixture();
    current = x;
    await x.send(x.f.caller, x.f.input());
  }, 20_000);
  afterAll(async () => {
    const x = current;
    current = undefined;
    await x?.f.close();
  });
  test("ordinary turns adopt reconnected grants and clear deleted bindings without a setup API", async () => {
    const x = current;
    if (!x) throw new Error("Runtime fixture is not open");
    const { f } = x,
      old = x.configuration();
    await f.db.query("update mcp_grants set generation=generation+1 where connection_id=$1", [x.c.id]);
    await x.send(f.caller, f.input("after grant replacement"));
    expect(x.configuration().snapshot.revision === old.snapshot.revision).toBe(false);
    expect(await createSqlMcpLeasePort(f.sql).validate(old.hash, "tools")).toBeNull();
    await x.registry.revoke(f.people.owner, f.people.org, x.c.id, true);
    await x.send(f.caller, f.input("after connection removal"));
    const self = f.mcpSnapshots.at(-1)?.servers.armada_self;
    expect(Object.keys(f.mcpSnapshots.at(-1)?.servers ?? {})).toEqual(["armada_self"]);
    if (!self || self.type !== "http") throw Error("Missing self completion capability");
    const token = self.headers!.Authorization!.slice(7);
    expect(f.journal.redact(token).includes(token)).toBe(false);
    const finish = createRuntimeSelfFinish(f.sql, ENCRYPTION_KEY);
    await expect(finish(`${token.slice(0, -1)}!`)).rejects.toThrow();
    await f.db.query("update sandboxes set mcp_generation=mcp_generation+1 where id=$1", [f.row.id]);
    await expect(finish(token)).rejects.toThrow("denied");
    await f.db.query("update sandboxes set mcp_generation=mcp_generation-1 where id=$1", [f.row.id]);
    expect(await finish(token)).toMatchObject({ id: f.row.id, status: "stopping" });
    await expect(finish(token)).rejects.toThrow();
  });
});

test("configuration preparation commits queue order before waiting; an older ACK cannot overwrite the winning snapshot", async () => {
  const x = await fixture(),
    { f } = x;
  let newer: Awaited<ReturnType<typeof x.service.prepare>>;
  let updated = false;
  try {
    const competing = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        callPrepared(owner, operation, prepare, provider, sandboxId) {
          return f.bridge.callPrepared(
            owner,
            operation,
            async () => {
              const prepared = await prepare();
              if (operation === "configureMcp" && !updated) {
                updated = true;
                await f.db.query("update mcp_grants set generation=generation+1 where connection_id=$1", [x.c.id]);
                newer = await x.service.prepare(f.caller, f.row.id);
              }
              return prepared;
            },
            provider,
            sandboxId,
          );
        },
      },
    });
    await expect(competing.prepare(f.caller, f.row.id)).rejects.toThrow();
    expect(updated).toBe(true);
    await x.send(f.caller, f.input("use the latest configuration"));
    expect(x.configuration().snapshot.revision).toBe(newer?.revision ?? "missing newer receipt");
    expect(await createSqlMcpLeasePort(f.sql).validate(x.configuration().hash, "tools")).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("pinned stdio delivers its encrypted environment privately without a gateway lease", async () => {
  const x = await fixture(),
    { f } = x;
  const secret = crypto.randomUUID();
  const lines: string[] = [];
  try {
    const local = await x.registry.save(f.people.owner, f.people.org, {
      name: "local",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/mcp@1.2.3", "/workspace"],
      stdioEnv: { MCP_PRIVATE_VALUE: secret },
    });
    await expect(x.service.preflight(f.caller, { org: f.people.org, connections: [local.id] })).resolves.toEqual({
      mcpReady: true,
      connections: [local.id],
    });
    await x.service.connections.validate({ userId: f.people.owner, orgId: f.people.org }, [local.id], "org");
    await x.service.connections.bind(f.row.id, [local.id]);
    const receipt = await x.service.prepare(f.caller, f.row.id);
    const response = await observeRequest(
      () => x.api("sandbox/send", f.input("use configured MCP")),
      (line) => lines.push(line),
    );
    expect(response.status).toBe(200);
    const server = f.mcpSnapshots.at(-1)?.servers[`armada_${local.id.replaceAll("-", "_")}`];
    expect(server).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["--yes", "--", "@example/mcp@1.2.3", "/workspace"],
    });
    expect(server?.type === "stdio" && server.env?.MCP_PRIVATE_VALUE === secret).toBe(true);
    f.journal.append({ id: "mcp-stderr", at: 1, kind: "other", type: "harness_stderr", data: { text: secret } });
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify([receipt, await response.json(), lines, f.journal.events()]).includes(secret)).toBe(false);
    expect((await f.db.query("select 1 from mcp_leases where connection_id=$1", [local.id])).rows).toEqual([]);
    const replacement = crypto.randomUUID();
    await f.db.query("update mcp_grants set value_enc=$2 where connection_id=$1", [
      local.id,
      await encryptSecret(JSON.stringify({ MCP_PRIVATE_VALUE: replacement }), ENCRYPTION_KEY),
    ]);
    expect((await x.service.prepare(f.caller, f.row.id))?.revision).not.toBe(receipt?.revision);
    await x.registry.setEnabled(f.people.owner, f.people.org, local.id, false);
    await expect(x.service.prepare(f.caller, f.row.id)).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await f.close();
  }
});

test("dispatch rejects a bound stdio environment changed to launcher settings after health", async () => {
  const { f, registry, service } = await fixture();
  try {
    const local = await registry.save(f.people.owner, f.people.org, {
      name: "local",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["@example/mcp@1.2.3"],
    });
    await service.connections.validate({ userId: f.people.owner, orgId: f.people.org }, [local.id], "org");
    await service.connections.bind(f.row.id, [local.id]);
    const marker = crypto.randomUUID();
    const raced = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        async call(owner, command, options) {
          const reply = await f.bridge.call(owner, command, options);
          if (command.op === "health")
            await f.db.query("update mcp_grants set value_enc=$2 where connection_id=$1", [
              local.id,
              await encryptSecret(JSON.stringify({ npm_config_registry: marker }), ENCRYPTION_KEY),
            ]);
          return reply;
        },
      },
    });
    await expect(raced.prepare(f.caller, f.row.id)).rejects.toThrow(
      /^MCP stdio environment cannot override launcher settings\.$/,
    );
    expect((await f.db.query("select 1 from mcp_bootstraps where sandbox_id=$1", [f.row.id])).rows).toEqual([]);
  } finally {
    await f.close();
  }
});

test("preflight and launch reject stdio grant env that exceeds the runtime limit", async () => {
  const { f, registry, service } = await fixture();
  try {
    const local = await registry.save(f.people.owner, f.people.org, {
      name: "local",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["@example/mcp@1.2.3"],
    });
    const secret = "x".repeat(8193);
    await f.db.query("update mcp_grants set value_enc=$2 where connection_id=$1", [
      local.id,
      await encryptSecret(JSON.stringify({ MCP_PRIVATE_VALUE: secret }), ENCRYPTION_KEY),
    ]);
    const input = { org: f.people.org, connections: [local.id] };
    await expect(service.preflight(f.caller, input)).rejects.toMatchObject({ code: "invalid" });
    await expect(
      service.connections.validate({ userId: f.people.owner, orgId: f.people.org }, input.connections, "org"),
    ).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await f.close();
  }
});

test.each([
  ["argument count", Array(62).fill("input")],
  ["configuration bytes including the built-in service", Array(16).fill("x".repeat(4080))],
])("runtime admission rejects pinned stdio beyond the limit for %s", async (_limit, args) => {
  const { f, registry, service } = await fixture();
  try {
    const local = await registry.save(f.people.owner, f.people.org, {
      name: "oversized local",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["@example/mcp@1.2.3", ...args],
    });
    await expect(service.preflight(f.caller, { org: f.people.org, connections: [local.id] })).rejects.toMatchObject({
      code: "invalid",
    });
  } finally {
    await f.close();
  }
});

test.each(["boat", "modal"] as const)(
  "epoch replacement durably revokes an already delivered MCP lease (%s)",
  async (provider) => {
    const x = await fixture(provider),
      { f } = x;
    try {
      await x.send(f.caller, f.input());
      const old = x.configuration();
      await f.authority.enrol(
        (await f.authority.issue({ sandboxId: f.row.id, ownerId: f.people.owner, configuration: {} })).enrolmentToken,
      );
      expect(
        (
          await f.db.query<{ revoked: boolean }>(
            "select revoked_at is not null as revoked from mcp_leases where hash=$1",
            [old.hash],
          )
        ).rows[0]?.revoked,
      ).toBe(true);
      expect(await createSqlMcpLeasePort(f.sql).validate(old.hash, "tools")).toBeNull();
    } finally {
      await f.close();
    }
  },
);

test("native Modal MCP leases stay epoch-free and usable without an enrolled runtime", async () => {
  const x = await fixture("modal"),
    { f } = x;
  try {
    const native = await createSqlData(f.sql)(f.caller).sandboxes.insert({
      id: crypto.randomUUID(),
      provider: "modal",
      providerSandboxId: "native-modal",
      goldenId: f.row.goldenId,
      orgId: f.people.org,
      ownerId: f.people.owner,
      harness: "codex",
      status: "ready",
      visibility: "org",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    await x.service.connections.bind(native.id, [x.c.id]);
    const leases = createSqlMcpLeasePort(f.sql),
      hash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    await leases.issue({
      sandboxId: native.id,
      connectionId: x.c.id,
      tokenHash: hash,
      operations: ["tools"],
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(
      (await f.db.query<{ runtime_epoch: string | null }>("select runtime_epoch from mcp_leases where hash=$1", [hash]))
        .rows[0]?.runtime_epoch,
    ).toBeNull();
    expect(await leases.validate(hash, "tools")).not.toBeNull();
  } finally {
    await f.close();
  }
});

describe("model-only runtime completion", () => {
  test("the first prompt receives only self completion when no remote MCP connections were selected", async () => {
    const f = await runtimeFixture(await sharedDatabase());
    try {
      const service = createRuntimeMcp({
        sql: f.sql,
        key: ENCRYPTION_KEY,
        origin: "https://armada.test",
        commands: f.bridge,
      });
      await createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, service.prepare)(f.caller, f.input());
      const snapshot = f.mcpSnapshots.at(-1);
      expect(Object.keys(snapshot?.servers ?? {})).toEqual(["armada_self"]);
      const self = snapshot?.servers.armada_self;
      if (!self || self.type !== "http") throw Error("Missing private self capability");
      expect(self.url).toBe("https://armada.test/api/v1/orchestrator-tools/mcp");
      const token = self.headers!.Authorization!.slice(7);
      expect(f.journal.redact(token).includes(token)).toBe(false);
      expect(await createRuntimeSelfFinish(f.sql, ENCRYPTION_KEY)(token)).toMatchObject({
        id: f.row.id,
        status: "stopping",
      });
    } finally {
      await f.close();
    }
  });
});
