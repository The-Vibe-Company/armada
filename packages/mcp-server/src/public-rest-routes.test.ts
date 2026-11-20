import { expect, test } from "bun:test";
import { CONTROL_BODY_MAX_BYTES } from "@armada/core";
import {
  accountOperations,
  operations as contractOperations,
  controlRouteKey,
  PUBLIC_CONTROL_ROUTES,
  skillDefaultOperations,
  tokenOperations,
} from "@armada/core/contract";
import {
  forwardControl,
  PARAMETERIZED_CONTROL_ROUTES,
  PRIVATE_POST_PATHS,
} from "../../../apps/dashboard/src/app/api/v1/[...path]/control-proxy.ts";

test("the SDK keeps the drain refusal's Retry-After through the dashboard proxy, and malformed delays are dropped", async () => {
  const { Armada, ArmadaError } = await import("../../sdk/src/index.ts");
  const { createServerRequestDrain } = await import("./server-request-drain.ts");
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  const drain = createServerRequestDrain(async () => Response.json({}));
  drain.beginDrain();
  let upstreamCalls = 0;
  const client = new Armada({
    token: "service_placeholder",
    url: "https://dashboard.test",
    readRetries: 3,
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const path = new URL(request.url).pathname.replace(/^\/api\/v1\//, "").split("/");
      return forwardControl(request, path, async (target, upstreamInit) => {
        upstreamCalls++;
        return drain.fetch(new Request(target.href, upstreamInit));
      });
    },
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
  const { publishedFailure } = await import("../test/published-response.ts");
  const { Armada, ArmadaError } = await import("../../sdk/src/index.ts");
  const failure = publishedFailure();
  const env = process.env.ARMADA_MCP_URL;
  const decode = async (response: Response) => {
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
  const request = (headers: Record<string, string>, body = "{}") =>
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

const fillParameters = (template: string) =>
  template.replace("{id}", "11111111-1111-4111-8111-111111111111").replace("{name}", "memo%20v2.pdf");

test("published OpenAPI and migrated admin operations follow their proxy routing", async () => {
  const published = (await import("../openapi.json")).default as {
    paths: Record<string, Record<string, { "x-armada-direct-server"?: boolean }>>;
  };
  const env = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://armada.test/mcp";
  try {
    const operations = Object.entries(published.paths).flatMap(([path, verbs]) =>
      Object.entries(verbs).map(([verb, operation]) => ({
        path,
        verb: verb.toUpperCase(),
        direct: operation["x-armada-direct-server"],
      })),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const { route } of Object.values({ ...accountOperations, ...skillDefaultOperations })) {
      expect(published.paths[route.path]?.[route.method.toLowerCase()]).toBeUndefined();
      operations.push({ path: route.path, verb: route.method, direct: false });
    }
    const blocked: string[] = [];
    for (const { path: template, verb, direct } of operations) {
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
      const expectedStatus = direct ? 404 : 200;
      if (
        response.status !== expectedStatus ||
        forwarded.length !== (direct ? 0 : 1) ||
        (!direct && forwarded[0] !== path)
      )
        blocked.push(`${verb} ${path}`);
    }
    expect(blocked).toEqual([]);
  } finally {
    if (env === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = env;
  }
});

test("every route the public proxy forwards is published or has a recorded reason to stay outside the description", async () => {
  const published = (await import("../openapi.json")).default as {
    paths: Record<string, Record<string, unknown>>;
  };
  const { UNPUBLISHED_REST_ROUTES, unpublishedReason } = await import("./public-rest-routes.ts");
  const publishedOperations = Object.entries(published.paths).flatMap(([path, verbs]) =>
    Object.keys(verbs).map((verb) => `${verb.toUpperCase()} ${path.replace(/^\/api\/v1\//, "")}`),
  );
  const adminOperations = new Set(
    Object.values(contractOperations)
      .filter(({ audience }) => audience === "admin")
      .map(({ route }) => `${route.method} ${controlRouteKey(route)}`),
  );
  const publishedRoutes = publishedOperations.map((operation) => operation.split(" ")[1]!);
  const operations = [
    ...[...PRIVATE_POST_PATHS].map((path) => ({ method: "POST", path })),
    ...Object.entries(PUBLIC_CONTROL_ROUTES).flatMap(([path, methods]) => methods.map((method) => ({ method, path }))),
    ...PARAMETERIZED_CONTROL_ROUTES,
  ];
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
      .filter(({ method, path }) => {
        const key = `${method} ${path}`;
        return !publishedOperations.includes(key) && !adminOperations.has(key) && !unpublishedReason(path);
      })
      .map(({ method, path }) => `${method} ${path}`),
  ).toEqual([]);
  expect(publishedRoutes.filter((route) => unpublishedReason(route) !== undefined)).toEqual([]);
  for (const { route } of Object.values(tokenOperations)) {
    expect(publishedOperations).not.toContain(`${route.method} ${controlRouteKey(route)}`);
  }
  expect(
    Object.keys(UNPUBLISHED_REST_ROUTES).filter((key) =>
      key.endsWith("/") ? !forwarded.some((route) => route.startsWith(key)) : !forwarded.includes(key),
    ),
  ).toEqual([]);
});

test("a keyed Docker send prompt the published variant admits crosses the proxy, and one it refuses never reaches upstream", async () => {
  const { publishedRequest } = await import("../test/published-response.ts");
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
    const oversized = body(CONTROL_BODY_MAX_BYTES + 22 * 1024);
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
