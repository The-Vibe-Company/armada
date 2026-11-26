import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMemoryAuthStore } from "@armada/auth";
import { sandboxCheckOperations } from "@armada/core/contract";
import { createSqlMcpLeasePort, createSqlMcpRegistry, createSqlVaultStore, encryptSecret } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createTurnDispatchJob } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createResumeJob } from "../src/jobs/resume.ts";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { createRuntimeResume } from "../src/runtime-resume.ts";
import { createRuntimeSelfFinish } from "../src/sandbox-finish.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(provider: "boat" | "modal" = "boat", commandGrantExpiresAt?: number) {
  const f = await runtimeFixture(await sharedDatabase(), provider, "codex", false, commandGrantExpiresAt);
  return configureRuntimeFixture(f, async () => {
    const registry = createSqlMcpRegistry(f.sql, ENCRYPTION_KEY);
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
      close: f.close,
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
  });
}

test("Boat runtime MCP leases expire at the committed sandbox deadline", async () => {
  const x = await fixture("boat", Date.now() + 6 * 60 * 60_000);
  const { f } = x;
  try {
    await x.send(f.caller, f.input());
    const { hash } = x.configuration();
    const { expires_at } = (
      await f.db.query<{ expires_at: Date }>("select expires_at from sandboxes where id=$1", [f.row.id])
    ).rows[0]!;
    expect((await f.db.query("select expires_at from mcp_leases where hash=$1", [hash])).rows[0]).toEqual({
      expires_at,
    });
  } finally {
    await f.close();
  }
});

test("Modal runtime MCP lease spans the command ceiling but follows live sandbox admission", async () => {
  const ceiling = new Date(Date.now() + 6 * 60 * 60_000);
  const x = await fixture("modal", ceiling.getTime()),
    { f } = x;
  try {
    await x.send(f.caller, f.input());
    const { hash } = x.configuration();
    expect((await f.db.query("select expires_at from mcp_leases where hash=$1", [hash])).rows[0]).toEqual({
      expires_at: ceiling,
    });
    const leases = createSqlMcpLeasePort(f.sql);
    expect(await leases.validate(hash, "tools")).not.toBeNull();
    await f.db.query("update sandboxes set expires_at=now()-interval '1 second' where id=$1", [f.row.id]);
    expect(await leases.validate(hash, "tools")).toBeNull();
  } finally {
    await f.close();
  }
});

