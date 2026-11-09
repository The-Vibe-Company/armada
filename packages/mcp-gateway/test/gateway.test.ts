import { expect, jest, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpGateway, createRemoteAuthResolver, type GatewayLease } from "../src/index.ts";

// Owner boundary: real SDK client -> gateway -> independent SDK server. Protects
// protocol payload/cursors and identity isolation, not a simulated success receipt.
test("SDK bridge carries tools/resources/prompts and isolates sessions, policies and revocation", async () => {
  const servers: McpServer[] = [];
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const lease: GatewayLease = {
    id: "lease-a",
    actorId: "actor-a",
    sandboxId: "sandbox",
    connectionId: "connection",
    expiresAt: 2000,
    url: "https://upstream.example/mcp",
    transport: "http",
  };
  let revoked = false;
  let calls = 0;
  const upstreamFetch: FetchLike = async (url, init) => {
    const request = new Request(String(url), init);
    expect(request.headers.get("authorization")).not.toBe("Bearer armada-fixture");
    if (request.headers.has("authorization"))
      expect(request.headers.get("authorization")).toBe("Bearer upstream-fixture");
    const id = request.headers.get("mcp-session-id");
    let transport = id ? transports.get(id) : undefined;
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        keepAliveMs: 0,
      });
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool("increment", {}, async () => ({ content: [{ type: "text", text: String(++calls) }] }));
      server.registerResource("document", "fixture://doc", {}, async (uri) => ({
        contents: [{ uri: uri.href, text: "document bytes" }],
      }));
      server.registerPrompt("review", {}, async () => ({
        messages: [{ role: "user", content: { type: "text", text: "review bytes" } }],
      }));
      await server.connect(transport);
      servers.push(server);
    }
    const response = await transport.handleRequest(request);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
    return response;
  };
  const resolved = await createRemoteAuthResolver({ fetch: upstreamFetch })({ url: lease.url, transport: "http" });
  expect(resolved).toMatchObject({ authType: "none", state: "reachable", serverInfo: { name: "fixture" } });
  const gateway = createMcpGateway({
    origin: "https://gateway.example",
    now: () => 1000,
    fetch: upstreamFetch,
    authorization: {
      authenticate: async (request) => ({
        ...lease,
        actorId: request.headers.get("authorization") === "Bearer other-fixture" ? "actor-b" : "actor-a",
      }),
      assertActive: async () => {
        if (revoked) throw Error("revoked");
      },
      allow: async (_lease, _direction, message) =>
        !(
          "method" in message &&
          message.method === "tools/call" &&
          "params" in message &&
          message.params?.name === "denied"
        ),
      upstreamHeaders: async () => new Headers({ authorization: "Bearer upstream-fixture" }),
    },
  });
  const transport = new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
    fetch: (url, init) => gateway.handle(new Request(String(url), init)),
    requestInit: { headers: { authorization: "Bearer armada-fixture" } },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["increment"]);
    expect((await client.callTool({ name: "increment" })).content).toEqual([{ type: "text", text: "1" }]);
    expect((await client.readResource({ uri: "fixture://doc" })).contents[0]).toMatchObject({ text: "document bytes" });
    expect((await client.listResources()).resources[0]?.uri).toBe("fixture://doc");
    expect((await client.listPrompts()).prompts[0]?.name).toBe("review");
    expect((await client.getPrompt({ name: "review" })).messages[0]?.content).toEqual({
      type: "text",
      text: "review bytes",
    });
    await expect(client.callTool({ name: "denied" })).rejects.toThrow("Operation denied");
    const crossed = await gateway.handle(
      new Request("https://gateway.example/mcp", {
        method: "GET",
        headers: {
          authorization: "Bearer other-fixture",
          "mcp-session-id": transport.sessionId ?? "",
          accept: "text/event-stream",
        },
      }),
    );
    expect(crossed.status).toBe(404);
    expect(calls).toBe(1);
    revoked = true;
    await gateway.invalidate("connection");
    expect((await gateway.handle(new Request("https://gateway.example/mcp"))).status).toBe(403);
  } finally {
    await client.close();
    await gateway.close();
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("legacy SSE bridge preserves paginated protocol results without replaying a mutating call", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const [remote, wire] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "legacy", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    request.params?.cursor === "second"
      ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
      : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "second" },
  );
  let mutations = 0;
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: String(++mutations) }],
  }));
  await server.connect(remote);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  wire.onmessage = (message) => {
    stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  };
  await wire.start();
  const gateway = createMcpGateway({
    origin: "https://gateway.example",
    now: () => 1,
    fetch: async (url, init) => {
      const request = new Request(String(url), init);
      if (request.method === "GET")
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      expect(new URL(request.url).pathname).toBe("/messages");
      await wire.send(
        (await import("@modelcontextprotocol/sdk/types.js")).JSONRPCMessageSchema.parse(await request.json()),
      );
      return new Response(null, { status: 202 });
    },
    authorization: {
      authenticate: async () => ({
        id: "legacy",
        actorId: "actor",
        sandboxId: "sandbox",
        connectionId: "connection",
        url: "https://legacy.example/sse",
        transport: "sse",
        expiresAt: 2000,
      }),
      assertActive: async () => {},
      allow: async () => true,
      upstreamHeaders: async () => new Headers(),
    },
  });
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
    fetch: (url, init) => gateway.handle(new Request(String(url), init)),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  try {
    await client.connect(transport);
    const first = await client.listTools();
    expect(first.nextCursor).toBe("second");
    expect((await client.listTools({ cursor: first.nextCursor })).tools[0]?.name).toBe("second");
    await client.callTool({ name: "first" });
    expect(mutations).toBe(1);
    expect(
      (await gateway.handle(new Request("https://gateway.example/mcp", { headers: { "last-event-id": "ambiguous" } })))
        .status,
    ).toBe(409);
    expect(mutations).toBe(1);
  } finally {
    await client.close();
    await gateway.close();
    await server.close();
  }
});

