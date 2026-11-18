import {
  API_FAILURE_STATUS,
  CONTROL_BODY_MAX_BYTES,
  controlBodyMaxBytes,
  VERSION,
  vaultControlRoute,
} from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { z } from "zod";
import { CONTROL_TOOL_ROUTES } from "./control-tool-routes.ts";
import { DOCKER_HOST_LAUNCH_REQUEST, DOCKER_SNAPSHOT_LAUNCH_REQUEST } from "./docker-launch-request-schema.ts";
import { DOCKER_SEND_REQUEST } from "./docker-send-request-schema.ts";
import {
  GOLDEN_LIST_RESPONSE,
  LAUNCH_OPTIONS_RESPONSE,
  REST_LAUNCH_RESPONSE,
  REST_LOGS_RESPONSE,
  requestJsonSchema,
  responseJsonSchema,
  TEMPLATE_LAUNCH_RESPONSE,
} from "./launch-response-schemas.ts";
import { PUBLISHED_REST_ROUTES } from "./public-rest-routes.ts";
import { DRAIN_REFUSAL } from "./server-request-drain.ts";
import { createArmadaServer, type ToolContext } from "./tools.ts";

/** MCP input names that the REST adapters (`control.ts`, `control-logs.ts`) accept under another name. */
export const REST_FIELD_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "sandbox/launch": { ttl_seconds: "ttlSeconds", reasoning_effort: "reasoningEffort" },
  "logs/read": { since_cursor: "cursor", conversation_id: "conversationId" },
};
/** REST routes whose contract is the named MCP tool, beyond the dispatcher's shared-tool table. */
const REST_TOOL_ROUTES: Readonly<Record<string, string>> = {
  ...CONTROL_TOOL_ROUTES,
  "golden/list": "golden_list",
  "sandbox/launch": "launch",
  "templates/launch": "template_launch",
  "logs/read": "logs",
};
/** HTTP 200 bodies that differ from the MCP tool output (or that have no tool). */
const REST_RESPONSES: Readonly<Record<string, z.ZodType>> = {
  "launch/options": LAUNCH_OPTIONS_RESPONSE,
  "golden/list": GOLDEN_LIST_RESPONSE,
  "sandbox/launch": REST_LAUNCH_RESPONSE,
  "templates/launch": TEMPLATE_LAUNCH_RESPONSE,
  "logs/read": REST_LOGS_RESPONSE,
};
/** Handled directly by the REST dispatcher, not through an MCP tool. */
const REST_ONLY: Readonly<
  Record<string, { description: string; input: { type: "object"; properties: Record<string, object> } }>
> = {
  "launch/options": {
    description:
      "What a launch can ask for on this server: harnesses with their models and credential kinds, machine sizes, TTL limits, and each provider's launch sources and capabilities. Read it before offering launch choices.",
    input: { type: "object", properties: {} },
  },
};
/** Fields a REST handler accepts beyond its MCP tool's input. */
const REST_EXTRA_FIELDS: Readonly<Record<string, Readonly<Record<string, object>>>> = {
  "logs/read": { follow: { type: "boolean", description: "Follow events within the bounded HTTP request." } },
  "templates/launch": {
    modelAccount: {
      type: "object",
      required: ["id", "version"],
      additionalProperties: false,
      properties: { id: { type: "string", format: "uuid" }, version: { type: "integer", minimum: 1 } },
      description:
        "Model credential account to run with, by id and version, when the revision pins none. Refused when the revision pins one.",
    },
    externalRef: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Opaque caller reference recorded on the sandbox, 1 to 200 characters without control characters. Refused for Docker templates.",
    },
  },
};
/**
 * Bound a top-level string field by the route's serialized-body limit: no longer string
 * can arrive through either public boundary, whatever the handler itself would admit.
 * maxLength counts characters, so it is only an upper bound: the rest of the body, JSON
 * escaping and multibyte UTF-8 lower the real ceiling.
 */
