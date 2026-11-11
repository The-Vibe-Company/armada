import { expect, test } from "bun:test";
import { run } from "../../../packages/cli/src/run.ts";
import { memorySessionStore } from "../../../packages/cli/src/session.ts";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";

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
            const incoming = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
            expect(incoming.url).toBe("https://armada.test/api/v1/github/refresh");
            return forwardControl(
              incoming,
              new URL(incoming.url).pathname.slice("/api/v1/".length).split("/"),
              Object.assign(
                async (target: string | URL | Request, options?: RequestInit) => {
                  request =
                    target instanceof Request ? new Request(target, options) : new Request(String(target), options);
                  return Response.json({ id: "sandbox-id", login: "octocat", status: "connected" });
                },
                { preconnect: fetch.preconnect },
              ),
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
