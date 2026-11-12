import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { operation } from "../../../packages/cli/src/operations.ts";
import { memorySessionStore } from "../../../packages/cli/src/session.ts";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";

test("staging checker status and stop preserve CLI public-proxy routes, identity and org", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const token = "fixture-owner-token";
  const incoming: unknown[] = [];
  const forwarded: unknown[] = [];
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      incoming.push({
        path,
        method: request.method,
        body: await request.clone().json(),
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        contentType: request.headers.get("content-type"),
      });
      return forwardControl(
        request,
        path.slice("/api/v1/".length).split("/"),
        Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const upstream = new Request(input, init);
            forwarded.push({ url: upstream.url, body: await upstream.json() });
            return Response.json({ id, status: "stopped" });
          },
          { preconnect: fetch.preconnect },
        ),
      );
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    for (const command of ["status", "stop"]) {
      await operation(
        command,
        [id, "--org", org, "--json"],
        {
          env: { ARMADA_TOKEN: token, ARMADA_URL: origin },
          fetch,
          session: memorySessionStore(),
          now: () => new Date(0),
          open: () => {},
          out: () => {},
          err: () => {},
        },
        async () => "",
      );
    }
    const checker = resolve(import.meta.dir, "../../../scripts/sandbox-access/staging-check.py");
    const python = `import importlib.util,sys
s=importlib.util.spec_from_file_location('check',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
a=m.arguments(['--provider','modal','--harness','codex','--golden','fixture','--golden-id',sys.argv[3],'--account-id',sys.argv[3],'--account-version','1','--model','fixture','--confirm-real-compute'])
r=m.Run(a,sys.argv[2],sys.argv[4],'fixture-owner-token')
r.tool('status',id=sys.argv[3]);r.tool('stop',id=sys.argv[3])`;
    const child = Bun.spawn(["python3", "-c", python, checker, origin, id, org], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, errors).toBe(0);
    expect(output).not.toContain(token);
    expect(incoming).toHaveLength(4);
    expect(incoming.slice(2)).toEqual(incoming.slice(0, 2));
    expect(forwarded).toHaveLength(4);
    expect(forwarded.slice(2)).toEqual(forwarded.slice(0, 2));
    expect(forwarded).toEqual([
      { url: "https://control.test/api/v1/sandbox/status", body: { id, org } },
      { url: "https://control.test/api/v1/sandbox/stop", body: { id, org } },
      { url: "https://control.test/api/v1/sandbox/status", body: { id, org } },
      { url: "https://control.test/api/v1/sandbox/stop", body: { id, org } },
    ]);
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});
