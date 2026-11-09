import { describe, expect, test } from "bun:test";
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

const rpc = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });

describe("gateway", () => {
  test("a tool call initializes the session, carries the user's token and returns the tool's JSON", async () => {
    const { calls, gateway } = server(
      (call) => rpc(call.body.id, { content: [{ type: "text", text: JSON.stringify({ events: [], cursor: "9" }) }] }),
      "session-1",
    );
    const page = await sandboxGateway(gateway).logs("sandbox-1", "5");
    expect(page).toEqual({ events: [], cursor: "9" });
    expect(calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(calls[2]?.body.params).toEqual({ name: "logs", arguments: { id: "sandbox-1", since_cursor: "5" } });
    expect(calls[2]?.headers.authorization).toBe("Bearer user-jwt");
    expect(calls[2]?.headers["mcp-session-id"]).toBe("session-1");
  });

  test("send, steer and interrupt name their own tool and the chosen conversation", async () => {
    const { calls, gateway } = server((call) => rpc(call.body.id, { structuredContent: { ok: true } }));
    const sandbox = sandboxGateway(gateway);
    await sandbox.send("sandbox-9", "go", { reasoning_effort: "high" }, "conv-2");
    await sandbox.send("sandbox-9", "first");
    await sandbox.steer("sandbox-9", "use the fixture", "conv-2");
    await sandbox.interrupt("sandbox-9", "conv-2");
    const tools = calls.filter((call) => call.method === "tools/call").map((call) => call.body.params);
    expect(tools).toEqual([
      {
        name: "send",
        arguments: { id: "sandbox-9", prompt: "go", conversation_id: "conv-2", reasoning_effort: "high" },
      },
      { name: "send", arguments: { id: "sandbox-9", prompt: "first" } },
      { name: "steer", arguments: { id: "sandbox-9", text: "use the fixture", conversation_id: "conv-2" } },
      { name: "interrupt", arguments: { id: "sandbox-9", conversation_id: "conv-2" } },
    ]);
  });

  test("a reply sent as a server-sent event is read too", async () => {
    const { gateway } = server((call) => {
      const message = { jsonrpc: "2.0", id: call.body.id, result: { structuredContent: { ok: true } } };
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    expect(await sandboxGateway(gateway).stop("sandbox-1")).toEqual({ ok: true });
  });

  test("a tool error becomes a GatewayError, in plain words for a usage limit", async () => {
    const { gateway } = server((call) =>
      rpc(call.body.id, { isError: true, content: [{ type: "text", text: "usage_limit: weekly cap reached" }] }),
    );
    const error = await sandboxGateway(gateway)
      .send("sandbox-1", "go")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).message).toContain("hit its plan or billing limit");
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
