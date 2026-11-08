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
