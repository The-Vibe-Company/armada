import { expect, test } from "bun:test";
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
    { post: { requestBody: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } } }
  >;
  // REST ignores MCP names (logs `since_cursor` would silently reread page one), so
  // no key, required entry or prose of a renamed operation may name them.
  for (const [route, rename] of Object.entries(REST_FIELD_NAMES)) {
    const operation = paths[`/api/v1/${route}`]!.post;
    const properties = operation.requestBody.content["application/json"].schema.properties;
    for (const [mcp, rest] of Object.entries(rename)) {
      expect(properties[rest]).toBeDefined();
      expect(JSON.stringify(operation)).not.toMatch(new RegExp(`\\b${mcp}\\b`));
    }
  }
  expect(JSON.stringify(paths["/api/v1/logs/read"]!.post)).toContain("Pass the returned cursor as cursor");
  expect(paths["/api/v1/logs/read"]!.post.requestBody.content["application/json"].schema.properties.follow).toEqual({
    type: "boolean",
    description: "Follow events within the bounded HTTP request.",
  });
});

test("published OpenAPI keeps the plain JSON layout that release version bumps write", async () => {
  // Release Please rewrites extra JSON files with JSON.stringify(_, null, 2); any other layout breaks the release PR's checks.
  const text = await Bun.file(new URL("../../../docs/openapi.json", import.meta.url)).text();
  expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
});
