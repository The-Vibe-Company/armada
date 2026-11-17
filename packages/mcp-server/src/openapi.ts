import { API_FAILURE_STATUS, VERSION } from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CONTROL_TOOL_ROUTES } from "./control-tool-routes.ts";
import { createArmadaServer, type ToolContext } from "./tools.ts";

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
      const input = structuredClone(tool.inputSchema);
      const rename =
        route === "sandbox/launch"
          ? { ttl_seconds: "ttlSeconds", reasoning_effort: "reasoningEffort" }
          : route === "logs/read"
            ? { since_cursor: "cursor", conversation_id: "conversationId" }
            : {};
      for (const [from, to] of Object.entries(rename)) {
        if (input.properties?.[from]) {
          input.properties[to] = input.properties[from];
          delete input.properties[from];
        }
      }
      // REST selects org scope before calling shared tools.
      if (route !== "templates/launch") input.properties = { ...input.properties, org: { type: "string" } };
      paths[`/api/v1/${route}`] = {
        post: {
          operationId: route.replaceAll("/", "_").replaceAll("-", "_"),
          description: tool.description,
          security: [{ serviceToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: input } } },
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema:
                    route === "sandbox/launch"
                      ? {
                          type: "object",
                          description:
                            "REST launch receipt: sandbox, golden, promptId, conversationId, ttlSeconds, expiresAt, github and helper. Provider records may carry additional fields.",
                        }
                      : (tool.outputSchema ?? {}),
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
