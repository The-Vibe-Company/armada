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
    errors: [...controlErrors, "conflict", "not_found", "rate_limited", "credential_binding_required"],
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
    destructive: false,
    audience: "admin",
    errors: [
      ...controlErrors,
      "conflict",
      "not_found",
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
    route: { method: "POST", path: "/api/v1/sandbox/mcp-preflight-v1" },
    readOnly: true,
    destructive: false,
    audience: "public",
    errors: controlErrors,
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
    route: { method: "POST", path: "/api/v1/sandbox/github-preflight-v1" },
    readOnly: true,
    destructive: false,
    audience: "public",
    errors: controlErrors,
    description: "Check that a golden allows the repository and the caller's GitHub connection can read it.",
    input: { body: proofRequest.extend({ golden: z.string(), repository: z.string() }) },
    output: z.object({
      githubReady: z.literal(true),
      provider: z.enum(["boat", "modal"]),
      repository: z.string(),
      login: z.string(),
    }),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
