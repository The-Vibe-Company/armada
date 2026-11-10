import { expect, test } from "bun:test";
import { forwardControl } from "../../../apps/dashboard/src/app/api/v1/[...path]/control-proxy.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test("GitHub repair crosses the dashboard proxy with only the sandbox id and bearer", async () => {
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  let request: Request | undefined;
  let out = "";
  try {
    const code = await run(
      ["github", "refresh", "sandbox-id"],
      {
        out: (text) => {
          out += text;
        },
        err: () => {},
      },
      {
        auth: {
          out: (text) => {
            out += text;
          },
          err: () => {},
          env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => {},
          fetch: async (input, init) => {
            const incoming = new Request(input, init);
            expect(incoming.url).toBe("https://armada.test/api/v1/github/refresh");
            return forwardControl(
              incoming,
              new URL(incoming.url).pathname.slice("/api/v1/".length).split("/"),
              async (target, options) => {
                request = new Request(target, options);
                return Response.json({ id: "sandbox-id", login: "octocat", status: "connected" });
              },
            );
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(request?.url).toBe("https://control.test/api/v1/github/refresh");
    expect(request?.headers.get("authorization")).toBe("Bearer fixture-service-token");
    expect(await request?.json()).toEqual({ id: "sandbox-id" });
    expect(JSON.parse(out)).toEqual({ id: "sandbox-id", login: "octocat", status: "connected" });
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});

test.each([
  new Response("Not found", { status: 404 }),
  Response.json({ error: "Not found." }, { status: 404 }),
  Response.json({ error: { code: "not_found", message: "untrusted response" } }, { status: 404 }),
])("GitHub refresh explains missing proxy/server routes without echoing response text", async (response) => {
  let error = "";
  const code = await run(
    ["github", "refresh", "sandbox-id"],
    {
      out: () => {},
      err: (text) => {
        error += text;
      },
    },
    {
      auth: {
        out: () => {},
        err: (text) => {
          error += text;
        },
        env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async () => response,
      },
    },
  );
  expect(code).not.toBe(0);
  expect(error).toContain("dashboard/server route is not deployed");
  expect(error).toContain("sandbox");
  expect(error).not.toContain("untrusted response");
});
