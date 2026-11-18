import { z } from "zod";
import published from "../../../docs/openapi.json";

type Operation = { post: { responses: { "200": { content: { "application/json": { schema: unknown } } } } } };

/** The checked-in OpenAPI HTTP 200 schema of a route, as a validator for handler responses. */
export function publishedResponse(route: string): z.ZodType {
  const operation = (published.paths as Record<string, Operation>)[`/api/v1/${route}`];
  if (!operation) throw new Error(`No published route ${route}`);
  return z.fromJSONSchema(
    operation.post.responses["200"].content["application/json"].schema as Parameters<typeof z.fromJSONSchema>[0],
  );
}

/** The checked-in OpenAPI failure envelope that every non-drain public API failure must satisfy. */
export function publishedFailure(): z.ZodType {
  return z.fromJSONSchema(published.components.schemas.Failure as Parameters<typeof z.fromJSONSchema>[0]);
}

type RequestOperation = { post: { requestBody: { content: { "application/json": { schema: unknown } } } } };

/**
 * The checked-in OpenAPI request schema of a route, as a validator for the bodies real clients send.
 * With `variant`, only the `anyOf` alternative of that title.
 */
export function publishedRequest(route: string, variant?: string): z.ZodType {
  const operation = (published.paths as Record<string, RequestOperation>)[`/api/v1/${route}`];
  if (!operation) throw new Error(`No published route ${route}`);
  let schema = operation.post.requestBody.content["application/json"].schema as { anyOf?: object[] };
  if (variant !== undefined) {
    const found = schema.anyOf?.find((alternative) => (alternative as { title?: string }).title === variant);
    if (!found) throw new Error(`No published ${route} variant ${variant}`);
    schema = found;
  }
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}