function boundByBody(schema: Record<string, unknown>, field: string, maxBytes: number, description?: string) {
  const property = (schema.properties as Record<string, Record<string, unknown>> | undefined)?.[field];
  if (!property) throw new Error(`No ${field} field to bound`);
  property.maxLength = Math.min(typeof property.maxLength === "number" ? property.maxLength : maxBytes, maxBytes);
  if (description) property.description = description;
}
/** MCP tool names in shared prose, as the REST routes that serve them. */
const REST_PROSE_NAMES: Readonly<Record<string, string>> = { golden_list: "golden/list" };
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
    for (const route of PUBLISHED_REST_ROUTES) {
      const restOnly = REST_ONLY[route];
      const tool = tools.find((tool) => tool.name === REST_TOOL_ROUTES[route]);
      if (!tool && !restOnly) throw new Error(`No registered contract for ${route}`);
      const rename = { ...REST_PROSE_NAMES, ...REST_FIELD_NAMES[route] };
      // REST handlers read their own field names (an unknown name is ignored, not
      // refused), so schema keys, required lists and prose must all use them.
      const input = restNames(structuredClone(tool?.inputSchema ?? restOnly!.input), rename);
      let description = restNames(tool?.description ?? restOnly!.description, rename);
      for (const [from, to] of Object.entries(rename)) {
        if (input.properties?.[from]) {
          input.properties[to] = input.properties[from];
          delete input.properties[from];
        }
      }
      if (REST_EXTRA_FIELDS[route]) input.properties = { ...input.properties, ...REST_EXTRA_FIELDS[route] };
      // REST selects org scope before calling shared tools.
      if (tool && route !== "templates/launch") input.properties = { ...input.properties, org: { type: "string" } };
      let request: object = input;
      const maxBodyBytes = controlBodyMaxBytes(route);
      // The server's own refusal of a body over maxBodyBytes: the vault reader's opaque 400, or 413.
      const oversizedStatus = vaultControlRoute(route) ? 400 : 413;
      if (route === "sandbox/launch") {
        // One public path, two handlers: provider "docker" is dispatched to the normal Docker launch.
        const { $schema: _golden, ...golden } = input as Record<string, unknown>;
        const docker = [DOCKER_HOST_LAUNCH_REQUEST, DOCKER_SNAPSHOT_LAUNCH_REQUEST].map((variant) => {
          const { $schema: _docker, ...schema } = requestJsonSchema(variant);
          return schema;
        });
        request = { oneOf: [golden, ...docker] };
        description +=
          ' Docker uses the other request variants: provider "docker" with no golden, either on a hostId (optionally with repos) or from a snapshotId (no repos). launch/options reports each provider\'s launch sources.';
      }
      if (route === "sandbox/send") {
        // One public path, two admissions chosen by the sandbox's provider: Docker
        // also applies its own admission rules (docker-normal-send.ts).
        const { $schema: _shared, ...shared } = input as Record<string, unknown>;
        const { $schema: _docker, ...docker } = requestJsonSchema(DOCKER_SEND_REQUEST);
        // Docker admission alone allows a 256 KiB prompt (MCP has no such body cap), but the
        // REST body limit is lower and applies first, so publish the effective bound.
        boundByBody(shared, "prompt", maxBodyBytes);
        boundByBody(
          docker,
          "prompt",
          maxBodyBytes,
          `The instruction: not blank. Over REST the whole serialized JSON request body is limited to ${maxBodyBytes} bytes, below Docker's own 256 KiB prompt admission limit, so maxLength is only an upper bound: the other fields, JSON escaping and multibyte UTF-8 count against the same limit.`,
        );
        // A Docker body must satisfy the shared send input and Docker admission.
        request = {
          anyOf: [
            { title: "Golden sandbox send", ...shared },
            { title: "Docker sandbox send", allOf: [shared, docker] },
          ],
        };
        description +=
          " A Docker sandbox admits only the Docker sandbox send variant: request_id (a lowercase UUID) is required, and model and reasoning_effort are refused because they remain pinned to launch.";
      }
      paths[`/api/v1/${route}`] = {
        post: {
          operationId: route.replaceAll("/", "_").replaceAll("-", "_"),
          description,
          security: [{ serviceToken: [] }],
          requestBody: {
            required: true,
            description: vaultControlRoute(route)
              ? `Send at most ${maxBodyBytes} bytes of serialized JSON. The server reads this route with the vault body reader and refuses a larger body with HTTP 400 (code invalid); the dashboard endpoint refuses a body over ${CONTROL_BODY_MAX_BYTES} bytes with HTTP 413. Nothing is dispatched in either case.`
              : `Send at most ${maxBodyBytes} bytes of serialized JSON. The dashboard endpoint refuses a larger body with HTTP 413 without forwarding it, and the server refuses a body over its own limit, which is never lower, with HTTP 413 before any handler runs.`,
            "x-max-body-bytes": maxBodyBytes,
            "x-oversized-body-status": oversizedStatus,
            content: { "application/json": { schema: request } },
          },
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: REST_RESPONSES[route]
                    ? responseJsonSchema(REST_RESPONSES[route])
                    : (tool?.outputSchema ?? {}),
                },
              },
            },
            ...(oversizedStatus === 400
              ? {
                  "400": {
                    description: `Invalid request, including a serialized body over ${maxBodyBytes} bytes. Nothing was dispatched.`,
                    content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
                  },
                }
              : {}),
            "413": {
              description: `The serialized request body exceeds ${CONTROL_BODY_MAX_BYTES} bytes. Nothing was dispatched.`,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
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
          "Generated integration REST contracts. Includes SDK operations, launch discovery (launch/options, golden/list) and shared-tool routes. sandbox/launch accepts a golden launch or a Docker launch. Administrative and provider-specific extensions are outside this description. Files use sandbox/exec; this description does not assert provider availability.",
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
