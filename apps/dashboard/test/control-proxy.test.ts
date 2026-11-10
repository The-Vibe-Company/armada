import { expect, test } from "bun:test";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";
import { DELETE, GET, POST } from "../src/app/api/v1/[...path]/route.ts";

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

test("DELETE proxy forwards only the authenticated sandbox deletion shape and organization scope", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const id = "11111111-1111-4111-8111-111111111111";
  const seen: Request[] = [];
  const send = async (method: string, path: string[], bearer = true) =>
    forwardControl(
      new Request(`https://dashboard.test/api/v1/${path.join("/")}?org=${id}`, {
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
  expect((await send("DELETE", ["sandboxes", id])).status).toBe(200);
  expect(seen[0]?.method).toBe("DELETE");
  expect(seen[0]?.url).toBe(`https://armada.test/api/v1/sandboxes/${id}?org=${id}`);
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer masked");
  for (const [method, path] of [
    ["POST", ["sandboxes", id]],
    ["GET", ["sandboxes", id]],
    ["DELETE", ["sandboxes", "not-a-uuid"]],
    ["DELETE", ["sandboxes", id, "extra"]],
    ["DELETE", ["orchestrators", id]],
    ["DELETE", ["golden", "list"]],
  ] as const)
    expect((await send(method, [...path])).status).toBe(404);
  expect(seen).toHaveLength(1);
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
    ["sandbox", "advice"],
    ["sandbox", "extend"],
    ["sandbox", "list"],
    ["sandbox", "wait"],
    ["sandbox", "exec"],
    ["mcp", "catalog"],
    ["mcp", "metadata"],
    ["creds", "accounts", "set"],
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

test("keeps unknown and runner secret callbacks outside the closed public allowlist", async () => {
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
    ["sandbox", "auth-state"],
    ["sandbox", "advice", "callback"],
    ["sandbox", "advice-extra"],
    ["sandbox", "launch-sized-v2"],
    ["sandbox", "launch-sized-v1", "callback"],
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

test("provider setup and sizing cross the real public-origin POST proxy over HTTP", async () => {
  const received: { path: string; body: string; bearer: string | null }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        body: await request.text(),
        bearer: request.headers.get("authorization"),
      });
      return Response.json(
        { error: { code: "invalid", message: "The provider rejected this credential." } },
        { status: 400 },
      );
    },
  });
  const publicOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      POST(request, {
        params: Promise.resolve({ path: new URL(request.url).pathname.slice("/api/v1/".length).split("/") }),
      }),
  });
  process.env.ARMADA_MCP_URL = upstream.url.toString();
  try {
    for (const action of ["status", "connect", "disconnect"]) {
      const body = JSON.stringify(
        action === "status"
          ? { org: "org-id" }
          : action === "disconnect"
            ? { org: "org-id", provider: "boat" }
            : { org: "org-id", provider: "boat", value: "synthetic-input" },
      );
      const response = await fetch(new URL(`/api/v1/org/provider/${action}`, publicOrigin.url), {
        method: "POST",
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
    // These bytes must reach control validation unchanged; the launch has no
    // version. Only the upstream is a fixture; the public POST handler is real.
    for (const [path, body] of [
      ["sandbox/launch-sized-v1", '{ "golden": "golden-id", "size": "medium" }'],
      ["sandbox/launch-sized-v1", '{"sizePolicyVersion":1,"golden":"golden-id","size":"medium"}'],
      ["golden/size-policy", '{"golden":"golden-id"}'],
      [
        "golden/size-policy",
        '{"golden":"golden-id","policy":{"version":1,"golden":"large","repositories":{"armada":"medium"}}}',
      ],
    ]) {
      const count = received.length;
      const anonymous = await fetch(new URL(`/api/v1/${path}`, publicOrigin.url), { method: "POST", body });
      expect(anonymous.status).toBe(401);
      expect(received).toHaveLength(count);
      const response = await fetch(new URL(`/api/v1/${path}`, publicOrigin.url), {
        method: "POST",
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
    process.env.ARMADA_MCP_URL = env;
    await publicOrigin.stop(true);
    await upstream.stop(true);
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

test("orchestrator public origin preserves exact verbs, query, idempotency and auth while keeping a closed boundary", async () => {
  const id = "00000000-0000-4000-8000-000000000662";
  const received: {
    method: string;
    path: string;
    query: string;
    key: string | null;
    bearer: string | null;
    cookie: string | null;
    body: string;
  }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/auth/authorize")
        return new Response(null, { status: 302, headers: { location: "https://identity.invalid/authorize" } });
      received.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        key: request.headers.get("idempotency-key"),
        bearer: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
        body: await request.text(),
      });
      return Response.json(
        { version: 1 },
        { status: request.method === "POST" ? 202 : 200, headers: { "set-cookie": "must-not-forward=value" } },
      );
    },
  });
  const publicOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const context = {
        params: Promise.resolve({ path: new URL(request.url).pathname.slice("/api/v1/".length).split("/") }),
      };
      return request.method === "GET"
        ? GET(request, context)
        : request.method === "DELETE"
          ? DELETE(request, context)
          : POST(request, context);
    },
  });
  process.env.ARMADA_MCP_URL = upstream.url.toString();
  try {
    const deletion = await fetch(new URL(`/api/v1/sandboxes/${id}?org=${id}`, publicOrigin.url), {
      method: "DELETE",
      headers: { authorization: "Bearer proxy-fixture" },
    });
    expect(deletion.status).toBe(200);
    expect(received.at(-1)).toEqual({
      method: "DELETE",
      path: `/api/v1/sandboxes/${id}`,
      query: `?org=${id}`,
      key: null,
      bearer: "Bearer proxy-fixture",
      cookie: null,
      body: "",
    });
    for (const path of [
      "orchestrators",
      "orchestrators/capabilities",
      `orchestrators/${id}`,
      `orchestrators/${id}/events`,
      `orchestrators/${id}/settings`,
      `orchestrators/${id}/waits`,
    ]) {
      const query = "?orgId=org&cursor=opaque%2Fcursor%2Bvalue&limit=2";
      const count = received.length;
      expect((await fetch(new URL(`/api/v1/${path}${query}`, publicOrigin.url))).status).toBe(401);
      expect(received).toHaveLength(count);
      const response = await fetch(new URL(`/api/v1/${path}${query}`, publicOrigin.url), {
        headers: { authorization: "Bearer proxy-fixture", cookie: "browser=must-not-forward" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(received.at(-1)).toEqual({
        method: "GET",
        path: `/api/v1/${path}`,
        query,
        key: null,
        bearer: "Bearer proxy-fixture",
        cookie: null,
        body: "",
      });
    }
    for (const action of [
      "create",
      "message",
      "steer",
      "stop",
      "resume",
      "recover",
      "reconcile",
      "settings",
      "waits",
      `waits/${id}/renew`,
      `waits/${id}/release`,
    ]) {
      const path =
        action === "create"
          ? "orchestrators"
          : action === "reconcile"
            ? "orchestrators/reconcile"
            : `orchestrators/${id}/${action}`;
      const body = JSON.stringify({ orgId: "org", expectedRevision: 2, size: "small", text: "work" });
      const key = `source-${action}`;
      const count = received.length;
      const anonymous = await fetch(new URL(`/api/v1/${path}?orgId=org`, publicOrigin.url), {
        method: "POST",
        headers: { "idempotency-key": key },
        body,
      });
      expect(anonymous.status).toBe(401);
      expect(received).toHaveLength(count);
      const response = await fetch(new URL(`/api/v1/${path}?orgId=org`, publicOrigin.url), {
        method: "POST",
        headers: { authorization: "Bearer proxy-fixture", "idempotency-key": key, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(202);
      expect(received.at(-1)).toEqual({
        method: "POST",
        path: `/api/v1/${path}`,
        query: "?orgId=org",
        key,
        bearer: "Bearer proxy-fixture",
        cookie: null,
        body,
      });
    }
    const before = received.length;
    for (const [method, path] of [
      ["GET", `orchestrators/${id}/message`],
      ["POST", `orchestrators/${id}/events`],
      ["GET", "orchestrators/private"],
      ["POST", `orchestrators/${id}/callback`],
      ["POST", `orchestrators/${id}/resume/extra`],
      ["GET", `orchestrators/${id}/recover`],
      ["POST", `orchestrators/${id}/waits/not-a-uuid/renew`],
      ["POST", `orchestrators/${id}/waits/${id}/unknown`],
      ["GET", `orchestrators/${id}/waits/${id}/renew`],
      ["GET", "internal/runner/auth-state"],
    ]) {
      const response = await fetch(new URL(`/api/v1/${path}`, publicOrigin.url), {
        method,
        headers: { authorization: "Bearer proxy-fixture" },
      });
      expect(response.status).toBe(404);
    }
    expect(received).toHaveLength(before);
    const redirect = await fetch(new URL("/api/v1/auth/authorize?provider=github&state=retained", publicOrigin.url), {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://identity.invalid/authorize");
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
    await publicOrigin.stop(true);
    await upstream.stop(true);
  }
});

test("orchestrator body limit counts streamed UTF-8 bytes and never sends oversized input upstream", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  let sent = 0;
  try {
    const response = await forwardControl(
      new Request("https://dashboard.test/api/v1/orchestrators", {
        method: "POST",
        headers: { authorization: "Bearer proxy-fixture" },
        body: "é".repeat(70_000),
      }),
      ["orchestrators"],
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
