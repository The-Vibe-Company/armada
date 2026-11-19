import {
  API_FAILURE_STATUS,
  CONTROL_BODY_MAX_BYTES,
  controlBodyMaxBytes,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_FILES,
  OUTPUT_MAX_ORG_BYTES,
  OUTPUT_MAX_SANDBOX_BYTES,
  VERSION,
  vaultControlRoute,
} from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { CONTROL_TOOL_ROUTES } from "./control-tool-routes.ts";
import { DOCKER_SEND_REQUEST } from "./docker-send-request-schema.ts";
import {
  GOLDEN_ADOPTION_REQUEST,
  GOLDEN_ADOPTION_RESPONSE,
  GOLDEN_CAPABILITIES_REQUEST,
  GOLDEN_CAPABILITIES_RESPONSE,
} from "./golden-rest-schemas.ts";
import { LAUNCH_REQUEST_VARIANTS } from "./launch-request-schema.ts";
import {
  GOLDEN_LIST_RESPONSE,
  LAUNCH_OPTIONS_RESPONSE,
  REST_LAUNCH_RESPONSE,
  REST_LOGS_RESPONSE,
  requestJsonSchema,
  responseJsonSchema,
  TEMPLATE_LAUNCH_RESPONSE,
} from "./launch-response-schemas.ts";
import { PUBLISHED_REST_GET_ROUTES, PUBLISHED_REST_ROUTES } from "./public-rest-routes.ts";
import { SANDBOX_REST_CONTRACTS } from "./sandbox-rest-controls.ts";
import { DRAIN_REFUSAL } from "./server-request-drain.ts";
import { createArmadaServer, type ToolContext } from "./tools.ts";

/** MCP input names that the REST adapters (`control.ts`, `control-logs.ts`) accept under another name. */
export const REST_FIELD_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "sandbox/launch": { ttl_seconds: "ttlSeconds", reasoning_effort: "reasoningEffort" },
  "sandbox/extend": { ttl_seconds: "ttlSeconds" },
  "logs/read": { since_cursor: "cursor", conversation_id: "conversationId" },
};
/** REST routes whose contract is the named MCP tool, beyond the dispatcher's shared-tool table. */
const REST_TOOL_ROUTES: Readonly<Record<string, string>> = {
  ...CONTROL_TOOL_ROUTES,
  "sandbox/launch": "launch",
  "templates/launch": "template_launch",
  "logs/read": "logs",
};
/** HTTP 200 bodies that differ from the MCP tool output (or that have no tool). */
const REST_RESPONSES: Readonly<Record<string, z.ZodType>> = {
  "launch/options": LAUNCH_OPTIONS_RESPONSE,
  "golden/list": GOLDEN_LIST_RESPONSE,
  "sandbox/delete": SANDBOX_REST_CONTRACTS["sandbox/delete"].output,
  "sandbox/advice": SANDBOX_REST_CONTRACTS["sandbox/advice"].output,
  "sandbox/recovery": SANDBOX_REST_CONTRACTS["sandbox/recovery"].output,
  "golden/adopt": GOLDEN_ADOPTION_RESPONSE,
  "golden/capabilities": GOLDEN_CAPABILITIES_RESPONSE,
  "sandbox/launch": z.union([REST_LAUNCH_RESPONSE, TEMPLATE_LAUNCH_RESPONSE]),
  "templates/launch": TEMPLATE_LAUNCH_RESPONSE,
  "logs/read": REST_LOGS_RESPONSE,
};
/** Handled directly by the REST dispatcher, not through an MCP tool. */
const REST_ONLY: Readonly<
  Record<string, { description: string; input: { properties?: Record<string, unknown>; [key: string]: unknown } }>
