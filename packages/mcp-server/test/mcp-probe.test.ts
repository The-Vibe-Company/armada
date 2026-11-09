import { expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GatewayError } from "../../mcp-gateway/src/index.ts";
import { probeRemoteMcp } from "../src/mcp-probe.ts";

function fixture(mode: string) {
  const servers: Server[] = [],
    transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const calls = { tools: 0, resources: 0, prompts: 0 };
  let deletes = 0;
  let begin = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(String(input), init),
      id = request.headers.get("mcp-session-id");
    if (request.method === "DELETE") deletes++;
    let transport = id ? transports.get(id) : undefined;
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        keepAliveMs: 0,
      });
      const server = new Server(
        { name: "Independent inventory fixture", version: "1" },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        calls.tools++;
        if (mode === "cancel") {
          begin();
          await paused;
        }
        const size = mode === "aggregate" ? 6000 : 1;
        return {
          tools: Array.from({ length: size }, (_, i) => ({
            name: `t_${i}`,
            inputSchema: { type: "object" as const },
            ...(mode === "bytes" ? { description: "x".repeat(4 * 1024 * 1024) } : {}),
          })),
          ...(mode === "tools"
            ? { nextCursor: "repeated" }
            : mode === "pages"
              ? { nextCursor: String(calls.tools) }
              : mode === "cursor"
                ? { nextCursor: "x".repeat(2049) }
                : {}),
        };
      });
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        calls.resources++;
        return {
          resources: Array.from({ length: mode === "aggregate" ? 5000 : 1 }, (_, i) => ({
            name: `r_${i}`,
            uri: `fixture://document/${i}`,
          })),
          ...(mode === "resources" ? { nextCursor: "repeated" } : {}),
        };
      });
      server.setRequestHandler(ListPromptsRequestSchema, async () => {
        calls.prompts++;
        return { prompts: [{ name: "review" }], ...(mode === "prompts" ? { nextCursor: "repeated" } : {}) };
      });
      await server.connect(transport);
      servers.push(server);
    }
    const response = await transport.handleRequest(request);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
    return response;
  };
  return {
    fetch,
    calls,
    started,
    release: () => release(),
    deletes: () => deletes,
    close: async () => {
      release();
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}
for (const category of ["tools", "resources", "prompts"] as const)
  test(`inventory probe rejects cyclic ${category} pagination and terminates its upstream session`, async () => {
    const server = fixture(category);
    try {
      try {
        await probeRemoteMcp({
          url: "https://fixture.example/mcp",
          transport: "http",
          headers: new Headers(),
          fetch: server.fetch,
        });
        throw Error("Expected typed probe failure");
      } catch (error) {
        expect(error instanceof GatewayError).toBe(true);
        if (!(error instanceof GatewayError)) throw error;
        expect(error.code).toBe("unsupported");
        expect(error.action).toContain("repeated");
      }
      expect(server.calls[category]).toBe(2);
      expect(server.deletes()).toBe(1);
    } finally {
      await server.close();
    }
  });
for (const [mode, action] of [
  ["pages", "64 pages"],
  ["aggregate", "10000 items"],
  ["cursor", "oversized"],
  ["bytes", "4 MiB"],
] as const)
  test(`inventory probe bounds ${mode} without partial counts or a leaked session`, async () => {
    const server = fixture(mode);
    try {
      try {
        await probeRemoteMcp({
          url: "https://fixture.example/mcp",
          transport: "http",
          headers: new Headers(),
          fetch: server.fetch,
        });
        throw Error("Expected typed probe failure");
      } catch (error) {
        expect(error instanceof GatewayError).toBe(true);
        if (!(error instanceof GatewayError)) throw error;
        expect(error.code).toBe("unsupported");
        expect(error.action).toContain(action);
      }
      if (mode === "pages") expect(server.calls.tools).toBe(64);
      expect(server.deletes()).toBe(1);
    } finally {
      await server.close();
    }
  });
test("an aborted whole inventory operation interrupts a stalled list and cleans up without wall-clock waits", async () => {
  const server = fixture("cancel"),
    controller = new AbortController();
  const probe = probeRemoteMcp({
    url: "https://fixture.example/mcp",
    transport: "http",
    headers: new Headers(),
    fetch: server.fetch,
    signal: controller.signal,
  });
  try {
    await server.started;
    controller.abort();
    try {
      await probe;
      throw Error("Expected typed cancellation");
    } catch (error) {
      expect(error instanceof GatewayError).toBe(true);
      if (!(error instanceof GatewayError)) throw error;
      expect(error.code).toBe("upstream");
    }
    expect(server.deletes()).toBe(1);
  } finally {
    server.release();
    await probe.catch(() => {});
    await server.close();
  }
});
