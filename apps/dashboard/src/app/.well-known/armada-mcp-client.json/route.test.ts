import { afterEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET } from "./route.ts";

const previousMcpUrl = process.env.ARMADA_MCP_URL;
const VALID_CIMD = {
  client_id: "https://armada.example/.well-known/armada-mcp-client.json",
  client_name: "Armada",
  redirect_uris: ["https://armada.example/auth/mcp/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  if (previousMcpUrl === undefined) delete process.env.ARMADA_MCP_URL;
  else process.env.ARMADA_MCP_URL = previousMcpUrl;
});

function stubFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Supply deterministic upstream CIMD responses without network sockets or a test-only route seam.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(handler as typeof fetch);
  return fetchSpy;
}

test("returns upstream CIMD JSON with public cache header and never forwards caller authority headers", async () => {
  process.env.ARMADA_MCP_URL = "https://mcp.armada.test/mcp";
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  stubFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(VALID_CIMD);
  });

  const request = new NextRequest("https://armada.example/.well-known/armada-mcp-client.json", {
    headers: {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      cookie: "sb-project-auth-token=secret",
      authorization: "Bearer secret",
    },
  });
  const response = await GET(request);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await response.json()).toEqual(VALID_CIMD);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://mcp.armada.test/.well-known/armada-mcp-client.json");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.redirect).toBe("error");
  const sentHeaders = new Headers(calls[0]?.init?.headers);
  expect([...sentHeaders.keys()]).toEqual(["accept"]);
});

test("rejects query strings with 404 and empty body without contacting upstream", async () => {
  process.env.ARMADA_MCP_URL = "https://mcp.armada.test";
  const spy = stubFetch(async () => Response.json(VALID_CIMD));

  for (const url of [
    "https://armada.example/.well-known/armada-mcp-client.json?redirect_uri=https://evil.example",
    "https://armada.example/.well-known/armada-mcp-client.json?client_id=https://evil.example",
  ]) {
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  }
  expect(spy).not.toHaveBeenCalled();
});

test("returns 503 without leaking details when ARMADA_MCP_URL is missing or invalid", async () => {
  const spy = stubFetch(async () => Response.json(VALID_CIMD));

  for (const value of [undefined, "", "not-a-url", "ftp://mcp.armada.test", "https://user:pass@mcp.armada.test"]) {
    if (value === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = value;
    const response = await GET(new NextRequest("https://armada.example/.well-known/armada-mcp-client.json"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  expect(spy).not.toHaveBeenCalled();
});

test("returns 503 without leaking details when upstream fails or returns invalid CIMD", async () => {
  process.env.ARMADA_MCP_URL = "https://mcp.armada.test";
  const cases: Array<() => Promise<Response>> = [
    async () => new Response("internal stack trace", { status: 500 }),
    async () => new Response("not found", { status: 404 }),
    async () => new Response("not-json", { status: 200 }),
    async () => Response.json({ client_id: "https://armada.example/.well-known/armada-mcp-client.json" }),
    async () => Response.json({ client_id: "", redirect_uris: ["https://armada.example/auth/mcp/callback"] }),
    async () =>
      Response.json({ client_id: "https://armada.example/.well-known/armada-mcp-client.json", redirect_uris: [] }),
    async () => {
      throw new TypeError("redirect error");
    },
  ];

  for (const responder of cases) {
    fetchSpy?.mockRestore();
    stubFetch(responder);
    const response = await GET(new NextRequest("https://armada.example/.well-known/armada-mcp-client.json"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
});
