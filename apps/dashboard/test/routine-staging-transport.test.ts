import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Exercise the real Python HTTP request through the real public-origin proxy. A
// backend-only fake accepting POST sandbox/delete cannot protect this boundary.
test("routine cleanup DELETE reaches the configured control API through the public origin", async () => {
  const org = "00000000-0000-4000-8000-000000000010";
  const id = "00000000-0000-4000-8000-000000000030";
  const token = "synthetic-public-origin-token";
  const python = `
import importlib.util, io, json, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("staging_check", Path("scripts/routines/staging-check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
api = check.Api("https://dashboard-staging.example", ${JSON.stringify(org)}, ${JSON.stringify(token)})
captured = {}
class Transport:
    def open(self, request, timeout):
        captured.update(url=request.full_url, method=request.get_method(), headers=dict(request.header_items()),
                        body=request.data.decode() if request.data is not None else None)
        return io.BytesIO(b'{"status":"deleted"}')
api.opener = Transport()
check.Scenario(api).stop_delete(${JSON.stringify(id)}, time.monotonic() + 5)
print(json.dumps(captured))
`;
  const child = Bun.spawnSync(["python3", "-c", python], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const captured = JSON.parse(child.stdout.toString()) as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  try {
    const url = new URL(captured.url);
    const { forwardControl } = await import("../src/app/api/v1/[...path]/control-proxy.ts");
    let forwarded: { url: string; init: RequestInit } | undefined;
    const response = await forwardControl(
      new Request(url.href, {
        method: captured.method,
        headers: captured.headers,
        ...(captured.body === null ? {} : { body: captured.body }),
      }),
      url.pathname.slice("/api/v1/".length).split("/"),
      Object.assign(
        async (target: unknown, init?: RequestInit) => {
          forwarded = { url: String(target), init: init ?? {} };
          return Response.json({ id, status: "deleted" });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: "deleted" });
    expect(forwarded?.url).toBe(`https://control.test/api/v1/sandboxes/${id}?org=${org}`);
    expect(forwarded?.init.method).toBe("DELETE");
    expect(new Headers(forwarded?.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(forwarded?.init.body).toBeUndefined();
    expect(captured.url).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});
