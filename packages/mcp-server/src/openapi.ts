import {
  API_FAILURE_STATUS,
  CONTROL_BODY_MAX_BYTES,
  controlBodyMaxBytes,
  VERSION,
  vaultControlRoute,
} from "@armada/core";
import { controlRouteKey, type Operation, operations, sandboxOutputOperations } from "@armada/core/contract";
import { z } from "zod";
import { DOCKER_SEND_REQUEST } from "./docker-send-request-schema.ts";
import { requestJsonSchema, responseJsonSchema } from "./launch-response-schemas.ts";
import { DRAIN_REFUSAL } from "./server-request-drain.ts";

type OpenApiOperation = Operation<z.ZodType, z.ZodType | undefined>;

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
/** The mounted route, dashboard proxy, and ingress each have their own failure body. */
function outputFailure(errorOutput: z.ZodType) {
  return {
    "application/json": {
      schema: {
        anyOf: [
          responseJsonSchema(errorOutput),
          { $ref: "#/components/schemas/Failure" },
          { $ref: "#/components/schemas/DrainRefusal" },
          { type: "object", required: ["error"], properties: { error: { const: "internal" } } },
        ],
      },
    },
  };
}
const { listSandboxOutputs, readSandboxOutput } = sandboxOutputOperations;
const SANDBOX_ID_PARAMETER = {
  name: "id",
  in: "path",
  required: true,
  description: "The sandbox id, a lowercase UUID.",
  schema: requestJsonSchema(listSandboxOutputs.input.path.id),
};
const downloadFailure = outputFailure(readSandboxOutput.errorOutput);
function outputCommonResponses(content: ReturnType<typeof outputFailure>) {
  return {
    "401": { description: "Missing or invalid bearer.", content },
    "404": {
      description:
        "No such sandbox or file, or the caller is neither its owner nor an org admin, or the sandbox is deleted or application-secret tainted.",
      content,
    },
    default: { description: "Public API failure", content },
  };
}
/** Declared output snapshots (`sandbox-outputs.ts`): GET, path parameters, no request body. */
const OUTPUT_OPERATIONS = {
  [listSandboxOutputs.route.path]: {
    [listSandboxOutputs.route.method.toLowerCase()]: {
      operationId: "sandbox_outputs_list",
      description: listSandboxOutputs.description,
      security: [{ serviceToken: [] }],
      parameters: [SANDBOX_ID_PARAMETER],
      responses: {
        "200": {
          description: "Success",
          headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } },
          content: {
            "application/json": {
              schema: responseJsonSchema(listSandboxOutputs.output),
            },
          },
        },
        ...outputCommonResponses(outputFailure(listSandboxOutputs.errorOutput)),
      },
    },
  },
  [readSandboxOutput.route.path]: {
    [readSandboxOutput.route.method.toLowerCase()]: {
      operationId: "sandbox_outputs_download",
      description: readSandboxOutput.description,
      security: [{ serviceToken: [] }],
      parameters: [
        SANDBOX_ID_PARAMETER,
        {
          name: "Range",
          in: "header",
          description: "One byte range, for example bytes=0-1023.",
          schema: requestJsonSchema(readSandboxOutput.input.headers.Range),
        },
        {
          name: "If-Range",
          in: "header",
          description: "Apply the Range only when the file's ETag matches.",
          schema: requestJsonSchema(readSandboxOutput.input.headers["If-Range"]),
        },
        {
          name: "name",
          in: "path",
          required: true,
          description: "The file name from the outputs list, percent-encoded as one path segment.",
          schema: requestJsonSchema(readSandboxOutput.input.path.name),
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
          content: { "*/*": { schema: { type: "string", contentMediaType: readSandboxOutput.outputMediaType } } },
        },
        "206": {
          description: "The requested byte range.",
          headers: {
            "Content-Range": { schema: { type: "string" } },
            "Content-Length": { schema: { type: "integer", minimum: 1 } },
          },
          content: { "*/*": { schema: { type: "string", contentMediaType: readSandboxOutput.outputMediaType } } },
        },
        "416": {
          description: "The byte range is invalid or unsatisfiable.",
          headers: { "Content-Range": { schema: { type: "string" } } },
        },
        "400": { description: "The file name is invalid.", content: downloadFailure },
        "503": {
          description: "Stored outputs cannot be decrypted on this server, or the API is temporarily unavailable.",
          content: downloadFailure,
        },
        ...outputCommonResponses(downloadFailure),
      },
    },
  },
};

