import { API_FAILURE_STATUS, VERSION } from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CONTROL_TOOL_ROUTES } from "./control-tool-routes.ts";
import { REST_LAUNCH_RESPONSE, responseJsonSchema, TEMPLATE_LAUNCH_RESPONSE } from "./launch-response-schemas.ts";
import { DRAIN_REFUSAL } from "./server-request-drain.ts";
import { createArmadaServer, type ToolContext } from "./tools.ts";

/** MCP input names that the REST adapters (`control.ts`, `control-logs.ts`) accept under another name. */
export const REST_FIELD_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "sandbox/launch": { ttl_seconds: "ttlSeconds", reasoning_effort: "reasoningEffort" },
  "logs/read": { since_cursor: "cursor", conversation_id: "conversationId" },
};
/** Rewrites every string (prose and `required` entries); object keys are renamed by the caller. */
function restNames<T>(value: T, rename: Readonly<Record<string, string>>): T {
  if (typeof value === "string")
    return Object.entries(rename).reduce(
      (text, [from, to]) => text.replace(new RegExp(`\\b${from}\\b`, "g"), to),
      value as string,
    ) as T;
  if (Array.isArray(value)) return value.map((item) => restNames(item, rename)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restNames(item, rename)])) as T;
  return value;
}

/**
 * Describe shared REST operations using the very schemas registered by the server.
 * Registration performs no provider/database I/O; no tool is invoked.
 */
export async function generateOpenApi() {
  const context = { caller: { userId: "", orgs: [] }, data: {} } as unknown as ToolContext;
  const server = createArmadaServer(context, VERSION);
  const client = new Client({ name: "armada-openapi", version: VERSION });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    const paths: Record<string, unknown> = {};
    const routes = {
      ...CONTROL_TOOL_ROUTES,
      "sandbox/launch": "launch",
      "templates/launch": "template_launch",
      "logs/read": "logs",
    };
    for (const [route, name] of Object.entries(routes)) {
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`No registered contract for ${route}`);
      const rename = REST_FIELD_NAMES[route] ?? {};
      // REST handlers read their own field names (an unknown name is ignored, not
      // refused), so schema keys, required lists and prose must all use them.
      const input = restNames(structuredClone(tool.inputSchema), rename);
      const description = restNames(tool.description ?? "", rename);
      for (const [from, to] of Object.entries(rename)) {
        if (input.properties?.[from]) {
          input.properties[to] = input.properties[from];
          delete input.properties[from];
        }
      }
      if (route === "logs/read")
        input.properties = {
          ...input.properties,
          follow: { type: "boolean", description: "Follow events within the bounded HTTP request." },
        };
      // REST selects org scope before calling shared tools.
      if (route !== "templates/launch") input.properties = { ...input.properties, org: { type: "string" } };
      paths[`/api/v1/${route}`] = {
        post: {
          operationId: route.replaceAll("/", "_").replaceAll("-", "_"),
          description,
          security: [{ serviceToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: input } } },
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema:
                    route === "sandbox/launch"
                      ? responseJsonSchema(REST_LAUNCH_RESPONSE)
                      : route === "templates/launch"
                        ? responseJsonSchema(TEMPLATE_LAUNCH_RESPONSE)
                        : (tool.outputSchema ?? {}),
                },
              },
            },
            "503": {
              description:
                "Temporarily unavailable: a structured failure, or the bare refusal sent before dispatch while the server drains. Honor Retry-After when present.",
              headers: {
                "Retry-After": {
                  description: "Seconds to wait before retrying.",
                  schema: { type: "integer", minimum: 0 },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    anyOf: [{ $ref: "#/components/schemas/Failure" }, { $ref: "#/components/schemas/DrainRefusal" }],
                  },
                },
              },
            },
            default: {
              description: "Public API failure",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
            },
          },
        },
      };
    }
    return {
      openapi: "3.1.0",
      info: {
        title: "Armada shared control API",
        version: VERSION,
        description:
          "Generated integration REST contracts. Includes SDK operations and shared-tool routes. Administrative and provider-specific extensions are outside this description. Files use sandbox/exec; this description does not assert provider availability.",
      },
      paths,
      components: {
        securitySchemes: { serviceToken: { type: "http", scheme: "bearer" } },
        schemas: {
          DrainRefusal: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string", const: DRAIN_REFUSAL.body.error as string } },
          },
          Failure: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: {
                    type: "string",
                    description: "Public failure code; clients must tolerate future codes.",
                    examples: Object.keys(API_FAILURE_STATUS),
                  },
                  message: { type: "string" },
                  details: {},
                },
              },
            },
          },
        },
      },
    };
  } finally {
    await client.close();
    await server.close();
  }
}
