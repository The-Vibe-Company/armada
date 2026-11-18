import { expect, test } from "bun:test";
import { CONTROL_BODY_MAX_BYTES, PUBLIC_CONTROL_ROUTES } from "@armada/core";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";
import { POST } from "../src/app/api/v1/[...path]/route.ts";

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
    ["DELETE", ["unknown", id]],
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
    ["sandbox", "delete"],
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
      ["sandbox/launch", '{ "golden": "golden-id", "size": "medium" }'],
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

// Golden configs can exceed the generic 128 KiB proxy bound; keep the backend's byte limit for this route only.
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

test("the SDK keeps the drain refusal's Retry-After through the dashboard proxy, and malformed delays are dropped", async () => {
  const { Armada, ArmadaError } = await import("../../../packages/sdk/src/index.ts");
  const { createServerRequestDrain } = await import("../../../packages/mcp-server/src/server-request-drain.ts");
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const drain = createServerRequestDrain(async () => Response.json({}));
  drain.beginDrain();
  let upstreamCalls = 0;
  const client = new Armada({
    token: "service_placeholder",
    url: "https://dashboard.test",
    readRetries: 3,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname.replace(/^\/api\/v1\//, "").split("/");
      return forwardControl(request, path, async (target, upstreamInit) => {
        upstreamCalls++;
        return drain.fetch(new Request(target, upstreamInit));
      });
    }) as import("../../../packages/sdk/src/index.ts").Fetch,
  });
  const error = await client.stop({ id: "sandbox_placeholder" }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArmadaError);
  expect(error).toMatchObject({ code: "unavailable", status: 503, outcomeUnknown: false, retryAfterSeconds: 5 });
  expect(upstreamCalls).toBe(1);
  for (const [upstream, forwarded] of [
    ["Wed, 21 Oct 2026 07:28:00 GMT", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["soon", null],
    ["-5", null],
  ] as const) {
    const response = await forwardControl(
      new Request("https://dashboard.test/api/v1/golden/list", {
        method: "POST",
        headers: { authorization: "Bearer masked" },
        body: "{}",
      }),
      ["golden", "list"],
      async () => new Response("{}", { status: 503, headers: { "retry-after": upstream } }),
    );
    expect(response.headers.get("retry-after")).toBe(forwarded);
  }
});

