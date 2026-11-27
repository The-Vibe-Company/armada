import { expect, test } from "bun:test";
import { operations } from "@armada/core/contract";
import { CONTROL_BODY_MAX_BYTES, VAULT_CONTROL_BODY_MAX_BYTES } from "@armada/core/server";
import { z } from "zod";
import releasePlease from "../../../release-please-config.json";
import published from "../openapi.json";
import adminPublished from "../openapi-admin.json";
import { generateOpenApi } from "../src/openapi.ts";

test("release version bumps update the published OpenAPI version with core", () => {
  const extraFiles = releasePlease.packages["."]["extra-files"];
  expect(extraFiles).toContainEqual({ type: "json", path: "packages/core/package.json", jsonpath: "$.version" });
  for (const file of ["openapi.json", "openapi-admin.json"]) {
    expect(extraFiles).toContainEqual({
      type: "json",
      path: `packages/mcp-server/${file}`,
      jsonpath: "$.info.version",
    });
  }
});

test("published OpenAPI matches current server contracts and preserves REST field names", async () => {
  const document = await generateOpenApi();
  expect(document).toEqual(published);
  const paths = document.paths as Record<
    string,
    {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { properties?: Record<string, unknown>; oneOf?: { properties: Record<string, unknown> }[] };
            };
          };
        };
      };
    }
  >;
  const logs = paths["/api/v1/logs/read"]!.post;
  expect(JSON.stringify(logs)).toContain("Pass the returned cursor as cursor");
  expect(JSON.stringify(logs)).not.toMatch(/\bsince_cursor\b/);
  const logsInput = logs.requestBody.content["application/json"].schema.properties!;
  expect(logsInput.cursor).toBeDefined();
  expect(logsInput).not.toHaveProperty("conversationId");
  expect(logsInput).not.toHaveProperty("conversation_id");
  for (const route of ["sandbox/steer", "sandbox/interrupt"]) {
    const input = paths[`/api/v1/${route}`]!.post.requestBody.content["application/json"].schema.properties!;
    expect(input).not.toHaveProperty("conversationId");
    expect(input).not.toHaveProperty("conversation_id");
  }
  const sendInput = paths["/api/v1/sandbox/send"]!.post.requestBody.content["application/json"].schema;
  expect(JSON.stringify(sendInput)).not.toContain('"conversation_id"');
  expect(logsInput.follow).toEqual({
    type: "boolean",
    description: "Follow events within the bounded HTTP request.",
  });
});

test("published event cursor schemas enforce the PostgreSQL bigint bound", () => {
  const { parameters } = published.paths["/api/v1/events"].get;
  for (const name of ["cursor", "Last-Event-ID"]) {
    const parameter = parameters.find((item) => item.name === name)!;
    const pattern = new RegExp(parameter.schema.pattern);
    for (const value of ["0", "999999999999999999", "1000000000000000000", "9223372036854775807"]) {
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of ["", "-1", "01", "9223372036854775808", "9300000000000000000", "10000000000000000000"]) {
      expect(pattern.test(value)).toBe(false);
    }
  }
});

test("GitHub OAuth publishes both bearer-free callback transports and the relay's refusal", () => {
  const { get, post } = published.paths["/api/v1/github/oauth/callback"];
  expect(get.security).toEqual([]);
  expect(post.security).toEqual([]);
  expect(get.parameters.map(({ name, required }) => [name, required])).toEqual([
    ["state", true],
    ["code", true],
  ]);
  expect(post.requestBody).toMatchObject({
    "x-max-body-bytes": 8192,
    "x-oversized-body-status": 400,
    content: { "application/json": { schema: { required: ["state", "code"], additionalProperties: false } } },
  });
  expect(post.responses["400"].content["application/json"].schema.anyOf).toContainEqual(
    expect.objectContaining({
      properties: { ok: { const: false, type: "boolean" }, status: { const: "failed", type: "string" } },
    }),
  );
});

test("every published operation states the body limit both public boundaries enforce", () => {
  type Operation = {
    post?: {
      requestBody: { "x-max-body-bytes": number; "x-oversized-body-status": number };
      responses: Record<string, unknown>;
    };
  };
  const limits = Object.fromEntries(
    Object.entries(published.paths as unknown as Record<string, Operation>).flatMap(([path, { post }]) => {
      if (!post?.requestBody?.["x-max-body-bytes"]) return [];
      expect(post.responses[post.requestBody["x-oversized-body-status"]]).toBeDefined();
      return [[path, post.requestBody["x-max-body-bytes"]]];
    }),
  );
  expect(limits["/api/v1/sandbox/send"]).toBe(CONTROL_BODY_MAX_BYTES);
  // Template routes are read with the server's stricter vault body limit.
  expect(limits["/api/v1/templates/launch"]).toBe(VAULT_CONTROL_BODY_MAX_BYTES);
});

