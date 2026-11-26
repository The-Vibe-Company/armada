import { describe, expect, test } from "bun:test";
import { ControlError, createControlClient } from "./control.ts";
import { GatewayError, sandboxGateway } from "./gateway.ts";

type Seen = { method: string; url: string; headers: Headers; body: unknown };

function restServer(reply: (request: Seen) => Response) {
  const calls: Seen[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const raw = request.body ? await request.text() : null;
    const seen: Seen = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    calls.push(seen);
    return reply(seen);
  }) as typeof fetch;
  const control = createControlClient({
    serverUrl: "https://mcp.example/mcp",
    token: "user-jwt",
    fetch: fakeFetch,
  });
  return { calls, sandbox: sandboxGateway(control) };
}

describe("gateway", () => {
  for (const operation of ["delete", "extend"] as const) {
    test(`sandbox ${operation} uses the existing authenticated REST operation`, async () => {
      const { calls, sandbox } = restServer(() =>
        Response.json(
          operation === "delete"
            ? { id: "sandbox-1", status: "deleted" }
            : { id: "sandbox-1", expiresAt: "2026-11-19T08:00:00Z", ttlSeconds: 7200 },
        ),
      );
      const id = "sandbox-1";
      const ttlSeconds = 7200;
      if (operation === "delete") await sandbox.delete(id);
      else await sandbox.extend(id, ttlSeconds);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe(operation === "delete" ? "DELETE" : "POST");
      expect(calls[0]?.url).toBe(
        `https://mcp.example/api/v1/${operation === "delete" ? `sandboxes/${id}` : "sandbox/extend"}`,
      );
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer user-jwt");
      if (operation === "delete") expect(calls[0]?.body).toBeNull();
      else expect(calls[0]?.body).toEqual({ id, ttlSeconds });
    });
  }

  test("relayTicket posts to /api/v1/sandboxes/:id/relay-ticket and validates the response", async () => {
    const valid = {
      ticket: "armada_relay_abc",
      wsUrl: "wss://mcp.example/api/v1/relay/ws",
      bootstrapUrl: "https://mcp.example/api/v1/relay/preview/enter",
      previewUrl: "https://mcp.example/api/v1/sandboxes/sandbox-1/ports/3000/",
      expiresAt: "2026-11-26T01:00:00Z",
    };
    const { calls, sandbox } = restServer(() => Response.json(valid));
    const ticket = await sandbox.relayTicket("sandbox-1", { mode: "preview", port: 3000, org: "org-1" });
    expect(ticket).toEqual(valid);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://mcp.example/api/v1/sandboxes/sandbox-1/relay-ticket");
    expect(calls[0]?.body).toEqual({ mode: "preview", port: 3000, org: "org-1" });

    const { sandbox: bad } = restServer(() => Response.json({ ticket: "missing-urls" }));
    await expect(bad.relayTicket("sandbox-1", { mode: "pty" })).rejects.toThrow("unreadable relay ticket");
  });

  test("an unreadable REST success cannot confirm sandbox deletion or extension", async () => {
    const { sandbox } = restServer(() => new Response("unreadable"));
    for (const call of [() => sandbox.delete("sandbox-1"), () => sandbox.extend("sandbox-1", 7200)]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ControlError);
      expect(error).toMatchObject({ outcomeUnknown: true });
    }
  });

  test("logs reads via a single 1-RTT REST request carrying cursor, pagination and bearer token", async () => {
    const { calls, sandbox } = restServer(() => Response.json({ events: [], cursor: "9", hasMore: false }));
    const page = await sandbox.logs("sandbox-1", "5", { limit: 200, coalesce: true, direction: "backward" });
    expect(page).toEqual({ events: [], cursor: "9", hasMore: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://mcp.example/api/v1/logs/read");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer user-jwt");
    expect(calls[0]?.body).toEqual({
      id: "sandbox-1",
      cursor: "5",
      limit: 200,
      coalesce: true,
      direction: "backward",
    });
  });

  test("send, steer, interrupt, stop, exec and status each make one 1-RTT REST call", async () => {
    const { calls, sandbox } = restServer(() => Response.json({ ok: true }));
    await sandbox.send("sandbox-9", "go", { reasoning_effort: "high" });
    await sandbox.send("sandbox-9", "first");
    await sandbox.send("sandbox-9", "again", {}, "request-1");
    await sandbox.steer("sandbox-9", "use the fixture");
    await sandbox.interrupt("sandbox-9");
    await sandbox.stop("sandbox-9");
    await sandbox.exec("sandbox-9", "git status", 30);
    await sandbox.status("sandbox-9", "request-1");
    expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/send",
        body: { id: "sandbox-9", prompt: "go", reasoning_effort: "high" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/send",
        body: { id: "sandbox-9", prompt: "first" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/send",
        body: { id: "sandbox-9", prompt: "again", request_id: "request-1" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/steer",
        body: { id: "sandbox-9", text: "use the fixture" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/interrupt",
        body: { id: "sandbox-9" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/stop",
        body: { id: "sandbox-9" },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/exec",
        body: { id: "sandbox-9", command: "git status", timeout_seconds: 30 },
      },
      {
        method: "POST",
        url: "https://mcp.example/api/v1/sandbox/status",
        body: { id: "sandbox-9", prompt_id: "request-1" },
      },
    ]);
  });

  test("a structured REST error becomes a GatewayError, in plain words for a usage limit", async () => {
    const { sandbox } = restServer(() =>
      Response.json({ error: { code: "usage_limit", message: "weekly cap reached" } }, { status: 429 }),
    );
    const error = await sandbox.send("sandbox-1", "go").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      status: 429,
      code: "usage_limit",
      message: expect.stringContaining("hit its plan or billing limit"),
    });
  });

  test("a structured REST error keeps the server's typed code next to its words", async () => {
    const { sandbox } = restServer(() =>
      Response.json(
        {
          error: { code: "credential_binding_required", message: "This legacy Modal sandbox has no account binding." },
        },
        { status: 409 },
      ),
    );
    const error = await sandbox.send("sandbox-1", "go").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 409,
      code: "credential_binding_required",
      message: "This legacy Modal sandbox has no account binding.",
    });
  });

  test("a gateway outage gives recovery guidance without exposing the proxy response", async () => {
    const { sandbox } = restServer(() => new Response("Private proxy diagnostics", { status: 503 }));
    const error = await sandbox.stop("sandbox-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    const { status, message } = error as GatewayError;
    expect(status).toBe(503);
    expect(message).toContain("Reload to check the current state before retrying.");
    expect(message).not.toContain("Private proxy diagnostics");
  });

  test("an unreadable 200 REST response throws a GatewayError", async () => {
    const { sandbox } = restServer(() => new Response("<html>proxy</html>", { status: 200 }));
    await expect(sandbox.logs("sandbox-1")).rejects.toThrow("unreadable");
  });

  test("a refused session and an unreachable server are told apart", async () => {
    const { sandbox: refused } = restServer(() => new Response("no", { status: 401 }));
    await expect(refused.logs("sandbox-1")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Sign in again"),
    });

    const down = sandboxGateway(
      createControlClient({
        serverUrl: "https://mcp.example/mcp",
        token: "t",
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      }),
    );
    await expect(down.logs("sandbox-1")).rejects.toThrow("unreachable");
  });
});