test("bridge rejects an upstream ignoring compatible version negotiation with an actionable protocol error", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { InitializeRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "newer-only", version: "1" });
  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: "2026-07-28",
    capabilities: {},
    serverInfo: { name: "newer-only", version: "1" },
  }));
  const upstream = new WebStandardStreamableHTTPServerTransport({ keepAliveMs: 0 });
  await server.connect(upstream);
  const gateway = createMcpGateway({
    origin: "https://gateway.example",
    fetch: (url, init) => upstream.handleRequest(new Request(String(url), init)),
    authorization: {
      authenticate: async () => ({
        id: "lease",
        actorId: "actor",
        sandboxId: "sandbox",
        connectionId: "connection",
        url: "https://upstream.example/mcp",
        transport: "http",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      assertActive: async () => {},
      allow: async () => true,
      upstreamHeaders: async () => new Headers(),
    },
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
          fetch: (url, init) => gateway.handle(new Request(String(url), init)),
        }),
      ),
    ).rejects.toThrow("configure a compatible endpoint");
  } finally {
    await client.close();
    await gateway.close();
    await server.close();
  }
});

// Raw downstream POST-only client: unlike SDK Client, it never opens GET SSE.
// The upstream is an actual SDK Server using request-scoped send helpers.
test("POST-only concurrent calls retain progress, sampling, elicitation and reply correlation", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, CreateMessageResultSchema, ElicitResultSchema, JSONRPCMessageSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const server = new Server({ name: "interactive", version: "1" }, { capabilities: { tools: {} } });
  const pending: { label: string; kind: string; result: Promise<unknown> }[] = [];
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const label = String(request.params.arguments?.label);
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: label, progress: 1 } });
    pending.push({
      label,
      kind: "sampling",
      result: extra.sendRequest(
        {
          method: "sampling/createMessage",
          params: { messages: [{ role: "user", content: { type: "text", text: label } }], maxTokens: 10 },
        },
        CreateMessageResultSchema,
      ),
    });
    pending.push({
      label,
      kind: "elicitation",
      result: extra.sendRequest(
        {
          method: "elicitation/create",
          params: { message: label, requestedSchema: { type: "object", properties: {} } },
        },
        ElicitResultSchema,
      ),
    });
    // Finish this finite POST stream after emitting requests, so a dropped event
    // fails assertions rather than hanging the regression on a wall-clock timeout.
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: label, progress: 2 } });
    return { content: [{ type: "text", text: label }] };
  });
  const upstream = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    keepAliveMs: 0,
  });
  await server.connect(upstream);
  const gateway = createMcpGateway({
    origin: "https://gateway.example",
    fetch: (url, init) => upstream.handleRequest(new Request(String(url), init)),
    authorization: {
      authenticate: async () => ({
        id: "lease",
        actorId: "actor",
        sandboxId: "sandbox",
        connectionId: "connection",
        url: "https://upstream.example/mcp",
        transport: "http",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      assertActive: async () => {},
      allow: async () => true,
      upstreamHeaders: async () => new Headers(),
    },
  });
  let sessionId: string | null = null;
  const post = (body: unknown) =>
    gateway.handle(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  async function messages(response: Response) {
    expect(response.status).toBe(200);
    return (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSONRPCMessageSchema.parse(JSON.parse(line.slice(6))));
  }
  try {
    const initialized = await post({
      jsonrpc: "2.0",
      id: 100,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { sampling: {}, elicitation: { form: {} } },
        clientInfo: { name: "post-only", version: "1" },
      },
    });
    sessionId = initialized.headers.get("mcp-session-id");
    await messages(initialized);
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const streams = await Promise.all(
      ["alpha", "beta"].map(async (label, index) => {
        const events = await messages(
          await post({
            jsonrpc: "2.0",
            id: 101 + index,
            method: "tools/call",
            params: { name: "interactive", arguments: { label }, _meta: { progressToken: label } },
          }),
        );
        return { label, events };
      }),
    );
    for (const { label, events } of streams) {
      expect(events.filter((event) => "method" in event).map((event) => event.method)).toEqual([
        "notifications/progress",
        "sampling/createMessage",
        "elicitation/create",
        "notifications/progress",
      ]);
      for (const event of events) {
        if (!("method" in event)) continue;
        if (event.method === "notifications/progress") {
          expect(event.params?.progressToken).toBe(label);
          continue;
        }
        expect("id" in event).toBe(true);
        if (!("id" in event)) throw Error("Missing server request ID");
        if (event.method === "sampling/createMessage") {
          expect(event.params?.messages).toEqual([{ role: "user", content: { type: "text", text: label } }]);
          expect(
            (
              await post({
                jsonrpc: "2.0",
                id: event.id,
                result: { role: "assistant", content: { type: "text", text: label }, model: "fixture-model" },
              })
            ).status,
          ).toBe(202);
        } else {
          expect(event.params?.message).toBe(label);
          expect(
            (await post({ jsonrpc: "2.0", id: event.id, result: { action: "accept", content: { label } } })).status,
          ).toBe(202);
        }
      }
    }
    for (const request of pending)
      expect(await request.result).toMatchObject(
        request.kind === "sampling" ? { content: { text: request.label } } : { content: { label: request.label } },
      );
  } finally {
    const settled = Promise.allSettled(pending.map((request) => request.result));
    await gateway.close();
    await server.close();
    await settled;
  }
});