test("published OpenAPI keeps the plain JSON layout that release version bumps write", async () => {
  // Release Please rewrites extra JSON files with JSON.stringify(_, null, 2); any other layout breaks the release PR's checks.
  for (const file of ["openapi.json", "openapi-admin.json"]) {
    const text = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  }
});

test("published 503 schema accepts the real drain refusal and a structured unavailable failure", async () => {
  const { z } = await import("zod");
  const { AuthUnavailable } = await import("../src/caller.ts");
  const { controlFailureResponse } = await import("../src/control-errors.ts");
  const { createServerRequestDrain } = await import("../src/server-request-drain.ts");
  type Operation = { post: { responses: Record<string, { content: { "application/json": { schema: unknown } } }> } };
  const schemas = published.components.schemas as Record<string, unknown>;
  // Inline component references so the validator sees the document as published.
  const inline = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(inline);
    if (!value || typeof value !== "object") return value;
    const ref = (value as { $ref?: string }).$ref;
    if (ref) return inline(schemas[ref.replace("#/components/schemas/", "")]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inline(item)]));
  };
  const refusal = z.fromJSONSchema(
    inline(
      (published.paths as unknown as Record<string, Operation>)["/api/v1/sandbox/stop"]!.post.responses["503"]!.content[
        "application/json"
      ].schema,
    ) as Parameters<typeof z.fromJSONSchema>[0],
  );
  const tracker = createServerRequestDrain(async () => new Response(null));
  tracker.beginDrain();
  const drained = await tracker.fetch(new Request("https://server.test/api/v1/sandbox/stop", { method: "POST" }));
  expect(drained.status).toBe(503);
  expect(drained.headers.get("retry-after")).toBe("5");
  expect(refusal.safeParse(await drained.json()).success).toBe(true);
  const structured = controlFailureResponse(new AuthUnavailable("synthetic outage"));
  expect(structured.status).toBe(503);
  expect(refusal.safeParse(await structured.json()).success).toBe(true);
  expect(refusal.safeParse({ error: "something_else" }).success).toBe(false);
});

test("published launch request keeps golden, pinned Modal template and Docker sources distinct", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const { requestBody } = published.paths["/api/v1/sandbox/launch"].post;
  const variants = requestBody.content["application/json"].schema.oneOf;
  expect(variants.length).toBeGreaterThan(1);
  for (const variant of variants) {
    expect(variant.properties.prompt.maxLength).toBeLessThanOrEqual(requestBody["x-max-body-bytes"]);
  }
  const launch = publishedRequest("sandbox/launch");
  const org = "11111111-1111-4111-8111-111111111111";
  const golden = { golden: "web", harness: "codex", org };
  expect(launch.safeParse(golden).success).toBe(false);
  for (const provider of ["boat", "modal"]) {
    expect(launch.safeParse({ ...golden, provider, org: "team" }).success).toBe(true);
  }
  expect(launch.safeParse({ ...golden, provider: "boat", boatRuntime: true, runtimeVersion: 1 }).success).toBe(true);
  expect(launch.safeParse({ ...golden, provider: "modal", modalTransport: "dialout", runtimeVersion: 1 }).success).toBe(
    true,
  );
  expect(launch.safeParse({ ...golden, provider: "modal", boatRuntime: true, runtimeVersion: 1 }).success).toBe(false);
  const template = {
    org,
    id: org,
    revision: 1,
    idempotencyKey: "probe".padEnd(16, "_"),
    provider: "modal",
    harness: "codex",
    modalTransport: "dialout",
    runtimeVersion: 1,
  };
  expect(launch.safeParse(template).success).toBe(true);
  expect(launch.safeParse({ ...template, org: "team" }).success).toBe(true);
  const { org: _org, ...templateWithoutOrg } = template;
  expect(launch.safeParse(templateWithoutOrg).success).toBe(true);
  expect(launch.safeParse({ ...template, golden: "web" }).success).toBe(false);
  const docker = { org, provider: "docker", hostId: org, harness: "codex", idempotencyKey: org };
  expect(launch.safeParse(docker).success).toBe(true);
  // The Docker handler refuses fields it does not know, including a golden or an image.
  expect(launch.safeParse({ ...docker, golden: "web" }).success).toBe(false);
  expect(launch.safeParse({ ...docker, image: "busybox" }).success).toBe(false);
  expect(launch.safeParse({ golden: "web", harness: "codex", provider: "docker" }).success).toBe(false);
});

