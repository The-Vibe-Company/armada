import { z } from "zod";
import { MAX_MCP_CONNECTIONS } from "../mcp-launch-selection.ts";
import { isModelConnectionTestResult, MODEL_CONNECTION_ERROR_CODES } from "../model-connection-test.ts";
import type { Operation } from "./index.ts";

const org = z.string().nullish();
const uuid = z.guid();
const proofRequest = z.object({ org: z.string(), runtimeVersion: z.literal(1) });
const controlErrors = [
  "internal",
  "invalid",
  "unavailable",
  "dependency_unavailable",
  "unauthorized",
  "forbidden",
] as const;

export const sandboxCheckOperations = {
  testSandboxModelConnection: {
    name: "testSandboxModelConnection",
    route: { method: "POST", path: "/api/v1/sandbox/test-model-connection" },
    readOnly: false,
    destructive: false,
    audience: "admin",
    errors: [
      ...controlErrors,
      "invalid_request",
      "conflict",
      "not_found",
      "missing_credential",
      "rate_limited",
      "sandbox_not_ready",
      "provider_unavailable",
      "outcome_unknown",
      "credential_binding_required",
      "credential_refused",
    ],
    description: "Test a model on a running sandbox with its current bound API-key account. Owner only.",
    input: { body: z.strictObject({ id: uuid, model: z.string(), org }) },
    output: z.object({
      id: z.string(),
      test: z
        .strictObject({
          ok: z.boolean(),
          status: z.number().int().min(100).max(599).nullable(),
          error: z.enum(["provider_rejected", "invalid_response", "connection_failed"]).nullable(),
          code: z.enum(MODEL_CONNECTION_ERROR_CODES).nullable(),
          retryAfterSeconds: z.number().int().min(0).max(31_536_000).optional(),
        })
        .refine(isModelConnectionTestResult),
    }),
  },
  bindSandboxCredential: {
    name: "bindSandboxCredential",
    route: { method: "POST", path: "/api/v1/sandbox/bind-credential" },
    readOnly: false,
    destructive: true,
    audience: "admin",
    errors: [
      ...controlErrors,
      "conflict",
      "not_found",
      "missing_credential",
      "credential_binding_unsafe",
      "credential_binding_unsupported",
      "credential_refused",
    ],
    description:
      "Bind an owned sandbox to the selected account. A supported running sandbox must stop safely before its account changes.",
    input: { body: z.object({ id: uuid, credentialId: uuid, org }) },
    output: z.object({
      id: z.string(),
      credentialId: z.string(),
      credentialVersion: z.number().int(),
      harness: z.string(),
      status: z.literal("bound"),
    }),
  },
  postSandboxMcpPreflightV1: {
    name: "postSandboxMcpPreflightV1",
    directServer: true,
    route: { method: "POST", path: "/api/v1/sandbox/mcp-preflight-v1" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "not_found"],
    description: "Check access to selected runtime MCP connections and optionally report available tools.",
    input: {
      body: proofRequest.extend({
        connections: z.array(uuid).min(1).max(MAX_MCP_CONNECTIONS),
        toolInventory: z.boolean().optional(),
      }),
    },
    output: z.object({
      mcpReady: z.literal(true),
      connections: z.array(uuid),
      mcpToolInventory: z.array(z.object({ connectionId: uuid, tools: z.array(z.string()) })).optional(),
    }),
  },
  postSandboxGithubPreflightV1: {
    name: "postSandboxGithubPreflightV1",
    directServer: true,
    route: { method: "POST", path: "/api/v1/sandbox/github-preflight-v1" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: controlErrors,
    description:
      "Check that a Boat or Modal snapshot allows the repository and the caller's GitHub connection can read it.",
    input: { body: proofRequest.extend({ golden: z.string(), repository: z.string() }) },
    output: z.object({
      githubReady: z.literal(true),
      provider: z.enum(["boat", "modal"]),
      repository: z.string(),
      login: z.string(),
    }),
  },
  listSandboxTurns: {
    name: "listSandboxTurns",
    route: { method: "POST", path: "/api/v1/sandbox/list-turns" },
    scopedAuth: ["personalSession"],
    readOnly: true,
    destructive: false,
    audience: "public",
    errors: controlErrors,
    description: "Read recorded turn activity (queued, running, or finished) for visible sandboxes in an organization.",
    input: { body: z.object({ org: z.uuid() }) },
    output: z.record(z.string(), z.enum(["queued", "running", "finished"])),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
