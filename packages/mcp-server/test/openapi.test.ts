import { expect, test } from "bun:test";
import { CONTROL_BODY_MAX_BYTES, TEMPLATE_LAUNCH_FIELDS, VAULT_CONTROL_BODY_MAX_BYTES } from "@armada/core/server";
import releasePlease from "../../../release-please-config.json";
import published from "../openapi.json";
import { generateOpenApi, REST_FIELD_NAMES } from "../src/openapi.ts";

test("release version bumps update the published OpenAPI version with core", () => {
  const extraFiles = releasePlease.packages["."]["extra-files"];
  expect(extraFiles).toContainEqual({ type: "json", path: "packages/core/package.json", jsonpath: "$.version" });
  expect(extraFiles).toContainEqual({
    type: "json",
    path: "packages/mcp-server/openapi.json",
    jsonpath: "$.info.version",
  });
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
  // REST ignores MCP names (logs `since_cursor` would silently reread page one), so
  // no key, required entry or prose of a renamed operation may name them.
  for (const [route, rename] of Object.entries(REST_FIELD_NAMES)) {
    const operation = paths[`/api/v1/${route}`]!.post;
    // sandbox/launch publishes the golden variant first; the Docker variant has REST names only.
    const schema = operation.requestBody.content["application/json"].schema;
    const properties = schema.properties ?? schema.oneOf![0]!.properties;
    for (const [mcp, rest] of Object.entries(rename)) {
      expect(properties[rest]).toBeDefined();
      expect(JSON.stringify(operation)).not.toMatch(new RegExp(`\\b${mcp}\\b`));
    }
  }
  expect(JSON.stringify(paths["/api/v1/logs/read"]!.post)).toContain("Pass the returned cursor as cursor");
  const logsInput = paths["/api/v1/logs/read"]!.post.requestBody.content["application/json"].schema.properties!;
  expect(logsInput).not.toHaveProperty("conversationId");
  expect(logsInput).not.toHaveProperty("conversation_id");
  for (const route of ["sandbox/steer", "sandbox/interrupt"]) {
    const input = paths[`/api/v1/${route}`]!.post.requestBody.content["application/json"].schema.properties!;
    expect(input).not.toHaveProperty("conversationId");
    expect(input).not.toHaveProperty("conversation_id");
  }
  expect(logsInput.follow).toEqual({
    type: "boolean",
    description: "Follow events within the bounded HTTP request.",
  });
});

test("every published operation states the body limit both public boundaries enforce", () => {
  type Operation = { post?: { requestBody: { "x-max-body-bytes": number }; responses: Record<string, unknown> } };
  const limits = Object.fromEntries(
    Object.entries(published.paths as unknown as Record<string, Operation>).flatMap(([path, { post }]) => {
      if (!post) return [];
      expect(post.responses["413"]).toBeDefined();
      return [[path, post.requestBody["x-max-body-bytes"]]];
    }),
  );
  expect(limits["/api/v1/sandbox/send"]).toBe(CONTROL_BODY_MAX_BYTES);
  // Template routes are read with the server's stricter vault body limit.
  expect(limits["/api/v1/templates/launch"]).toBe(VAULT_CONTROL_BODY_MAX_BYTES);
});

test("published OpenAPI keeps the plain JSON layout that release version bumps write", async () => {
  // Release Please rewrites extra JSON files with JSON.stringify(_, null, 2); any other layout breaks the release PR's checks.
  const text = await Bun.file(new URL("../openapi.json", import.meta.url)).text();
  expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
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
  const launch = publishedRequest("sandbox/launch");
  const org = "11111111-1111-4111-8111-111111111111";
  const golden = { golden: "web", harness: "codex", org };
  expect(launch.safeParse(golden).success).toBe(true);
  expect(launch.safeParse({ ...golden, provider: "boat", boatRuntime: true, runtimeVersion: 1 }).success).toBe(true);
  expect(
    launch.safeParse({ ...golden, provider: "modal", runtimeTransport: "dialout", runtimeVersion: 1 }).success,
  ).toBe(true);
  expect(launch.safeParse({ ...golden, provider: "modal", boatRuntime: true, runtimeVersion: 1 }).success).toBe(false);
  const template = {
    org,
    id: org,
    revision: 1,
    requestKey: "probe",
    provider: "modal",
    harness: "codex",
    runtimeTransport: "dialout",
    runtimeVersion: 1,
  };
  expect(launch.safeParse(template).success).toBe(true);
  expect(launch.safeParse({ ...template, org: "team" }).success).toBe(true);
  const { org: _org, ...templateWithoutOrg } = template;
  expect(launch.safeParse(templateWithoutOrg).success).toBe(true);
  expect(launch.safeParse({ ...template, golden: "web" }).success).toBe(false);
  const docker = { org, provider: "docker", hostId: org, harness: "codex", requestId: org };
  expect(launch.safeParse(docker).success).toBe(true);
  // The Docker handler refuses fields it does not know, including a golden or an image.
  expect(launch.safeParse({ ...docker, golden: "web" }).success).toBe(false);
  expect(launch.safeParse({ ...docker, image: "busybox" }).success).toBe(false);
  expect(launch.safeParse({ golden: "web", harness: "codex", provider: "docker" }).success).toBe(false);
});

test("published Docker launch requests require exactly one replay key and validate external references", async () => {
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
  const base = { org: id, provider: "docker", harness: "codex", requestId: id };
  expect(launch.safeParse({ ...base, hostId: id }).success).toBe(true);
  expect(launch.safeParse({ ...base, snapshotId: id }).success).toBe(true);
  expect(launch.safeParse({ ...base, hostId: "ABCDEF12-0000-4000-8000-00000000000g" }).success).toBe(false);
});

test("published template launch request lists exactly the fields the template service accepts", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  type Operation = { post: { requestBody: { content: { "application/json": { schema: { properties: object } } } } } };
  const operation = (published.paths as unknown as Record<string, Operation>)["/api/v1/templates/launch"]!.post;
  expect(Object.keys(operation.requestBody.content["application/json"].schema.properties).sort()).toEqual(
    [...TEMPLATE_LAUNCH_FIELDS].sort(),
  );
  const id = "11111111-1111-4111-8111-111111111111";
  // The CLI's `templates launch --model-account` body.
  const cli = { org: id, id, requestKey: "k", modelAccount: { id, version: 1 }, externalRef: "tender:1" };
  expect(publishedRequest("templates/launch").safeParse(cli).success).toBe(true);
});
