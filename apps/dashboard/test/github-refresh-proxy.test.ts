import { expect, test } from "bun:test";
import { run } from "../../../packages/cli/src/run.ts";
import { memorySessionStore } from "../../../packages/cli/src/session.ts";
import { POST } from "../src/app/api/v1/[...path]/route.ts";

test("GitHub repair crosses the actual dashboard POST proxy with private auth and reports missing deployments safely", async () => {
  const originalOrigin = process.env.ARMADA_MCP_URL;
  const received: { path: string; bearer: string | null; body: unknown }[] = [];
  let missing = false;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        bearer: request.headers.get("authorization"),
        body: await request.json(),
      });
      return missing
        ? new Response("upstream-private-diagnostic", { status: 404 })
        : Response.json({ id: "sandbox-id", login: "octocat", status: "connected" });
    },
  });
  const dashboard = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      POST(request, {
        params: Promise.resolve({ path: new URL(request.url).pathname.slice("/api/v1/".length).split("/") }),
      }),
  });
  try {
    process.env.ARMADA_MCP_URL = upstream.url.href;
    let out = "",
      error = "";
    const invoke = () =>
      run(
        ["github", "refresh", "sandbox-id"],
        {
          out: (text) => {
            out += text;
          },
          err: (text) => {
            error += text;
          },
        },
        {
          auth: {
            out: (text) => {
              out += text;
            },
            err: (text) => {
              error += text;
            },
            env: { ARMADA_URL: dashboard.url.href, ARMADA_TOKEN: "fixture-service-token" },
            session: memorySessionStore(),
            now: () => new Date(),
            open: () => {},
            fetch,
          },
        },
      );
    const code = await invoke();
    expect(received).toHaveLength(1);
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(out)).toEqual({ id: "sandbox-id", login: "octocat", status: "connected" });
    expect(received).toEqual([
      { path: "/api/v1/github/refresh", bearer: "Bearer fixture-service-token", body: { id: "sandbox-id" } },
    ]);
    // A version-skewed upstream must not turn into a bare 404 or relay private diagnostics.
    missing = true;
    out = "";
    expect(await invoke()).toBe(1);
    expect(received).toHaveLength(2);
    expect(error).toContain("Check the sandbox ID and access");
    expect(error).toContain("dashboard/server route is not deployed");
    expect(error).not.toContain("upstream-private-diagnostic");
    // The one new route must remain private, not open a GitHub prefix or token callback.
    for (const [method, tail, status] of [
      ["POST", "refresh", 401],
      ["GET", "refresh", 404],
      ["POST", "refresh/callback", 404],
    ] as const) {
      const request = new Request(new URL(`/api/v1/github/${tail}`, dashboard.url).href, { method });
      const response = await POST(request, { params: Promise.resolve({ path: ["github", ...tail.split("/")] }) });
      expect(response.status).toBe(status);
    }
    expect(received).toHaveLength(2);
  } finally {
    if (originalOrigin === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = originalOrigin;
    await dashboard.stop(true);
    await upstream.stop(true);
  }
});