test("proxy-generated failures match the published failure schema and decode to typed SDK codes", async () => {
  const { publishedFailure } = await import("../../../packages/mcp-server/test/published-response.ts");
  const { Armada, ArmadaError } = await import("../../../packages/sdk/src/index.ts");
  const failure = publishedFailure();
  const env = process.env.ARMADA_MCP_URL;
  const decode = async (
    response: Response,
  ): Promise<{ status: number; valid: boolean; code: unknown; outcomeUnknown: unknown }> => {
    const body = await response.clone().json();
    const client = new Armada({
      token: "service_placeholder",
      url: "https://dashboard.test",
      fetch: async () => response,
    });
    const error = await client.status({ id: "sandbox_placeholder" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArmadaError);
    const typed = error as InstanceType<typeof ArmadaError>;
    return {
      status: response.status,
      valid: failure.safeParse(body).success,
      code: typed.code,
      outcomeUnknown: typed.outcomeUnknown,
    };
  };
  const request = (headers: Record<string, string>, body: BodyInit = "{}") =>
    new Request("https://dashboard.test/api/v1/sandbox/status", { method: "POST", headers, body });
  try {
    delete process.env.ARMADA_MCP_URL;
    const unconfigured = await decode(
      await forwardControl(request({ authorization: "Bearer masked" }), ["sandbox", "status"]),
    );
    process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
    const unreachable = await decode(
      await forwardControl(request({ authorization: "Bearer masked" }), ["sandbox", "status"], async () => {
        throw new TypeError("connection refused");
      }),
    );
    const anonymous = await decode(await forwardControl(request({}), ["golden", "list"]));
    const oversized = await decode(
      await forwardControl(request({ authorization: "Bearer masked" }, "x".repeat(128 * 1024 + 1)), [
        "sandbox",
        "status",
      ]),
    );
    const unknown = await decode(await forwardControl(request({ authorization: "Bearer masked" }), ["no", "such"]));
    expect([unconfigured, unreachable, anonymous, oversized, unknown]).toEqual([
      { status: 503, valid: true, code: "dependency_unavailable", outcomeUnknown: false },
      { status: 502, valid: true, code: "upstream", outcomeUnknown: false },
      { status: 401, valid: true, code: "unauthorized", outcomeUnknown: false },
      { status: 413, valid: true, code: "invalid", outcomeUnknown: false },
      { status: 404, valid: true, code: "unknown_route", outcomeUnknown: false },
    ]);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

/** A concrete request path for an OpenAPI or proxy route template. */
const fillParameters = (template: string) =>
  template.replace("{id}", "11111111-1111-4111-8111-111111111111").replace("{name}", "memo%20v2.pdf");

test("every operation in the published OpenAPI description crosses the public proxy with a bearer", async () => {
  const published = (await import("../../../docs/openapi.json")).default as {
    paths: Record<string, Record<string, unknown>>;
  };
  const env = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  try {
    const operations = Object.entries(published.paths).flatMap(([path, verbs]) =>
      Object.keys(verbs).map((verb) => ({ path, verb: verb.toUpperCase() })),
    );
    expect(operations.length).toBeGreaterThan(0);
    const blocked: string[] = [];
    for (const { path: template, verb } of operations) {
      const path = fillParameters(template);
      const forwarded: string[] = [];
      const response = await forwardControl(
        new Request(`https://dashboard.test${path}`, {
          method: verb,
          headers: { authorization: "Bearer masked", "content-type": "application/json" },
          ...(verb === "POST" ? { body: "{}" } : {}),
        }),
        path.replace(/^\/api\/v1\//, "").split("/"),
        async (target) => {
          forwarded.push(new URL(target).pathname);
          return Response.json({});
        },
      );
      if (response.status !== 200 || forwarded[0] !== path) blocked.push(`${verb} ${path}`);
    }
    expect(blocked).toEqual([]);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("every route the public proxy forwards is published or has a recorded reason to stay outside the description", async () => {
  const published = (await import("../../../docs/openapi.json")).default as {
    paths: Record<string, Record<string, unknown>>;
  };
  const { PARAMETERIZED_CONTROL_ROUTES, PRIVATE_POST_PATHS } = await import(
    "../src/app/api/v1/[...path]/control-proxy.ts"
  );
  const { UNPUBLISHED_REST_ROUTES, unpublishedReason } = await import(
    "../../../packages/mcp-server/src/public-rest-routes.ts"
  );
  const publishedOperations = Object.entries(published.paths).flatMap(([path, verbs]) =>
    Object.keys(verbs).map((verb) => `${verb.toUpperCase()} ${path.replace(/^\/api\/v1\//, "")}`),
  );
  const publishedRoutes = publishedOperations.map((operation) => operation.split(" ")[1]!);
  const operations = [
    ...[...PRIVATE_POST_PATHS].map((path) => ({ method: "POST", path })),
    ...Object.entries(PUBLIC_CONTROL_ROUTES).flatMap(([path, methods]) => methods.map((method) => ({ method, path }))),
    ...PARAMETERIZED_CONTROL_ROUTES,
  ];
  // Each parameterized shape really is forwarded, so this list cannot drift from the proxy's matchers.
  const env = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  try {
    for (const { method, path } of PARAMETERIZED_CONTROL_ROUTES) {
      const url = `https://dashboard.test/api/v1/${fillParameters(path)}`;
      const upstream: string[] = [];
      const response = await forwardControl(
        new Request(url, { method, headers: { authorization: "Bearer masked" } }),
        new URL(url).pathname
          .replace(/^\/api\/v1\//, "")
          .split("/")
          .map(decodeURIComponent),
        async (target) => {
          upstream.push(new URL(target).pathname);
          return Response.json({});
        },
      );
      expect([method, path, response.status, upstream]).toEqual([method, path, 200, [new URL(url).pathname]]);
    }
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
  const forwarded = operations.map(({ path }) => path);
  expect(
    operations
      .filter(({ method, path }) => !publishedOperations.includes(`${method} ${path}`) && !unpublishedReason(path))
      .map(({ method, path }) => `${method} ${path}`),
  ).toEqual([]);
  expect(publishedRoutes.filter((route) => unpublishedReason(route) !== undefined)).toEqual([]);
  // A reason for a route the proxy no longer forwards would hide nothing; drop it instead.
  expect(
    Object.keys(UNPUBLISHED_REST_ROUTES).filter((key) =>
      key.endsWith("/") ? !forwarded.some((route) => route.startsWith(key)) : !forwarded.includes(key),
    ),
  ).toEqual([]);
});

test("a keyed Docker send prompt the published variant admits crosses the proxy, and one it refuses never reaches upstream", async () => {
  const { publishedRequest } = await import("../../../packages/mcp-server/test/published-response.ts");
  const docker = publishedRequest("sandbox/send", "Docker sandbox send");
  const id = "11111111-1111-4111-8111-111111111111";
  const body = (bytes: number) => ({ org: id, id, prompt: "x".repeat(bytes), request_id: id });
  const env = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  let sent = 0;
  const send = (input: object) =>
    forwardControl(
      new Request("https://dashboard.test/api/v1/sandbox/send", {
        method: "POST",
        headers: { authorization: "Bearer proxy-fixture" },
        body: JSON.stringify(input),
      }),
      ["sandbox", "send"],
      async () => {
        sent++;
        return Response.json({ ok: true });
      },
    );
  try {
    // Under Docker's 256 KiB admission limit, but over the public body limit.
    const oversized = body(150 * 1024);
    expect(docker.safeParse(oversized).success).toBe(false);
    expect((await send(oversized)).status).toBe(413);
    expect(sent).toBe(0);
    const fits = body(CONTROL_BODY_MAX_BYTES - 1024);
    expect(docker.safeParse(fits).success).toBe(true);
    expect((await send(fits)).status).toBe(200);
    expect(sent).toBe(1);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("GET proxy forwards the authenticated sandbox outputs list and download with the encoded filename intact", async () => {
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const id = "11111111-1111-4111-8111-111111111111";
  // The server matches lowercase identifiers only; the proxy admits exactly what it serves.
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
  // Next decodes catch-all segments; the raw request path keeps the filename as one segment.
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