test("published Docker launch requests require an idempotency key and validate external references", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const launch = publishedRequest("sandbox/launch");
  const id = "11111111-1111-4111-8111-111111111111";
  for (const placement of [{ hostId: id }, { snapshotId: id }]) {
    const body = { provider: "docker", harness: "codex", ...placement };
    const keyed = { ...body, idempotencyKey: "customer_launch_1", externalRef: "customer:42" };
    expect(launch.safeParse(keyed).success).toBe(true);
    expect(launch.safeParse(body).success).toBe(false);
    expect(launch.safeParse({ ...keyed, requestId: id }).success).toBe(false);
    expect(launch.safeParse({ ...keyed, idempotencyKey: "short" }).success).toBe(false);
    expect(launch.safeParse({ ...keyed, externalRef: "customer\n42" }).success).toBe(false);
  }
});

test("published Docker launch request accepts the mixed-case UUIDs launch admission normalizes", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const launch = publishedRequest("sandbox/launch");
  // JSON Schema drops regex flags, so the published pattern itself must allow both cases.
  const id = "ABCDEF12-0000-4000-8000-00000000000a";
  const base = { org: id, provider: "docker", harness: "codex", idempotencyKey: id };
  expect(launch.safeParse({ ...base, hostId: id }).success).toBe(true);
  expect(launch.safeParse({ ...base, snapshotId: id }).success).toBe(true);
  expect(launch.safeParse({ ...base, hostId: "ABCDEF12-0000-4000-8000-00000000000g" }).success).toBe(false);
});

test("the published template launch request accepts CLI model accounts and bounds text fields", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const id = "11111111-1111-4111-8111-111111111111";
  // The CLI's `templates launch --model-account` body.
  const cli = { org: id, id, requestKey: "k", modelAccount: { id, version: 1 }, externalRef: "tender:1" };
  const templateLaunch = publishedRequest("templates/launch");
  expect(templateLaunch.safeParse(cli).success).toBe(true);
  expect(templateLaunch.safeParse({ ...cli, requestKey: "invalid key" }).success).toBe(false);
  expect(templateLaunch.safeParse({ ...cli, repo: "x".repeat(201) }).success).toBe(false);
  expect(templateLaunch.safeParse({ ...cli, prompt: "hello\0world" }).success).toBe(false);
});

test("published extension request accepts either lifetime field and nullable org, and refuses both fields together", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const extend = publishedRequest("sandbox/extend");
  const sandbox = { id: "sandbox", org: null };
  expect(extend.safeParse({ ...sandbox, ttlSeconds: 60 }).success).toBe(true);
  expect(extend.safeParse({ ...sandbox, ttl_seconds: 60 }).success).toBe(true);
  expect(extend.safeParse({ ...sandbox, ttlSeconds: 60, ttl_seconds: 60 }).success).toBe(false);
});

test("the integration projection merges methods on one path and excludes admin operations", () => {
  const entry = {
    name: "example",
    route: { method: "GET", path: "/api/v1/sandboxes/{id}" },
    input: { body: z.undefined(), path: { id: z.string() } },
    output: z.object({ value: z.string() }),
    readOnly: true,
    destructive: false,
    description: "Example",
    errors: [],
    audience: "public",
  } as const;
  const { paths } = generateOpenApi({
    table: [
      entry,
      { ...entry, name: "deleteExample", route: { ...entry.route, method: "DELETE" } },
      { ...entry, name: "adminExample", route: { ...entry.route, method: "PUT" }, audience: "admin" },
    ],
  });
  expect(paths).toEqual({
    "/api/v1/sandboxes/{id}": {
      get: expect.objectContaining({
        operationId: "example",
        parameters: [expect.objectContaining({ name: "id", in: "path", required: true })],
        responses: expect.objectContaining({
          "200": expect.objectContaining({
            content: { "application/json": { schema: expect.objectContaining({ required: ["value"] }) } },
          }),
        }),
      }),
      delete: expect.objectContaining({ operationId: "sandbox_delete" }),
    },
  });
});

