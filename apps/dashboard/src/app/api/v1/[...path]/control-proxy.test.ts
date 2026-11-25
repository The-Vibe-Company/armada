import { expect, test } from "bun:test";
import { PUBLIC_CONTROL_ROUTES } from "@armada/core/contract";
import { forwardControl, forwardDashboardEventStream } from "./control-proxy.ts";
import { POST } from "./route.ts";

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
      return Response.json(
        { goldens: [] },
        {
          status: 201,
          headers: { "server-timing": "auth;dur=1.25, dispatch;dur=2.50", "set-cookie": "private=must-not-forward" },
        },
      );
    },
  );
  expect(response.status).toBe(201);
  expect(response.headers.get("server-timing")).toBe("auth;dur=1.25, dispatch;dur=2.50");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toEqual({ goldens: [] });
  expect(seen[0]?.url).toBe("https://armada.test/api/v1/golden/list");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer masked");
});

test("DELETE proxy forwards only the authenticated sandbox deletion shape and organization scope and replay ID", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const id = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const seen: Request[] = [];
  const send = async (method: string, path: string[], bearer = true, replay = "") =>
    forwardControl(
      new Request(`https://dashboard.test/api/v1/${path.join("/")}?org=${org}${replay}`, {
        method,
        headers: bearer ? { authorization: "Bearer masked" } : {},
      }),
      path,
      async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ id, status: "deleted" });
      },
    );
  expect((await send("DELETE", ["sandboxes", id], false)).status).toBe(401);
  const deleted = await send("DELETE", ["sandboxes", id]);
  expect(deleted.status).toBe(200);
  expect(deleted.headers.get("cache-control")).toBe("no-store");
  expect(await deleted.json()).toEqual({ id, status: "deleted" });
  expect(seen[0]?.method).toBe("DELETE");
  expect(seen[0]?.body).toBeNull();
  expect(seen[0]?.url).toBe(`https://armada.test/api/v1/sandboxes/${id}?org=${org}`);
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer masked");
  expect((await send("DELETE", ["sandboxes", id], true, `&requestId=${id}`)).status).toBe(200);
  expect(seen[1]?.url).toBe(`https://armada.test/api/v1/sandboxes/${id}?org=${org}&requestId=${id}`);
  for (const [method, path] of [
    ["POST", ["sandbox", "delete"]],
    ["POST", ["sandboxes", id]],
    ["GET", ["sandboxes", id]],
    ["DELETE", ["sandboxes", "not-a-uuid"]],
    ["DELETE", ["sandboxes", id, "extra"]],
    ["DELETE", ["unknown", id]],
    ["DELETE", ["golden", "list"]],
  ] as const)
    expect((await send(method, [...path])).status).toBe(404);
  expect(seen).toHaveLength(2);
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

test("public control contract forwards every declared method anonymously, including redirects and query", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  for (const [path, methods] of Object.entries(PUBLIC_CONTROL_ROUTES)) {
    for (const method of methods) {
      const seen: Request[] = [];
      const response = await forwardControl(
        new Request(`https://dashboard.test/api/v1/${path}?state=login_state`, { method }),
        path.split("/"),
        async (input, init) => {
          seen.push(new Request(input, init));
          expect(init?.redirect).toBe("manual");
          return path.endsWith("authorize") || path.endsWith("callback")
            ? new Response(null, { status: 302, headers: { location: "https://identity.test/authorize" } })
            : Response.json({ methods: ["email", "github", "google"] });
        },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe(method);
      expect(seen[0]?.url).toBe(`https://armada.test/api/v1/${path}${method === "GET" ? "?state=login_state" : ""}`);
      expect(seen[0]?.headers.get("authorization")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (response.status === 302) expect(response.headers.get("location")).toBe("https://identity.test/authorize");
      else {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ methods: ["email", "github", "google"] });
      }
    }
  }
});

