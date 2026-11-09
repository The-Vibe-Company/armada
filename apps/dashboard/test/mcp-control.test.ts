import { describe, expect, test } from "bun:test";
import { ControlError, createMcpControl } from "../src/lib/control.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const OTHER_ORG = "00000000-0000-4000-8000-000000000011";
const ID = "00000000-0000-4000-8000-000000000050";

const dto = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  name: "Linear",
  orgId: ORG,
  scope: "personal",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  authType: "oauth",
  status: "not_connected",
  ...overrides,
});

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** A fake Armada server answering every control call with `reply`. */
function server(reply: (operation: string, body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return reply(String(url).split("/").pop() ?? "", body);
  }) as typeof fetch;
  const control = createMcpControl({ serverUrl: "https://armada.example/mcp", token: "user-jwt", fetch: fakeFetch });
  return { calls, control };
}

describe("MCP control client", () => {
  test("create posts the org-scoped request with the user's bearer and returns only contract fields", async () => {
    const { calls, control } = server(() =>
      // A server that wrongly echoed a secret: the client must not hand it to the page.
      Response.json({ connection: dto({ authType: "bearer", authentication: "leaked", bearerToken: "leaked" }) }),
    );
    const request = {
      org: ORG,
      scope: "personal" as const,
      name: "Linear",
      transport: "http" as const,
      url: "https://mcp.linear.app/mcp",
      args: [],
      authType: "bearer" as const,
      authentication: "sk-test",
    };
    const created = await control.create(request);
    expect(calls).toEqual([
      {
        url: "https://armada.example/api/v1/mcp/create",
        headers: { "content-type": "application/json", authorization: "Bearer user-jwt" },
        body: request,
      },
    ]);
    expect(created).toEqual(dto({ authType: "bearer" }) as never);
    expect(JSON.stringify(created)).not.toContain("leaked");
  });

  test("list keeps valid rows of the requested org only", async () => {
    const { control } = server(() =>
      Response.json({
        connections: [
          dto(),
          dto({ id: "00000000-0000-4000-8000-000000000051", orgId: OTHER_ORG }),
          dto({ id: "not-a-uuid" }),
          dto({ id: "00000000-0000-4000-8000-000000000052", status: "mystery" }),
        ],
      }),
    );
    expect((await control.list(ORG)).map((row) => row.id)).toEqual([ID]);
  });

  test("connect returns a safe authorization URL and refuses an unsafe one", async () => {
    let authorizationUrl: unknown = "https://auth.linear.app/authorize?state=s";
    const { control } = server(() => Response.json({ connection: dto(), authorizationUrl }));
    expect(await control.connect({ org: ORG, id: ID })).toMatchObject({ authorizationUrl });
    for (authorizationUrl of ["javascript:alert(1)", "http://auth.example/authorize", "https://u:p@auth.example/"]) {
      await expect(control.connect({ org: ORG, id: ID })).rejects.toThrow("refused as unsafe");
    }
    authorizationUrl = undefined;
    expect(await control.connect({ org: ORG, id: ID })).toMatchObject({ authorizationUrl: null });
  });

  test("sandbox-connections keeps the sandbox org's valid rows", async () => {
    const { calls, control } = server(() =>
      Response.json({ connections: [dto(), dto({ id: "00000000-0000-4000-8000-000000000051", orgId: OTHER_ORG })] }),
    );
    const sandbox = "00000000-0000-4000-8000-000000000030";
    expect(await control.sandboxConnections({ org: ORG, id: sandbox })).toEqual([dto() as never]);
    expect(calls[0]).toMatchObject({
      url: "https://armada.example/api/v1/mcp/sandbox-connections",
      body: { org: ORG, id: sandbox },
    });
  });

  test("set-enabled and the OAuth callback post their agreed bodies and return the stored connection", async () => {
    const { calls, control } = server((operation) =>
      Response.json({ connection: dto({ status: operation === "set-enabled" ? "disabled" : "connected" }) }),
    );
    expect((await control.setEnabled({ org: ORG, id: ID, enabled: false })).status).toBe("disabled");
    const back = await control.oauthCallback({ state: "state-1234", code: "c", issuer: "https://auth.example" });
    expect(back.status).toBe("connected");
    expect(calls.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: "https://armada.example/api/v1/mcp/set-enabled", body: { org: ORG, id: ID, enabled: false } },
      {
        url: "https://armada.example/api/v1/mcp/oauth/callback",
        body: { state: "state-1234", code: "c", issuer: "https://auth.example" },
      },
    ]);
  });

  test("revoke and delete need the server's explicit confirmation", async () => {
    let answer: unknown = { ok: true };
    const { control } = server(() => Response.json(answer));
    await control.revoke({ org: ORG, id: ID });
    answer = {};
    await expect(control.delete({ org: ORG, id: ID })).rejects.toThrow("did not confirm");
  });

  test.each([
    [401, { error: { code: "unauthorized", message: "token expired" } }, "Sign in again."],
    [403, { error: { code: "forbidden", message: "Only an org admin changes org connections." } }, "Only an org admin"],
    [404, { error: { code: "not_found", message: "Unknown route." } }, "does not offer MCP connections yet"],
    [409, { error: { code: "conflict", message: "A connection with that name exists." } }, "name exists"],
    [500, "<html>", "could not complete the request"],
  ])("a %i answer becomes a ControlError the person can read", async (status, body, expected) => {
    const { control } = server(() =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    );
    const error = await control.list(ORG).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).message).toContain(expected);
  });

  test("an unreachable server is reported without detail", async () => {
    const control = createMcpControl({
      serverUrl: "https://armada.example/mcp",
      token: "user-jwt",
      fetch: (async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(control.status({ org: ORG, id: ID })).rejects.toThrow("The Armada server is unreachable.");
  });
});