test("the published administrative document contains exactly the table's admin methods", () => {
  expect(generateOpenApi({ projection: "admin" })).toEqual(adminPublished);
  const publishedMethods = Object.entries(adminPublished.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
  const adminMethods = Object.values(operations)
    .filter(({ audience }) => audience === "admin")
    .map(({ route }) => `${route.method} ${route.path}`);
  expect(publishedMethods.sort()).toEqual(adminMethods.sort());
});

test("the administrative document describes direct trigger creation and its one-time secret response", () => {
  const trigger = adminPublished.paths["/api/v1/triggers"].post;
  expect(trigger).toMatchObject({
    "x-armada-direct-server": true,
    requestBody: { "x-max-body-bytes": 4096, "x-oversized-body-status": 400 },
    responses: {
      "400": expect.any(Object),
      "201": { headers: { "Cache-Control": { schema: { const: "no-store" } } } },
    },
  });
  expect(trigger.responses).not.toHaveProperty("413");
});

test("the published trigger UUID schemas accept uppercase input", () => {
  const trigger = adminPublished.paths["/api/v1/triggers"].post;
  const org = trigger.parameters.find(({ name }) => name === "org")!;
  const { templateId } = trigger.requestBody.content["application/json"].schema.properties;
  const uppercase = "ABCDEF12-0000-4000-8000-00000000000A";
  for (const schema of [org.schema, templateId]) {
    expect(uppercase).toMatch(new RegExp(schema.pattern));
  }
});

test("the CLI consent operations require a personal session in the public document", () => {
  for (const route of [
    "/api/v1/auth/device/inspect",
    "/api/v1/auth/device/decide",
    "/api/v1/sandbox/list-turns",
  ] as const)
    expect(published.paths[route].post.security).toEqual([{ personalSession: [] }]);
  expect(published.components.securitySchemes.personalSession).toMatchObject({ type: "http", scheme: "bearer" });
  const statusSchema =
    published.paths["/api/v1/sandbox/status"].post.responses["200"].content["application/json"].schema;
  expect(statusSchema.required).toContain("provider");
  expect(statusSchema.properties.provider.enum).toEqual(["boat", "modal", "docker"]);
});

test("the administrative logout document requires a personal session", () => {
  expect(adminPublished.paths["/api/v1/account/logout"].post.security).toEqual([{ personalSession: [] }]);
  expect(adminPublished.components.securitySchemes.personalSession).toMatchObject({ type: "http", scheme: "bearer" });
});

test("scoped REST advertises the grants, idempotency headers and body refusal used on the server", () => {
  const prefix = "/api/v1/orchestrator-tools";
  for (const [method, needsKey] of [
    ["finish", false],
    ["launch", true],
    ["read", false],
    ["message", true],
    ["stop", true],
    ["extend", true],
  ] as const) {
    const operation = published.paths[`${prefix}/${method}`].post;
    expect(operation.security).toEqual(
      method === "finish" ? [{ epochGrant: [] }, { finishGrant: [] }] : [{ epochGrant: [] }],
    );
    expect(operation).toMatchObject({
      "x-armada-direct-server": true,
      requestBody: { "x-max-body-bytes": 128 * 1024, "x-oversized-body-status": 400 },
      responses: { "400": expect.any(Object) },
    });
    expect(operation.responses).not.toHaveProperty("413");
    if (needsKey) {
      expect(operation).toHaveProperty("parameters", [
        expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
      ]);
    } else {
      expect(operation).not.toHaveProperty("parameters");
    }
  }
  expect(published.paths).not.toHaveProperty(`${prefix}/mcp`);
});

test("published Skillpack versions pairs each source with its reference and advertises both bearer schemes", () => {
  const operation = adminPublished.paths["/api/v1/skillpack/versions"].post;
  expect(operation.security).toEqual([{ serviceToken: [] }, { personalSession: [] }]);
  expect(operation.responses["413"]).toBeDefined();
  const input = z.fromJSONSchema(
    operation.requestBody.content["application/json"].schema as Parameters<typeof z.fromJSONSchema>[0],
  );
  for (const [source, reference, accepted] of [
    ["public", "team/notes", true],
    ["private", "notes", true],
    ["public", "notes", false],
    ["private", "team/notes", false],
    ["public", "team/armada-tools", false],
    ["private", "", false],
    ["private", "x".repeat(129), false],
    ["public", `${"x".repeat(128)}/${"y".repeat(122)}`, false],
  ] as const) {
    expect(input.safeParse({ source, reference }).success).toBe(accepted);
  }
});

test("published GitHub repos operation requires a personal session, advertises no-store, and validates filters", () => {
  const operation = adminPublished.paths["/api/v1/github/repos"].post;
  expect(operation.security).toEqual([{ personalSession: [] }]);
  expect(operation.responses["200"].headers["Cache-Control"].schema).toMatchObject({
    type: "string",
    const: "no-store",
  });
  const input = z.fromJSONSchema(
    operation.requestBody.content["application/json"].schema as Parameters<typeof z.fromJSONSchema>[0],
  );
  expect(input.safeParse({}).success).toBe(true);
  expect(input.safeParse({ account: "acme_emu", query: "api", limit: 50 }).success).toBe(true);
  expect(input.safeParse({ account: "bad/org" }).success).toBe(false);
  expect(input.safeParse({ limit: 501 }).success).toBe(false);
  expect(input.safeParse({ unknown: true }).success).toBe(false);
});