async function lifecycleFixture(
  refuseDelete = false,
  cleanup: {
    cleanupTimeoutMs?: number;
    deletePeer?: (signal: AbortSignal | undefined) => Promise<Response>;
  } = {},
) {
  let credentialsRevoked = false;
  let gotUpstreamGet!: () => void;
  const upstreamGet = new Promise<void>((resolve) => {
    gotUpstreamGet = resolve;
  });
  const starts = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const releases: (() => void)[] = [];
  const entered = ["left", "right"].map((label) => {
    gates.set(
      label,
      new Promise((resolve) => {
        releases.push(resolve);
      }),
    );
    return new Promise<void>((resolve) => {
      starts.set(label, resolve);
    });
  });
  const server = new McpServer({ name: "lifecycle", version: "1" });
  server.registerTool("held", {}, async (extra) => {
    const label = String(extra._meta?.progressToken);
    starts.get(label)?.();
    await gates.get(label);
    return { content: [{ type: "text", text: label }] };
  });
  let deletes = 0;
  let retired = 0;
  const upstream = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    keepAliveMs: 0,
    onsessionclosed: () => {
      retired++;
    },
  });
  await server.connect(upstream);
  const gateway = createMcpGateway({
    origin: "https://gateway.example",
    ...(cleanup.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: cleanup.cleanupTimeoutMs }),
    fetch: async (url, init) => {
      if (init?.method === "DELETE") {
        deletes++;
        if (cleanup.deletePeer) return cleanup.deletePeer(init.signal ?? undefined);
        if (refuseDelete) return Promise.resolve(new Response(null, { status: 405 }));
      }
      const response = await upstream.handleRequest(new Request(String(url), init));
      if (init?.method === "GET") gotUpstreamGet();
      return response;
    },
    authorization: {
      authenticate: async () => ({
        id: "lease",
        actorId: "actor",
        sandboxId: "sandbox",
        connectionId: "connection",
        url: "https://upstream.example/mcp",
        transport: "http",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      assertActive: async () => {},
      allow: async () => true,
      upstreamHeaders: async () => {
        if (credentialsRevoked) throw Error("grant revoked");
        return new Headers();
      },
    },
  });
  let sessionId: string | null = null;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
  });
  const request = (method: string, signal?: AbortSignal, body?: unknown) =>
    gateway.handle(
      new Request("https://gateway.example/mcp", {
        method,
        headers: headers(),
        ...(signal ? { signal } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const initialized = await request("POST", undefined, {
    jsonrpc: "2.0",
    id: 100,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
  });
  sessionId = initialized.headers.get("mcp-session-id");
  await initialized.text();
  await request("POST", undefined, { jsonrpc: "2.0", method: "notifications/initialized" });
  await upstreamGet;
  return {
    request,
    revokeCredentials: () => {
      credentialsRevoked = true;
    },
    entered,
    releases,
    counts: () => ({ deletes, retired }),
    gateway,
    async close() {
      for (const release of releases) release();
      await gateway.close();
      await server.close();
    },
  };
}

for (const disconnect of ["GET", "POST"] as const) {
  test(`${disconnect} disconnect does not cancel concurrent calls or destroy the MCP session`, async () => {
    const f = await lifecycleFixture();
    const aborted = new AbortController();
    try {
      const left = await f.request("POST", disconnect === "POST" ? aborted.signal : undefined, {
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "held", _meta: { progressToken: "left" } },
      });
      const right = await f.request("POST", undefined, {
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "held", _meta: { progressToken: "right" } },
      });
      await Promise.all(f.entered);
      const disconnected = disconnect === "GET" ? await f.request("GET", aborted.signal) : left;
      aborted.abort();
      await disconnected.body?.cancel();
      for (const release of f.releases) release();
      expect(await right.text()).toContain('"text":"right"');
      if (disconnect === "GET") expect(await left.text()).toContain('"text":"left"');
      // Still the same live session, not a replacement/replayed initialize.
      const listed = await f.request("POST", undefined, { jsonrpc: "2.0", id: 103, method: "tools/list" });
      expect(listed.status).toBe(200);
      expect(await listed.text()).toContain('"name":"held"');
      expect(f.counts().deletes).toBe(0);
    } finally {
      await f.close();
    }
  });
}

for (const refuseDelete of [false, true]) {
  test(`explicit downstream DELETE terminates upstream HTTP session (405=${refuseDelete})`, async () => {
    const f = await lifecycleFixture(refuseDelete);
    try {
      expect((await f.request("DELETE")).status).toBe(200);
      expect(f.counts()).toEqual({ deletes: 1, retired: refuseDelete ? 0 : 1 });
      expect((await f.request("GET")).status).toBe(404);
    } finally {
      await f.close();
    }
  });
}

test("explicit DELETE still closes locally if revoked upstream credentials prevent remote cleanup", async () => {
  const f = await lifecycleFixture();
  try {
    f.revokeCredentials();
    expect((await f.request("DELETE")).status).toBe(200);
    expect(f.counts().deletes).toBe(0);
    expect((await f.request("GET")).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("unresponsive upstream DELETE has a cleanup-owned abort deadline and cannot retain the local session", async () => {
  async function advance(milliseconds: number) {
    jest.advanceTimersByTime(milliseconds);
    // Settle the deadline's promise continuations, never a real wall timer.
    await Promise.resolve();
    await Promise.resolve();
  }
  let entered!: () => void;
  const peerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rejectPeer!: (error: Error) => void;
  const peerResponse = new Promise<Response>((_resolve, reject) => {
    rejectPeer = reject;
  });
  let peerSignal: AbortSignal | undefined;
  const f = await lifecycleFixture(false, {
    cleanupTimeoutMs: 30,
    deletePeer: (signal) => {
      peerSignal = signal;
      entered();
      return peerResponse;
    },
  });
  jest.useFakeTimers();
  let deletion: Promise<Response> | undefined;
  try {
    const held = await f.request("POST", undefined, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "held", _meta: { progressToken: "left" } },
    });
    await f.entered[0];
    deletion = f.request("DELETE");
    await peerEntered;
    await advance(29);
    const before = await f.request("POST", undefined, { jsonrpc: "2.0", id: 102, method: "tools/list" });
    expect(before.status).toBe(200);
    await before.text();
    expect(peerSignal?.aborted).toBe(false);
    await advance(1);
    const after = await f.request("GET");
    await after.body?.cancel();
    expect(after.status).toBe(404);
    expect((await deletion).status).toBe(200);
    expect(peerSignal?.aborted).toBe(true);
    expect(await held.text()).toBe("");
    expect(f.counts()).toEqual({ deletes: 1, retired: 0 });
    // Even an injected peer ignoring AbortSignal and rejecting later is observed;
    // the DELETE is neither replayed nor awaited past the local deadline.
    rejectPeer(Error("late remote failure"));
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    try {
      rejectPeer(Error("fixture stopped"));
      await f.close();
      await deletion?.catch(() => {});
    } finally {
      jest.useRealTimers();
    }
  }
});
