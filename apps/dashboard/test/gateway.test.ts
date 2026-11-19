import { describe, expect, test } from "bun:test";
import { createControlClient } from "../src/lib/control.ts";
import { createGateway, GatewayError, sandboxGateway } from "../src/lib/gateway.ts";

type Call = { method: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fake MCP server: answers initialize, accepts the initialized notification, then answers tools/call. */
function server(reply: (call: Call) => Response, sessionId?: string) {
  const calls: Call[] = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const call: Call = { method: String(body.method), headers: init?.headers as Record<string, string>, body };
    calls.push(call);
    if (call.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      });
    }
    if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
    return reply(call);
  }) as typeof fetch;
  return { calls, gateway: createGateway({ url: "https://mcp.example/mcp", token: "user-jwt", fetch: fakeFetch }) };
}

const unexpectedControl = {
  async post<T>(): Promise<T> {
    throw new Error("Unexpected REST request");
  },
};

const rpc = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });

describe("gateway", () => {
  for (const operation of ["delete", "extend"] as const) {
    test(`sandbox ${operation} uses the existing authenticated REST operation`, async () => {
      const seen: Request[] = [];
      const { calls, gateway } = server((call) =>
        rpc(call.body.id, { isError: true, content: [{ type: "text", text: "Unknown tool" }] }),
      );
      const control = createControlClient({
        serverUrl: "https://mcp.example/mcp",
        token: "user-jwt",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push(new Request(input, init));
          return Response.json({ id: "sandbox-1" });
        }) as typeof fetch,
      });
      const sandbox = sandboxGateway(gateway, control);
      const id = "sandbox-1";
      const ttlSeconds = 7200;
      if (operation === "delete") await sandbox.delete(id);
      else await sandbox.extend(id, ttlSeconds);
      expect(calls).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.url).toBe(`https://mcp.example/api/v1/sandbox/${operation}`);
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer user-jwt");
      expect(await seen[0]?.json()).toEqual(operation === "delete" ? { id } : { id, ttlSeconds });
    });
  }

  test("a tool call initializes the session, carries the user's token and returns the tool's JSON", async () => {
    const { calls, gateway } = server(
      (call) => rpc(call.body.id, { content: [{ type: "text", text: JSON.stringify({ events: [], cursor: "9" }) }] }),
      "session-1",
    );
    const page = await sandboxGateway(gateway, unexpectedControl).logs("sandbox-1", "5");
    expect(page).toEqual({ events: [], cursor: "9" });
    expect(calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(calls[2]?.body.params).toEqual({ name: "logs", arguments: { id: "sandbox-1", since_cursor: "5" } });
    expect(calls[2]?.headers.authorization).toBe("Bearer user-jwt");
    expect(calls[2]?.headers["mcp-session-id"]).toBe("session-1");
  });

  test("send, steer and interrupt address the sandbox without a conversation selector", async () => {
    const { calls, gateway } = server((call) => rpc(call.body.id, { structuredContent: { ok: true } }));
    const sandbox = sandboxGateway(gateway, unexpectedControl);
    await sandbox.send("sandbox-9", "go", { reasoning_effort: "high" });
    await sandbox.send("sandbox-9", "first");
    await sandbox.send("sandbox-9", "again", {}, "request-1");
    await sandbox.steer("sandbox-9", "use the fixture");
    await sandbox.interrupt("sandbox-9");
    const tools = calls.filter((call) => call.method === "tools/call").map((call) => call.body.params);
    expect(tools).toEqual([
      {
        name: "send",
        arguments: { id: "sandbox-9", prompt: "go", reasoning_effort: "high" },
      },
      { name: "send", arguments: { id: "sandbox-9", prompt: "first" } },
      {
        name: "send",
        arguments: { id: "sandbox-9", prompt: "again", request_id: "request-1" },
      },
      { name: "send", arguments: { id: "sandbox-9", prompt: "use the fixture", steer: true } },
      { name: "stop", arguments: { id: "sandbox-9", turn: true } },
    ]);
  });

  test("a reply sent as a server-sent event is read too", async () => {
    const { gateway } = server((call) => {
      const message = { jsonrpc: "2.0", id: call.body.id, result: { structuredContent: { ok: true } } };
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    expect(await sandboxGateway(gateway, unexpectedControl).stop("sandbox-1")).toEqual({ ok: true });
  });

  test("a tool error becomes a GatewayError, in plain words for a usage limit", async () => {
    const { gateway } = server((call) =>
      rpc(call.body.id, {
        isError: true,
        content: [
          { type: "text", text: "weekly cap reached" },
          { type: "text", text: "error code: usage_limit" },
        ],
      }),
    );
    const error = await sandboxGateway(gateway, unexpectedControl)
      .send("sandbox-1", "go")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).message).toContain("hit its plan or billing limit");
  });

  test("a tool error keeps the server's typed code next to its words", async () => {
    const { gateway } = server((call) =>
      rpc(call.body.id, {
        isError: true,
        content: [
          { type: "text", text: "This legacy Modal sandbox has no account binding." },
          { type: "text", text: "error code: credential_binding_required" },
        ],
      }),
    );
    const error = await sandboxGateway(gateway, unexpectedControl)
      .send("sandbox-1", "go")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "credential_binding_required",
      message: "This legacy Modal sandbox has no account binding.",
    });
  });

  test("a gateway outage gives recovery guidance without exposing the proxy response", async () => {
    const gateway = createGateway({
      url: "https://mcp.example/mcp",
      token: "user-jwt",
      fetch: async () => new Response("Private proxy diagnostics", { status: 503 }),
    });
    const error = await gateway.call("stop", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    const { status, message } = error as GatewayError;
    expect(status).toBe(503);
    expect(message).toContain("Reload to check the current state before retrying.");
    expect(message).not.toContain("Private proxy diagnostics");
  });

  test("a refused session and an unreachable server are told apart", async () => {
    const refused = createGateway({
      url: "https://mcp.example/mcp",
      token: "stale",
      fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(refused.call("logs", {})).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Sign in again"),
    });

    const down = createGateway({
      url: "https://mcp.example/mcp",
      token: "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.call("logs", {})).rejects.toThrow("unreachable");
  });
});
