import { expect, test } from "bun:test";
import published from "../../../docs/openapi.json";
import { generateOpenApi } from "../src/openapi.ts";

test("published OpenAPI matches current server contracts and preserves REST field names", async () => {
  const document = await generateOpenApi();
  expect(document).toEqual(published);
  const paths = document.paths as Record<
    string,
    { post: { requestBody: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } } }
  >;
  const launch = paths["/api/v1/sandbox/launch"]!.post.requestBody.content["application/json"].schema.properties;
  expect(launch.ttlSeconds).toBeDefined();
  expect(launch.ttl_seconds).toBeUndefined();
  expect(paths["/api/v1/logs/read"]!.post.requestBody.content["application/json"].schema.properties.follow).toEqual({
    type: "boolean",
    description: "Follow events within the bounded HTTP request.",
  });
});