describe.each(["boat", "modal"] as const)("enrolled runtime remote MCP (%s)", (provider) => {
  const prepared = scopedRuntimeFixture(() => fixture(provider), { timeout: 20_000 });
  test("authenticated setup reaches the real Runner and real MCP gateway; only scoped leases reach the driver", async () => {
    const x = await prepared();
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
    expect(sandboxCheckOperations.postSandboxMcpPreflightV1.output.parse(await inventory.json())).toEqual({
      mcpReady: true,
      connections: [x.c.id],
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

async function resumeWithJob(
  { f, service }: Awaited<ReturnType<typeof fixture>>,
  request: Parameters<ReturnType<typeof createRuntimeResume>>[1],
) {
  const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
  const resumeJob = createResumeJob({
    turns,
    sql: f.sql,
    key: ENCRYPTION_KEY,
    commands: f.bridge,
    async provider() {
      const machine: Pick<ModalProvider, "get" | "runtimeResumeMachine"> = {
        async get(id) {
          return {
            id,
            name: "replacement",
            state: "ready",
            providerState: "ready",
            labels: {},
            expiresAt: new Date(Date.now() + 86_400_000),
          };
        },
        async runtimeResumeMachine({ sandboxId, generation, checkpoint, ticket }) {
          return {
            predecessor: { sandboxId, generation: generation - 1, kind: "image", ref: "retained" },
            async resume() {
              return { sandboxId, generation, machineId: "replacement" };
            },
            async bootstrap(identity) {
              const descriptor = await ticket(identity);
              if (!descriptor) throw Error("Expected a fresh runtime bootstrap ticket.");
              await f.reboot(
                { ...checkpoint, conversationId: f.first.conversationId! },
                true,
                descriptor.enrolmentToken,
              );
            },
          };
        },
      };
      return machine as ModalProvider;
    },
    async boat() {
      let active = false;
      return {
        host: {
          async get(id: string) {
            return {
              id,
              name: "retained",
              labels: {},
              providerState: active ? "ready" : "archived",
              state: active ? ("ready" as const) : ("stopped" as const),
              retainedSnapshot: "usable" as const,
              expiresAt: new Date(Date.now() + 86_400_000),
            };
          },
          async resumeRuntime() {
            active = true;
          },
        } as unknown as ReturnType<typeof import("../src/observed-boat.ts").createObservedBoatProvider>,
        providerAuthority: "fixture",
        async authorize() {},
        async bootstrap(_host, { enrolmentToken }) {
          const scope = await f.authority.withBootstrap(enrolmentToken, async () => true);
          if (!scope) throw Error("Expected a current runtime ticket.");
          const {
            rows: [checkpoint],
          } = await f.sql.query<{ epoch: string; watermark: string }>(
            "select epoch::text,watermark::text from public.runtime_checkpoints where sandbox_id=$1",
            [f.row.id],
          );
          await f.reboot(
            {
              epoch: checkpoint!.epoch,
              watermark: Number(checkpoint!.watermark),
              conversationId: f.first.conversationId!,
            },
            true,
            enrolmentToken,
          );
        },
      };
    },
    async prepare() {
      return {
        serverUrl: PUBLIC_URL,
        artifact: { sha256: "b".repeat(64), bytes: 5 },
        cacheDir: "/tmp/runtime",
        configuration: {},
      };
    },
    prepareMcp: service.prepare,
    async restoreScopedAccess() {},
  });
  const resume = createRuntimeResume(f.sql, resumeJob.resume);
  const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, service.prepare, undefined, resumeJob.wake);
  const signal = new AbortController().signal;
  const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
  const runner = createJobsRunner(jobs, { resume: resumeJob.handler });
  const dispatch = createJobsRunner(jobs, {
    turn_dispatch: createTurnDispatchJob(f.sql, ENCRYPTION_KEY, (caller, input, claim) =>
      send(caller, input, claim, { fromQueue: true }),
    ),
  });
  expect(await turns.accept(f.caller, request)).toMatchObject({ status: "queued" });
  expect(await dispatch.reconcileOne(signal)).toBe(true);
  await dispatch.drain();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  await f.sql.query("update jobs set run_after='-infinity' where sandbox_id=$1 and kind='turn_dispatch'", [request.id]);
  expect(await dispatch.reconcileOne(signal)).toBe(true);
  await dispatch.drain();
  return resume(f.caller, request);
}

describe.each(["boat", "modal"] as const)("checkpoint and resume (%s)", (provider) => {
  const prepared = scopedRuntimeFixture(() => fixture(provider));
  test("checkpoint durably revokes MCP leases; a fresh epoch explicitly reauthorizes the same fixed selection", async () => {
    const x = await prepared();
    const { f } = x;
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
    const request = {
      id: f.row.id,
      request_id: crypto.randomUUID(),
      runtimeVersion: 1 as const,
      prompt: "first resumed MCP turn",
    };
    const refreshed = await resumeWithJob(x, request);
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
  });
});

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
  const prepared = scopedRuntimeFixture(
    async () => {
      const x = await fixture();
      return configureRuntimeFixture(x.f, async () => {
        await x.send(x.f.caller, x.f.input());
        return x;
      });
    },
    { timeout: 20_000 },
  );
  test("ordinary turns adopt reconnected grants and clear deleted bindings without a setup API", async () => {
    const x = await prepared();
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
  const secret = crypto.randomUUID().slice(0, 7);
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
    const response = await observeRequest(
      () => x.api("sandbox/send", f.input("use configured MCP")),
      (line) => lines.push(line),
    );
    expect(response.status).toBe(200);
    const receipt = await x.service.prepare(f.caller, f.row.id);
    const server = f.mcpSnapshots.at(-1)?.servers[`armada_${local.id.replaceAll("-", "_")}`];
    expect(server).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["--yes", "--", "@example/mcp@1.2.3", "/workspace"],
    });
    expect(server?.type === "stdio" && server.env?.MCP_PRIVATE_VALUE === secret).toBe(true);
    f.journal.append({
      id: "mcp-stderr",
      at: 1,
      kind: "other",
      type: "harness_stderr",
      data: { text: `prefix${secret}suffix` },
    });
    f.journal.append({
      id: "mcp-tool-result",
      at: 1,
      kind: "message",
      text: "",
      partial: false,
      tools: [
        {
          id: "tool-call",
          name: "test-tool",
          result: { output: [{ text: `prefix${secret}suffix` }], isError: false },
        },
      ],
    });
    f.journal.append({
      id: "mcp-opencode-proof",
      at: 1,
      kind: "other",
      type: "armada/opencodeMcp",
      data: {
        configurationRevision: receipt?.revision,
        callId: "native-call",
        result: { output: `prefix${secret}suffix`, isError: false },
      },
    });
    expect(f.journal.events().find(({ event }) => event.id === "mcp-opencode-proof")?.event).toMatchObject({
      data: { configurationRevision: receipt?.revision, callId: "native-call", result: { isError: false } },
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "provider_call", operation: "runtime.configureMcp", outcome: "ok" }),
    );
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

test("runtimes without stdio environment support cannot receive vault values", async () => {
  const { f, registry, service } = await fixture();
  try {
    const local = await registry.save(f.people.owner, f.people.org, {
      name: "local",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["@example/mcp@1.2.3"],
      stdioEnv: { MCP_PRIVATE_VALUE: crypto.randomUUID() },
    });
    await service.connections.bind(f.row.id, [local.id]);
    const old = createRuntimeMcp({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        async call(owner, command, options) {
          const reply = await f.bridge.call(owner, command, options);
          if (command.op !== "health") return reply;
          return { ...reply, body: { ...reply.body, result: { ready: true, generation: reply.epoch, mcpVersion: 1 } } };
        },
      },
    });
    await expect(old.prepare(f.caller, f.row.id)).rejects.toThrow(
      "Stdio MCP environment requires an updated runtime artifact.",
    );
    expect((await f.db.query("select 1 from mcp_bootstraps where sandbox_id=$1", [f.row.id])).rows).toEqual([]);
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
              await encryptSecret(JSON.stringify({ PREFIX: marker }), ENCRYPTION_KEY),
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

test("prepareMcp skips health RPC with matching observedHealth, enqueues configureMcp once, and avoids redundant SQL queries", async () => {
  const x = await fixture("modal"),
    { f } = x;
  try {
    const ops: string[] = [];
    const statements: string[] = [];
    const wrapSql = (sql: typeof f.sql) => {
      const wrapped: typeof f.sql = {
        query(statement, params) {
          statements.push(statement);
          return sql.query(statement, params);
        },
        ...(sql.transaction ? { transaction: (work) => sql.transaction!((tx) => work(wrapSql(tx))) } : {}),
      };
      return wrapped;
    };
    const tracked = createRuntimeMcp({
      sql: wrapSql(f.sql),
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: {
        ...f.bridge,
        call(owner, command, options) {
          ops.push(command.op);
          return f.bridge.call(owner, command, options);
        },
        callPrepared(owner, operation, prepare, provider, sandboxId) {
          ops.push(operation);
          return f.bridge.callPrepared(owner, operation, prepare, provider, sandboxId);
        },
      },
    });
    const receipt = await tracked.prepare(f.caller, f.row.id, undefined, undefined, undefined, {
      epoch: "1",
      ready: true,
      generation: "1",
      mcpVersion: 1,
      stdioMcpEnv: true,
    });
    expect(receipt?.revision).toBeTruthy();
    expect(ops).toEqual(["configureMcp"]);
    expect(statements.some((s) => s.includes("s.provider='docker' and s.owner_id"))).toBe(false);
    expect(statements.filter((s) => s.includes("insert into public.runtime_commands"))).toHaveLength(0);
    expect(statements.filter((s) => s.includes("select mcp_generation,expires_at from public.sandboxes"))).toHaveLength(
      3,
    );
    await f.db.query("update mcp_bootstraps set configured=false where sandbox_id=$1", [f.row.id]);
    ops.length = 0;
    await expect(
      tracked.prepare(f.caller, f.row.id, undefined, undefined, undefined, {
        epoch: "1",
        ready: true,
        generation: "1",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(ops).toEqual([]);
    await tracked.prepare(f.caller, f.row.id, undefined, undefined, undefined, {
      epoch: "0",
      ready: true,
      generation: "0",
      mcpVersion: 1,
    });
    expect(ops).toEqual(["health", "configureMcp"]);
  } finally {
    await f.close();
  }
});