test("forwards authenticated CLI operations and MCP control routes", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const seen: Request[] = [];
  for (const path of [
    ["sandbox", "test-model-connection"],
    ["golden", "adopt"],
    ["github", "runtime-status"],
    ["sandbox", "resume"],
    ["skillpack", "connection"],
    ["creds", "accounts", "models"],
    ["creds", "defaults", "set"],
    ["skillpack", "catalog"],
    ["skillpack", "versions"],
    ["skills", "defaults", "get"],
    ["skills", "defaults", "set"],
    ["templates", "create"],
    ["templates", "list"],
    ["templates", "get"],
    ["templates", "publish"],
    ["templates", "delete"],
    ["templates", "launch"],
    ["variables", "list"],
    ["variables", "read"],
    ["variables", "set"],
    ["variables", "update"],
    ["variables", "revoke"],
    ["variables", "delete"],
    ["secrets", "list"],
    ["secrets", "set"],
    ["secrets", "rotate"],
    ["secrets", "revoke"],
    ["secrets", "delete"],
    ["secrets", "upload"],
    ["secrets", "commit"],
    ["org", "list"],
    ["golden", "capabilities"],
    ["account", "status"],
    ["github", "status"],
    ["github", "connect"],
    ["github", "disconnect"],
    ["github", "install"],
    ["creds", "list"],
    ["creds", "set"],
    ["creds", "rm"],
    ["sandbox", "advice"],
    ["sandbox", "extend"],
    ["sandbox", "list"],
    ["sandbox", "list-turns"],
    ["sandbox", "wait"],
    ["sandbox", "exec"],
    ["mcp", "catalog"],
    ["mcp", "list"],
    ["mcp", "create"],
    ["mcp", "update"],
    ["mcp", "connect"],
    ["mcp", "status"],
    ["mcp", "revoke"],
    ["mcp", "delete"],
    ["mcp", "metadata"],
    ["creds", "accounts", "set"],
    ["creds", "accounts", "limits"],
    ["creds", "accounts", "rename"],
    ["creds", "accounts", "default"],
    ["creds", "accounts", "remove"],
    ["creds", "accounts", "usage"],
    ["creds", "accounts", "auth-capabilities"],
    ["launch", "options"],
    ["sandbox", "bind-credential"],
    ["org", "provider", "disconnect"],
    ["mcp", "set-enabled"],
    ["mcp", "sandbox-connections"],
  ]) {
    const payload = JSON.stringify({
      org: "org-id",
      id: "instance-id",
      credentialId: "account-id",
      name: "Work",
      defaultForLaunch: false,
      expectedVersion: 2,
    });
    const response = await forwardControl(
      new Request("https://dashboard.test", {
        method: "POST",
        headers: { authorization: "Bearer masked", "content-type": "application/json" },
        body: payload,
      }),
      path,
      async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ error: { code: "conflict", message: "Revision changed." } }, { status: 409 });
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "conflict", message: "Revision changed." } });
    expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer masked");
    expect(seen.at(-1)?.url).toBe(`https://armada.test/api/v1/${path.join("/")}`);
    expect(seen.at(-1)?.headers.get("content-type")).toBe("application/json");
    expect(await seen.at(-1)?.text()).toBe(payload);
    const count = seen.length;
    const anonymous = await forwardControl(
      new Request("https://dashboard.test", { method: "POST", body: payload }),
      path,
      async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    );
    expect(anonymous.status).toBe(401);
    expect(seen).toHaveLength(count);
  }
  expect(
    (await forwardControl(new Request("https://dashboard.test", { method: "POST" }), ["org", "list"])).status,
  ).toBe(401);

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

