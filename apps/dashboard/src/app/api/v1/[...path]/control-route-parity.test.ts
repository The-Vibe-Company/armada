import { expect, test } from "bun:test";
import { controlRouteKey, operations } from "@armada/core/contract";
import { operation } from "../../../../../../../packages/cli/src/operations.ts";
import { memorySessionStore } from "../../../../../../../packages/cli/src/session.ts";
import { forwardControl } from "./control-proxy.ts";

const id = "11111111-1111-4111-8111-111111111111";

test("user POST operations reach the dashboard proxy and direct-server POSTs stay outside it", async () => {
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  try {
    for (const operation of Object.values(operations)) {
      if (operation.route.method !== "POST" || "anonymous" in operation) continue;
      const { route } = operation;
      const direct = "directServer" in operation;
      const forwarded: string[] = [];
      const response = await forwardControl(
        new Request(`https://dashboard.test${route.path}`, {
          method: "POST",
          headers: { authorization: "Bearer fixture" },
        }),
        controlRouteKey(route).split("/"),
        async (input) => {
          forwarded.push(input.href);
          return new Response(null, { status: 204 });
        },
      );
      expect(response.status, route.path).toBe(direct ? 404 : 204);
      expect(forwarded, route.path).toEqual(direct ? [] : [`https://control.test${route.path}`]);
    }

    const response = await forwardControl(
      new Request("https://dashboard.test/api/v1/docker-host/poll", {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
      }),
      ["docker-host", "poll"],
      async () => {
        throw new Error("Host daemon polls must stay outside the user proxy");
      },
    );
    expect(response.status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});

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
      await operation(command, [id, "--org", org, "--json"], {
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
      });
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
