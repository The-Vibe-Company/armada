import { expect, test } from "bun:test";
import { TEMPLATE_LAUNCH_FIELDS } from "@armada/core/server";
import published from "../../../docs/openapi.json";
import releasePlease from "../../../release-please-config.json";
import { generateOpenApi, REST_FIELD_NAMES } from "../src/openapi.ts";

test("release version bumps update the published OpenAPI version with core", () => {
  const extraFiles = releasePlease.packages["."]["extra-files"];
  expect(extraFiles).toContainEqual({ type: "json", path: "packages/core/package.json", jsonpath: "$.version" });
  expect(extraFiles).toContainEqual({ type: "json", path: "docs/openapi.json", jsonpath: "$.info.version" });
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
  expect(paths["/api/v1/logs/read"]!.post.requestBody.content["application/json"].schema.properties!.follow).toEqual({
    type: "boolean",
    description: "Follow events within the bounded HTTP request.",
  });
});

test("published OpenAPI keeps the plain JSON layout that release version bumps write", async () => {
  // Release Please rewrites extra JSON files with JSON.stringify(_, null, 2); any other layout breaks the release PR's checks.
  const text = await Bun.file(new URL("../../../docs/openapi.json", import.meta.url)).text();
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
      (published.paths as Record<string, Operation>)["/api/v1/sandbox/stop"]!.post.responses["503"]!.content[
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

test("published launch request is either a golden launch or a Docker launch, never a mix", async () => {
  const { publishedRequest } = await import("./published-response.ts");
  const launch = publishedRequest("sandbox/launch");
  const org = "11111111-1111-4111-8111-111111111111";
  expect(launch.safeParse({ golden: "web", harness: "codex", org }).success).toBe(true);
  const docker = { org, provider: "docker", hostId: org, harness: "codex", requestId: org };
  expect(launch.safeParse(docker).success).toBe(true);
  // The Docker handler refuses fields it does not know, including a golden or an image.
  expect(launch.safeParse({ ...docker, golden: "web" }).success).toBe(false);
  expect(launch.safeParse({ ...docker, image: "busybox" }).success).toBe(false);
  expect(launch.safeParse({ golden: "web", harness: "codex", provider: "docker" }).success).toBe(false);
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