> = {
  "sandbox/delete": {
    description: SANDBOX_REST_CONTRACTS["sandbox/delete"].description,
    input: requestJsonSchema(SANDBOX_REST_CONTRACTS["sandbox/delete"].input.extend({ org: z.string().optional() })),
  },
  "sandbox/advice": {
    description: SANDBOX_REST_CONTRACTS["sandbox/advice"].description,
    input: requestJsonSchema(SANDBOX_REST_CONTRACTS["sandbox/advice"].input.extend({ org: z.string().optional() })),
  },
  "sandbox/recovery": {
    description: SANDBOX_REST_CONTRACTS["sandbox/recovery"].description,
    input: requestJsonSchema(SANDBOX_REST_CONTRACTS["sandbox/recovery"].input.extend({ org: z.string().optional() })),
  },
  "golden/list": {
    description:
      "The goldens you can launch from: your orgs', and your own private ones. A golden without a providerSnapshotId cannot be launched yet. The same name may exist on several providers.",
    input: requestJsonSchema(z.object({ org: z.string().optional() })),
  },
  "golden/adopt": {
    description:
      "Dry-run first: select an existing visible golden by id. Confirm with the returned receipt within ten minutes. Preserves all rows and ACLs.",
    input: requestJsonSchema(GOLDEN_ADOPTION_REQUEST),
  },
  "golden/capabilities": {
    description:
      "Reads the selected provider adapter's golden capacity without creating an App or resource. Null is unknown/unbounded, not a workspace quota.",
    input: requestJsonSchema(GOLDEN_CAPABILITIES_REQUEST),
  },
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

/** Failures of the outputs routes: the server's bare code, or the dashboard endpoint's typed failure. */
const OUTPUT_FAILURE = {
  "application/json": {
    schema: { anyOf: [{ $ref: "#/components/schemas/Failure" }, { $ref: "#/components/schemas/OutputFailure" }] },
  },
};
const SANDBOX_ID_PARAMETER = {
  name: "id",
  in: "path",
  required: true,
  description: "The sandbox id, a lowercase UUID.",
  schema: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
};
const OUTPUT_ACCESS =
  " Only the sandbox owner or an org admin can read it, the sandbox must not be deleted or application-secret tainted, and stopped compute is never read: the last snapshot taken while compute was live is served. See docs/sandbox-outputs.md.";
const OUTPUT_COMMON_RESPONSES = {
  "401": { description: "Missing or invalid bearer.", content: OUTPUT_FAILURE },
  "404": {
    description:
      "No such sandbox or file, or the caller is neither its owner nor an org admin, or the sandbox is deleted or application-secret tainted.",
    content: OUTPUT_FAILURE,
  },
  default: { description: "Public API failure", content: OUTPUT_FAILURE },
};
/** Declared output snapshots (`sandbox-outputs.ts`): GET, path parameters, no request body. */
const OUTPUT_OPERATIONS: Record<(typeof PUBLISHED_REST_GET_ROUTES)[number], object> = {
  "sandboxes/{id}/outputs": {
    get: {
      operationId: "sandbox_outputs_list",
      description: `The files of the sandbox's last output snapshot, from its declared outputs directory (${OUTPUT_DIRECTORY} on every provider), in name order.${OUTPUT_ACCESS} A sandbox.output.available webhook names a new or changed file.`,
      security: [{ serviceToken: [] }],
      parameters: [SANDBOX_ID_PARAMETER],
      responses: {
        "200": {
          description: "Success",
          headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["directory", "files", "limits"],
                additionalProperties: false,
                properties: {
                  directory: { type: "string", description: "The declared outputs directory in the sandbox." },
                  limits: {
                    type: "object",
                    required: ["maxFiles", "maxFileBytes", "maxSandboxBytes", "maxOrgBytes"],
                    additionalProperties: false,
                    properties: {
                      maxFiles: { type: "integer", const: OUTPUT_MAX_FILES },
                      maxFileBytes: { type: "integer", const: OUTPUT_MAX_FILE_BYTES },
                      maxSandboxBytes: { type: "integer", const: OUTPUT_MAX_SANDBOX_BYTES },
                      maxOrgBytes: { type: "integer", const: OUTPUT_MAX_ORG_BYTES },
                    },
                  },
                  unavailable: { type: "string", const: "collector_unsupported" },
                  files: {
                    type: "array",
                    maxItems: OUTPUT_MAX_FILES,
                    items: {
                      type: "object",
                      required: ["name", "size", "sha256", "updatedAt"],
                      additionalProperties: false,
                      properties: {
                        name: { type: "string", minLength: 1, maxLength: 255 },
                        size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                        sha256: {
                          type: ["string", "null"],
                          description: "Hex SHA-256 digest of the file bytes. Null for skipped files.",
                        },
                        skipped: { type: "string", enum: ["too_large", "sandbox_limit", "org_limit"] },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ...OUTPUT_COMMON_RESPONSES,
      },
    },
  },
  "sandboxes/{id}/outputs/{name}": {
    get: {
      operationId: "sandbox_outputs_download",
      description: `Download one file of the sandbox's last output snapshot as an attachment.${OUTPUT_ACCESS}`,
      security: [{ serviceToken: [] }],
      parameters: [
        SANDBOX_ID_PARAMETER,
        {
          name: "Range",
          in: "header",
          description: "One byte range, for example bytes=0-1023.",
          schema: { type: "string" },
        },
        {
          name: "If-Range",
          in: "header",
          description: "Apply the Range only when the file's ETag matches.",
          schema: { type: "string" },
        },
        {
          name: "name",
          in: "path",
          required: true,
          description: "The file name from the outputs list, percent-encoded as one path segment.",
          schema: { type: "string", minLength: 1 },
        },
      ],
      responses: {
        "200": {
          description: "The file bytes. Content-Type is inferred from the file name, else application/octet-stream.",
          headers: {
            ETag: { schema: { type: "string" } },
            "Accept-Ranges": { schema: { type: "string", const: "bytes" } },
            "Content-Disposition": {
              description: "attachment, with the UTF-8 file name (filename*).",
              schema: { type: "string" },
            },
            "Content-Length": { schema: { type: "integer", minimum: 0 } },
            "X-Content-Type-Options": { schema: { type: "string", const: "nosniff" } },
            "Cache-Control": { schema: { type: "string", const: "private, no-store" } },
          },
          content: { "*/*": { schema: { type: "string", contentMediaType: "application/octet-stream" } } },
        },
        "206": {
          description: "The requested byte range.",
          headers: {
            "Content-Range": { schema: { type: "string" } },
            "Content-Length": { schema: { type: "integer", minimum: 1 } },
          },
          content: { "*/*": { schema: { type: "string", contentMediaType: "application/octet-stream" } } },
        },
        "416": {
          description: "The byte range is invalid or unsatisfiable.",
          headers: { "Content-Range": { schema: { type: "string" } } },
        },
        "400": { description: "The file name is invalid.", content: OUTPUT_FAILURE },
        "503": {
          description: "Stored outputs cannot be decrypted on this server, or the API is temporarily unavailable.",
          content: OUTPUT_FAILURE,
        },
        ...OUTPUT_COMMON_RESPONSES,
      },
    },
  },
};

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
      const rename = REST_FIELD_NAMES[route] ?? {};
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
        request = {
          oneOf: LAUNCH_REQUEST_VARIANTS.map((variant) => {
            const { $schema: _dialect, ...schema } = requestJsonSchema(variant);
            boundByBody(schema, "prompt", maxBodyBytes);
            return schema;
          }),
        };
        description +=
          ' Docker uses the other request variants: provider "docker" with no golden, either on a hostId (optionally with repos) or from a snapshotId (no repos). launch/options reports each provider\'s launch sources. Explicit pinned Modal template requests return a durable template launch receipt.';
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
          " A Docker sandbox admits only the Docker sandbox send variant: model and reasoning_effort are refused because they remain pinned to launch. Supply request_id (a lowercase UUID) to replay uncertain delivery; when it is omitted the server generates one.";
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
    for (const route of PUBLISHED_REST_GET_ROUTES) paths[`/api/v1/${route}`] = OUTPUT_OPERATIONS[route];
    return {
      openapi: "3.1.0",
      info: {
        title: "Armada shared control API",
        version: VERSION,
        description:
          "Generated integration REST contracts. Includes SDK operations, launch discovery (launch/options, golden/list) and shared-tool routes. sandbox/launch accepts golden, Docker and explicit pinned Modal template launches. Administrative and provider-specific extensions are outside this description. Files use sandbox/exec while compute runs; declared output snapshots are listed and downloaded with GET sandboxes/{id}/outputs, also after stop. This description does not assert provider availability.",
      },
      paths,
      components: {
        securitySchemes: { serviceToken: { type: "http", scheme: "bearer" } },
        schemas: {
          OutputFailure: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "string",
                description: "Bare failure code answered by the outputs routes, for example not_found or invalid_name.",
              },
            },
          },
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