test("keeps unknown and machine-only routes outside the closed public allowlist", async () => {
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
  let forwarded = 0;
  for (const path of [
    ["..", "evil"],
    ["mcp", "unknown"],
    ["creds", "accounts", "unknown"],
    ["creds", "accounts", "auth-state"],
    ["creds", "accounts", "auth-state", "callback"],
    ["internal", "runner", "auth-state"],
    ["docker-host", "register"],
    ["sandbox", "auth-state"],
    ["sandbox", "advice", "callback"],
    ["sandbox", "advice-extra"],
    ["sandbox", "launch-sized-v2"],
    ["golden", "size-policy", "callback"],
    ["golden", "size-policies"],
  ]) {
    const blocked = await forwardControl(
      new Request("https://dashboard.test", { method: "POST", headers: { authorization: "Bearer masked" } }),
      path,
      async () => {
        forwarded++;
        return Response.json({ ok: true });
      },
    );
    expect(blocked.status).toBe(404);
    expect(await blocked.json()).toEqual({ error: { code: "unknown_route", message: "Unknown route." } });
  }
  expect(forwarded).toBe(0);
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

test("provider setup and sizing preserve request bytes through the proxy", async () => {
  const received: { path: string; body: string; bearer: string | null }[] = [];
  const upstream = async (input: URL, init: RequestInit) => {
    const request = new Request(input, init);
    received.push({
      path: new URL(request.url).pathname,
      body: await request.text(),
      bearer: request.headers.get("authorization"),
    });
    return Response.json(
      { error: { code: "invalid", message: "The provider rejected this credential." } },
      { status: 400 },
    );
  };
  const post = (path: string, init: RequestInit) =>
    forwardControl(
      new Request(`https://dashboard.test/api/v1/${path}`, { ...init, method: "POST" }),
      path.split("/"),
      upstream,
    );
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  try {
    for (const action of ["status", "connect", "disconnect"]) {
      const body = JSON.stringify(
        action === "status"
          ? { org: "org-id" }
          : action === "disconnect"
            ? { org: "org-id", provider: "boat" }
            : { org: "org-id", provider: "boat", value: "synthetic-input" },
      );
      const response = await post(`org/provider/${action}`, {
        headers: { authorization: "Bearer masked", "content-type": "application/json" },
        body,
      });
      expect(received.at(-1)).toEqual({ path: `/api/v1/org/provider/${action}`, body, bearer: "Bearer masked" });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: { code: "invalid", message: "The provider rejected this credential." },
      });
    }
    for (const [path, body] of [
      ["sandbox/launch", '{ "golden": "golden-id", "size": "medium" }'],
      ["golden/size-policy", '{"golden":"golden-id"}'],
      [
        "golden/size-policy",
        '{"golden":"golden-id","policy":{"version":1,"golden":"large","repositories":{"armada":"medium"}}}',
      ],
    ] as const) {
      const count = received.length;
      const anonymous = await POST(
        new Request(`https://dashboard.test/api/v1/${path}`, { method: "POST", body, signal: AbortSignal.abort() }),
        { params: Promise.resolve({ path: path.split("/") }) },
      );
      expect(anonymous.status).toBe(401);
      expect(received).toHaveLength(count);
      const response = await post(path, {
        headers: { authorization: "Bearer masked", "content-type": "application/json" },
        body,
      });
      expect(received).toHaveLength(count + 1);
      expect(received.at(-1)).toEqual({ path: `/api/v1/${path}`, body, bearer: "Bearer masked" });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '{"error":{"code":"invalid","message":"The provider rejected this credential."}}',
      );
    }
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("retirement proxy exposes only the two authenticated closed paths and forwards scope without rewriting it", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  let calls = 0;
  const body = JSON.stringify({ org: "selected-org", id: "golden-id", limit: 2 });
  for (const action of ["dry-run", "reconcile"]) {
    const path = ["golden", "retirement", action];
    expect(
      (
        await forwardControl(
          new Request("https://dashboard.test/api/v1/" + path.join("/"), { method: "POST", body }),
          path,
          async () => {
            throw Error("Anonymous request escaped");
          },
        )
      ).status,
    ).toBe(401);
    const response = await forwardControl(
      new Request("https://dashboard.test/api/v1/" + path.join("/"), {
        method: "POST",
        headers: { authorization: "Bearer masked" },
        body,
      }),
      path,
      async (input, init) => {
        const request = new Request(input, init);
        calls++;
        expect(request.url).toBe("https://armada.test/api/v1/" + path.join("/"));
        expect(request.headers.get("authorization")).toBe("Bearer masked");
        expect(await request.text()).toBe(body);
        return Response.json({ results: [{ outcome: "protected", reason: "referenced" }] }, { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ outcome: "protected", reason: "referenced" }] });
  }
  for (const action of ["delete", "dry-run/extra", "reconcile-all"])
    expect(
      (
        await forwardControl(
          new Request("https://dashboard.test", { method: "POST", headers: { authorization: "Bearer masked" } }),
          ["golden", "retirement", action],
          async () => {
            throw Error("Unknown path escaped");
          },
        )
      ).status,
    ).toBe(404);
  expect(calls).toBe(2);
});

test("control proxy body limit counts streamed UTF-8 bytes and never sends oversized input upstream", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  let sent = 0;
  try {
    const response = await forwardControl(
      new Request("https://dashboard.test/api/v1/golden/list", {
        method: "POST",
        headers: { authorization: "Bearer proxy-fixture" },
        body: "é".repeat(70_000),
      }),
      ["golden", "list"],
      async () => {
        sent++;
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sent).toBe(0);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("catalog proxy preserves query parameters for strict upstream refusal", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const seen: string[] = [];
  for (const operation of ["catalog", "versions"]) {
    await forwardControl(
      new Request(`https://dashboard.test/api/v1/skillpack/${operation}?unexpected=1`, {
        method: "POST",
        headers: { authorization: "Bearer masked" },
        body: "{}",
      }),
      ["skillpack", operation],
      async (input) => {
        seen.push(new URL(String(input)).search);
        return Response.json({});
      },
    );
  }
  expect(seen).toEqual(["?unexpected=1", "?unexpected=1"]);
});

test("snapshot create forwards bounded golden configs up to one MiB and refuses streamed or declared overflow", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  try {
    const payload = JSON.stringify({
      config: {
        repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
        init: Array.from({ length: 32 }, () => "é".repeat(3000)),
      },
    });
    const bytes = new TextEncoder().encode(payload);
    const streamed = (parts: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
    let forwards = 0;
    const send = (
      body: string | ReadableStream<Uint8Array>,
      path = ["docker", "snapshots", "create"],
      length?: number,
    ) =>
      forwardControl(
        new Request(`https://dashboard.test/api/v1/${path.join("/")}`, {
          method: "POST",
          headers: {
            authorization: "Bearer masked",
            ...(length === undefined ? {} : { "content-length": String(length) }),
          },
          body,
        }),
        path,
        async (input, init) => {
          forwards++;
          const request = new Request(input, init);
          expect(request.headers.get("authorization")).toBe("Bearer masked");
          expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
          return Response.json({ snapshot: {} });
        },
      );
    expect((await send(payload)).status).toBe(200);
    expect((await send(streamed([bytes.subarray(0, 100_000), bytes.subarray(100_000)]))).status).toBe(200);
    expect((await send("{}", undefined, 1024 * 1024 + 1)).status).toBe(413);
    expect((await send(streamed([new Uint8Array(512 * 1024), new Uint8Array(512 * 1024 + 1)]))).status).toBe(413);
    expect((await send(payload, ["golden", "list"])).status).toBe(413);
    expect(forwards).toBe(2);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("GET proxy forwards the authenticated sandbox outputs list and download with the encoded filename intact", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const id = "11111111-1111-4111-8111-111111111111";
  const upper = "AAAAAAAA-1111-4111-8111-111111111111";
  const seen: Request[] = [];
  const send = (rawPath: string, path: string[], bearer = true, range?: string) =>
    forwardControl(
      new Request(`https://dashboard.test/api/v1/${rawPath}`, {
        headers: bearer
          ? { authorization: "Bearer masked", ...(range ? { range, "if-range": '"file-digest"' } : {}) }
          : {},
      }),
      path,
      async (input, init) => {
        seen.push(new Request(input, init));
        const status = range === "bytes=1-3" ? 206 : range ? 416 : 200;
        return new Response(status === 416 ? null : "pdf", {
          status,
          headers: {
            "content-type": "application/pdf",
            "content-length": status === 416 ? "0" : "3",
            "accept-ranges": "bytes",
            etag: '"file-digest"',
            ...(range ? { "content-range": status === 206 ? "bytes 1-3/4" : "bytes */4" } : {}),
            "content-disposition": "attachment; filename*=UTF-8''a%2Fb%20memo.pdf",
            "x-content-type-options": "nosniff",
            "set-cookie": "private=must-not-forward",
          },
        });
      },
    );
  expect(
    (await send(`sandboxes/${id}/outputs/a%2Fb%20memo.pdf`, ["sandboxes", id, "outputs", "a/b memo.pdf"], false))
      .status,
  ).toBe(401);
  const downloadPath = `sandboxes/${id}/outputs/a%2Fb%20memo.pdf`;
  const decoded = ["sandboxes", id, "outputs", "a/b memo.pdf"];
  const download = await send(downloadPath, decoded, true, "bytes=1-3");
  expect(download.status).toBe(206);
  expect(seen[0]?.url).toBe(`https://armada.test/api/v1/sandboxes/${id}/outputs/a%2Fb%20memo.pdf`);
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer masked");
  expect(seen[0]?.headers.get("range")).toBe("bytes=1-3");
  expect(seen[0]?.headers.get("if-range")).toBe('"file-digest"');
  expect(download.headers.get("content-range")).toBe("bytes 1-3/4");
  expect(download.headers.get("etag")).toBe('"file-digest"');
  expect(download.headers.get("accept-ranges")).toBe("bytes");
  expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a%2Fb%20memo.pdf");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(download.headers.get("content-type")).toBe("application/pdf");
  expect(download.headers.get("content-length")).toBe("3");
  expect(download.headers.get("cache-control")).toBe("private, no-store");
  expect(download.headers.get("set-cookie")).toBeNull();
  expect(await download.text()).toBe("pdf");
  expect((await send(`sandboxes/${id}/outputs`, ["sandboxes", id, "outputs"])).status).toBe(200);
  expect(seen[1]?.url).toBe(`https://armada.test/api/v1/sandboxes/${id}/outputs`);
  const rejected = await send(downloadPath, decoded, true, "bytes=32-");
  expect(rejected.status).toBe(416);
  expect(rejected.headers.get("content-range")).toBe("bytes */4");
  for (const [rawPath, path] of [
    [`sandboxes/not-a-uuid/outputs`, ["sandboxes", "not-a-uuid", "outputs"]],
    [`sandboxes/${id}/outputs/a/b`, ["sandboxes", id, "outputs", "a", "b"]],
    [`sandboxes/${id}/files`, ["sandboxes", id, "files"]],
    [`sandboxes/${id}/outputs/%2e%2e`, ["sandboxes", id]],
    [`sandboxes/${upper}/outputs`, ["sandboxes", upper, "outputs"]],
  ] as const)
    expect((await send(rawPath, [...path])).status).toBe(404);
  const post = await forwardControl(
    new Request(`https://dashboard.test/api/v1/sandboxes/${id}/outputs`, {
      method: "POST",
      headers: { authorization: "Bearer masked" },
      body: "{}",
    }),
    ["sandboxes", id, "outputs"],
    async () => {
      throw new Error("must not forward");
    },
  );
  expect(post.status).toBe(404);
  expect(seen).toHaveLength(3);
});

test("streams sandbox events as they arrive and forwards the reconnect cursor", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const id = "11111111-1111-4111-8111-111111111111";
  const abort = new AbortController();
  const request = new Request(`https://dashboard.test/api/v1/events?sandbox=${id}&cursor=5`, {
    headers: { authorization: "Bearer untrusted", "last-event-id": "8", cookie: "session=masked" },
    signal: abort.signal,
  });
  const { readable, writable } = new TransformStream<Uint8Array>();
  let upstreamSignal: AbortSignal | undefined;
  const response = await forwardDashboardEventStream(request, "fixture-viewer", async (input, init) => {
    const upstream = new Request(input, init);
    expect(upstream.url).toBe(`https://armada.test/api/v1/events?sandbox=${id}&cursor=5`);
    expect(upstream.headers.get("authorization")).toBe("Bearer fixture-viewer");
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("accept")).toBe("text/event-stream");
    expect(upstream.headers.get("last-event-id")).toBe("8");
    upstreamSignal = upstream.signal;
    return new Response(readable, {
      headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" },
    });
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const frame = 'id: 9\ndata: {"id":"9"}\n\n';
  const reader = response.body!.getReader();
  const writer = writable.getWriter();
  const [chunk] = await Promise.all([reader.read(), writer.write(new TextEncoder().encode(frame))]);
  expect(new TextDecoder().decode(chunk.value)).toBe(frame);
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  await reader.cancel();
});
