import { expect, test } from "bun:test";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";

const env = process.env.ARMADA_MCP_URL;

test("forwards allowed control paths with the bearer and preserves status/body", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const seen: Request[] = [];
  const response = await forwardControl(
    new Request("https://dashboard.test/api/v1/golden/list", {
      method: "POST",
      headers: { authorization: "Bearer masked" },
      body: "{}",
    }),
    ["golden", "list"],
    async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ goldens: [] }, { status: 201 });
    },
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ goldens: [] });
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/golden/list");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer masked");
});

test("forwards anonymous public auth routes without a bearer", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const seen: Request[] = [];
  const response = await forwardControl(
    new Request("https://dashboard.test/api/v1/auth/exchange", { method: "POST", body: "{}" }),
    ["auth", "exchange"],
    async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ accessToken: "session-only" });
    },
  );
  expect(response.status).toBe(200);
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/auth/exchange");
  expect(seen[0]?.headers.get("authorization")).toBeNull();
  const output = await response.text();
  expect(output).toContain("session-only");
  expect(output).not.toContain("ARMADA_MCP_URL");
});

test("forwards authenticated CLI operations and MCP control routes", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const seen: Request[] = [];
  for (const path of [
    ["org", "list"],
    ["golden", "capabilities"],
    ["account", "status"],
    ["github", "status"],
    ["creds", "list"],
    ["sandbox", "list"],
    ["sandbox", "wait"],
    ["sandbox", "exec"],
    ["mcp", "set-enabled"],
    ["mcp", "sandbox-connections"],
  ]) {
    const response = await forwardControl(
      new Request("https://dashboard.test", { method: "POST", headers: { authorization: "Bearer masked" } }),
      path,
      async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(200);
    expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer masked");
    expect(seen.at(-1)?.url).toBe(`https://armada.test/api/v1/${path.join("/")}`);
  }
  expect(
    (await forwardControl(new Request("https://dashboard.test", { method: "POST" }), ["org", "list"])).status,
  ).toBe(401);

  // `armada golden remove` (#566) goes through the public origin: same route, bearer and body as the dashboard's own call.
  const removal = JSON.stringify({
    id: "00000000-0000-4000-8000-000000000020",
    org: "00000000-0000-4000-8000-000000000010",
  });
  const removed = await forwardControl(
    new Request("https://dashboard.test/api/v1/golden/remove", {
      method: "POST",
      headers: { authorization: "Bearer masked", "content-type": "application/json" },
      body: removal,
    }),
    ["golden", "remove"],
    async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({
        id: "00000000-0000-4000-8000-000000000020",
        removedAt: "2026-11-09T00:00:00Z",
        artifacts: "retained",
      });
    },
  );
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({
    id: "00000000-0000-4000-8000-000000000020",
    removedAt: "2026-11-09T00:00:00Z",
    artifacts: "retained",
  });
  expect(seen.at(-1)?.url).toBe("https://armada.test/api/v1/golden/remove");
  expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer masked");
  expect(await seen.at(-1)?.text()).toBe(removal);
  const forwarded = seen.length;
  const anonymous = await forwardControl(
    new Request("https://dashboard.test/api/v1/golden/remove", { method: "POST", body: removal }),
    ["golden", "remove"],
    async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ ok: true });
    },
  );
  expect(anonymous.status).toBe(401);
  expect(seen).toHaveLength(forwarded);
});

test("allows launch and logs routes only", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const fetchImpl = async () => Response.json({ ok: true });
  for (const path of [
    ["sandbox", "launch"],
    ["logs", "read"],
  ]) {
    expect(
      (
        await forwardControl(
          new Request("https://dashboard.test", { method: "POST", headers: { authorization: "Bearer masked" } }),
          path,
          fetchImpl,
        )
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await forwardControl(
        new Request("https://dashboard.test", { method: "POST", headers: { authorization: "Bearer masked" } }),
        ["..", "evil"],
        fetchImpl,
      )
    ).status,
  ).toBe(404);
});

test("rejects missing configuration and authorization", async () => {
  delete process.env.ARMADA_MCP_URL;
  expect(
    (await forwardControl(new Request("https://dashboard.test", { method: "POST" }), ["golden", "list"])).status,
  ).toBe(503);
  process.env.ARMADA_MCP_URL = "not a url";
  expect(
    (await forwardControl(new Request("https://dashboard.test", { method: "POST" }), ["golden", "list"])).status,
  ).toBe(503);
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  expect(
    (await forwardControl(new Request("https://dashboard.test", { method: "POST" }), ["golden", "list"])).status,
  ).toBe(401);
  if (env === undefined) delete process.env.ARMADA_MCP_URL;
  else process.env.ARMADA_MCP_URL = env;
});