/** Project a REST document from the browser-safe operation table. */
export function generateOpenApi({
  projection = "integration",
  table = Object.values(operations),
}: {
  projection?: "integration" | "admin";
  table?: readonly OpenApiOperation[];
} = {}) {
  const admin = projection === "admin";
  const paths: Record<string, Record<string, unknown>> = {};
  const ids = new Set<string>();
  for (const operation of table) {
    if ((operation.audience === "admin") !== admin) continue;
    const method = operation.route.method.toLowerCase();
    const route = controlRouteKey(operation.route);
    paths[operation.route.path] ??= {};
    const path = paths[operation.route.path]!;
    if (Object.hasOwn(path, method)) throw new Error(`Duplicate REST operation: ${method} ${operation.route.path}`);
    const output = OUTPUT_OPERATIONS[operation.route.path as keyof typeof OUTPUT_OPERATIONS]?.get;
    if (output && method === "get") {
      reserveOperationId(output.operationId);
      path[method] = output;
      continue;
    }
    const input = operation.input.body instanceof z.ZodUndefined ? undefined : requestJsonSchema(operation.input.body);
    let description = operation.description;
    let request = input;
    const viewer = route.startsWith("viewer/");
    const viewerControl = viewer || route === "sandbox/viewer-token";
    const maxBodyBytes = operation.input.maxBodyBytes ?? controlBodyMaxBytes(route);
    const oversizedStatus =
      operation.input.oversizedBodyStatus ?? (viewerControl ? 503 : vaultControlRoute(route) ? 400 : 413);
    if (route === "sandbox/launch" && operation.input.body instanceof z.ZodUnion) {
      request = {
        oneOf: operation.input.body.options.map((variant) => {
          const { $schema: _dialect, ...schema } = requestJsonSchema(variant as z.ZodType);
          boundByBody(schema, "prompt", maxBodyBytes);
          return schema;
        }),
      };
      description +=
        ' Docker uses the other request variants: provider "docker" with no golden, either on a hostId (optionally with repos) or from a snapshotId (no repos). launch/options reports each provider\'s launch sources. Explicit pinned Modal template requests require idempotencyKey and return the shared launch envelope. An unresolved replay returns outcome_unknown with error.details.sandboxId.';
    }
    if (route === "sandbox/send" && input) {
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
    const query = operation.input.query;
    const parameters = [
      ...Object.entries(operation.input.path ?? {}).map(([name, schema]) => ({
        name,
        in: "path",
        required: true,
        schema: requestJsonSchema(schema),
      })),
      ...Object.entries(query instanceof z.ZodObject ? query.shape : {}).map(([name, schema]) => ({
        name,
        in: "query",
        required: !(schema as z.ZodType).safeParse(undefined).success,
        schema: requestJsonSchema(schema as z.ZodType),
      })),
      ...Object.entries(operation.input.headers ?? {}).map(([name, schema]) => ({
        name,
        in: "header",
        required: !schema.safeParse(undefined).success,
        schema: requestJsonSchema(schema),
      })),
    ];
    const operationId =
      method === "delete" && route === "sandboxes/{id}"
        ? "sandbox_delete"
        : method === "post"
          ? route.replaceAll("/", "_").replaceAll("-", "_")
          : operation.name;
    reserveOperationId(operationId);
    path[method] = {
      operationId,
      description,
      ...(operation.directServer && { "x-armada-direct-server": true }),
      security: operation.anonymous
        ? []
        : (operation.scopedAuth ?? [viewer ? "viewerGrant" : "serviceToken"]).map((scheme) => ({ [scheme]: [] })),
      ...(parameters.length ? { parameters } : {}),
      ...(request && {
        requestBody: {
          required: operation.input.bodyRequired ?? (route !== "viewer/logs" && route !== "viewer/status"),
          description: viewerControl
            ? `Send a JSON object of at most ${maxBodyBytes} bytes. A larger body returns HTTP 503 with viewer_access_denied before dispatch. Reduce the body before retrying.`
            : operation.directServer
              ? `Send at most ${maxBodyBytes} bytes of serialized JSON.`
              : operation.input.oversizedBodyStatus === 400
                ? `Send at most ${maxBodyBytes} bytes of serialized JSON. The server refuses larger bodies with HTTP 400 before processing the request. The dashboard proxy refuses bodies over ${CONTROL_BODY_MAX_BYTES} bytes with HTTP 413.`
                : vaultControlRoute(route)
                  ? `Send at most ${maxBodyBytes} bytes of serialized JSON. The server reads this route with the vault body reader and refuses a larger body with HTTP 400 (code invalid); the dashboard endpoint refuses a body over ${CONTROL_BODY_MAX_BYTES} bytes with HTTP 413. Nothing is dispatched in either case.`
                  : `Send at most ${maxBodyBytes} bytes of serialized JSON. The dashboard endpoint refuses a larger body with HTTP 413 without forwarding it, and the server refuses a body over its own limit, which is never lower, with HTTP 413 before any handler runs.`,
          "x-max-body-bytes": maxBodyBytes,
          "x-oversized-body-status": oversizedStatus,
          content: { "application/json": { schema: request } },
        },
      }),
      responses: {
        [operation.successStatus ?? 200]: {
          description: "Success",
          ...(operation.successHeaders && {
            headers: Object.fromEntries(
              Object.entries(operation.successHeaders).map(([name, schema]) => [
                name,
                { schema: responseJsonSchema(schema) },
              ]),
            ),
          }),
          ...(operation.output && {
            content: {
              [operation.outputMediaType ?? "application/json"]: { schema: responseJsonSchema(operation.output) },
            },
          }),
        },
        ...(request && !viewerControl && oversizedStatus === 400
          ? {
              "400": {
                description: operation.errorOutput
                  ? `The request could not be completed, including when the serialized body exceeds ${maxBodyBytes} bytes.`
                  : `Invalid request, including a serialized body over ${maxBodyBytes} bytes. Nothing was dispatched.`,
                content: operation.errorOutput
                  ? outputFailure(operation.errorOutput)
                  : { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
              },
            }
          : {}),
        ...(request &&
          !viewerControl &&
          !operation.scopedAuth &&
          !(operation.directServer && oversizedStatus === 400) && {
            "413": {
              description: `The serialized request body exceeds ${CONTROL_BODY_MAX_BYTES} bytes. Nothing was dispatched.`,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
            },
          }),
        "503": {
          description:
            (request && viewerControl
              ? "A request body exceeding the viewer limit returns viewer_access_denied. "
              : "") +
            "Temporarily unavailable: a structured failure, or the bare refusal sent before dispatch while the server drains. Honor Retry-After when present.",
          headers: {
            "Retry-After": {
              description: "Seconds to wait before retrying.",
              schema: { type: "integer", minimum: 0 },
            },
          },
          content: operation.errorOutput
            ? outputFailure(operation.errorOutput)
            : {
                "application/json": {
                  schema: {
                    anyOf: [{ $ref: "#/components/schemas/Failure" }, { $ref: "#/components/schemas/DrainRefusal" }],
                  },
                },
              },
        },
        default: {
          description: admin ? "Administrative API failure" : "Public API failure",
          content: operation.errorOutput
            ? outputFailure(operation.errorOutput)
            : { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
        },
      },
    };
  }
  function reserveOperationId(id: string) {
    if (ids.has(id)) throw new Error(`Duplicate OpenAPI operation ID: ${id}`);
    ids.add(id);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: admin ? "Armada administrative control API" : "Armada shared control API",
      version: VERSION,
      description: admin
        ? "Generated dashboard administration REST contracts. Each operation enforces its own caller, role and resource access requirements."
        : "Generated integration REST contracts. Includes SDK operations, launch discovery (launch/options, golden/list) and shared-tool routes. sandbox/launch accepts golden, Docker and explicit pinned Modal template launches. Administrative and provider-specific extensions are outside this description. Files use sandbox/exec while compute runs; declared output snapshots are listed and downloaded with GET sandboxes/{id}/outputs, also after stop. This description does not assert provider availability.",
    },
    paths,
    components: {
      securitySchemes: {
        serviceToken: { type: "http", scheme: "bearer" },
        ...(admin && {
          personalSession: {
            type: "http",
            scheme: "bearer",
            description: "The access token of a personal Supabase login session.",
          },
        }),
        viewerGrant: { type: "http", scheme: "bearer", description: "A short-lived sandbox viewer grant." },
        epochGrant: {
          type: "http",
          scheme: "bearer",
          description: "A scoped epoch grant for the required worker authority.",
        },
        finishGrant: {
          type: "http",
          scheme: "bearer",
          description: "A sandbox runtime grant that authorizes self-finish.",
        },
      },
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
}
