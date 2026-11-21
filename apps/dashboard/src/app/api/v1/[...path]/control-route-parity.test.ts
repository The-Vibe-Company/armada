import { expect, test } from "bun:test";
import { operation } from "../../../../../../../packages/cli/src/operations.ts";
import { memorySessionStore } from "../../../../../../../packages/cli/src/session.ts";
import { forwardControl } from "./control-proxy.ts";

const id = "11111111-1111-4111-8111-111111111111";

test("CLI info and stop forward authenticated scope through the public proxy", async () => {
  const org = "22222222-2222-4222-8222-222222222222";
  const token = "fixture-owner";
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  try {
    const cases = [
      { command: "info", route: "status", expectedBody: { id, org, recorded: true } },
      { command: "stop", route: "stop", expectedBody: { id, org } },
    ] as const;
    for (const { command, route, expectedBody } of cases) {
      const path = `/api/v1/sandbox/${route}`;
      const forwarded: Request[] = [];
      await operation(
        command,
        [id, "--org", org, "--json"],
        {
          env: { ARMADA_TOKEN: token, ARMADA_URL: "https://dashboard.test" },
          fetch: async (input, init) => {
            const incoming = new Request(input, init);
            expect(incoming.url).toBe(`https://dashboard.test${path}`);
            expect(incoming.headers.get("accept")).toBe("application/json");
            expect(incoming.headers.get("content-type")).toBe("application/json");
            return forwardControl(
              incoming,
              new URL(incoming.url).pathname.slice("/api/v1/".length).split("/"),
              async (target, options) => {
                forwarded.push(new Request(target, options));
                return Response.json({ id, status: "stopped", settled: true, prompt: null });
              },
            );
          },
          session: memorySessionStore(),
          now: () => new Date(0),
          open: () => {},
          out: () => {},
          err: () => {},
        },
        async () => "",
      );
      expect(forwarded).toHaveLength(1);
      const upstream = forwarded[0];
      expect(upstream?.url).toBe(`https://control.test${path}`);
      expect(upstream?.method).toBe("POST");
      expect(upstream?.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(upstream?.headers.get("accept")).toBe("application/json");
      expect(upstream?.headers.get("content-type")).toBe("application/json");
      expect(await upstream?.json()).toEqual(expectedBody);
    }
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});
