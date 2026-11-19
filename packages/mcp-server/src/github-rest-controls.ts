import { GITHUB_REFRESH_MODAL_NATIVE, GitHubHydrationError, providerRateLimitDetails } from "@armada/core";
import { ProviderError, VaultError } from "@armada/core/server";
import { z } from "zod";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";
import { describeToolFailure, logToolFailure } from "./tool-failure.ts";
import type { ToolContext } from "./tools.ts";

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");

export const GITHUB_REST_CONTRACTS = {
  "github/refresh": {
    description:
      "Configure or refresh the owner's GitHub access in a running sandbox without relaunching. Enrolled Armada runtimes use current-epoch private RPC; native Boat keeps its existing setup. Reuses a validated unexpired token; rejection/expiry can require renewal. Only the sandbox owner may request this.",
    input: z.object({ id }),
    output: z.object({
      id: z.string(),
      login: z.string(),
      status: z.literal("connected"),
      runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
      revision: z.string().optional(),
    }),
  },
  "github/runtime-status": {
    description:
      "Owner-only non-secret current-epoch configuration and credential-request count. Does not return credentials or probe GitHub.",
    input: z.object({ id }),
    output: z.object({
      id: z.string(),
      configured: z.boolean(),
      revision: z.string().nullable(),
      credentialRequests: z.number().int().nonnegative(),
      lastAccessedAt: z.string().nullable(),
      runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
    }),
  },
};

type GitHubRestRoute = keyof typeof GITHUB_REST_CONTRACTS;
export function isGitHubRestControl(route: string): route is GitHubRestRoute {
  return Object.hasOwn(GITHUB_REST_CONTRACTS, route);
}

export async function dispatchGitHubRestControl(
  context: Pick<ToolContext, "caller" | "data" | "provider" | "launchCredentials" | "dockerControls" | "logError"> & {
    runtimeGitHub?: RuntimeGitHub;
  },
  route: GitHubRestRoute,
  body: Record<string, unknown>,
) {
  const contract = GITHUB_REST_CONTRACTS[route];
  const parsed = contract.input.safeParse(body);
  const name = route === "github/refresh" ? "github_refresh" : "runtime_github_status";
  if (!parsed.success)
    throw new ToolApiError(
      "internal",
      validationMessage(`Input validation error: Invalid arguments for tool ${name}`, parsed.error),
    );

  const result = await run(parsed.data.id).catch((error: unknown) => {
    const { code, message } = describeToolFailure(error);
    logToolFailure(error, name, code, context.logError);
    const details =
      error instanceof GitHubHydrationError
        ? error.details
        : error instanceof ProviderError && code === "rate_limited"
          ? providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds })
          : undefined;
    throw new ToolApiError(code, message, details);
  });
  const output = contract.output.safeParse(result);
  if (!output.success)
    throw new ToolApiError(
      "internal",
      validationMessage(`Output validation error: Invalid structured content for tool ${name}`, output.error),
    );
  return result;

  async function run(sandboxId: string) {
    const { caller, data, runtimeGitHub } = context;
    if (route === "github/runtime-status") {
      if (!runtimeGitHub) throw new ToolError("unsupported", "Runtime GitHub is unavailable.");
      return runtimeGitHub.status(caller, sandboxId);
    }
    const routed = await context.dockerControls?.invoke(caller, "github_refresh", { id: sandboxId });
    if (routed?.handled) return routed.result;
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    if (found.boatRuntime || found.runtimeTransport === "dialout") {
      if (!runtimeGitHub) throw new ToolError("unsupported", "Runtime GitHub is unavailable.");
      return runtimeGitHub.prepare(caller, sandboxId);
    }
    if (found.status === "deleted") throw new ToolError("conflict", `Sandbox '${sandboxId}' is deleted.`);
    if (found.provider === "modal" && !found.credentialId)
      throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
    const provider = await context.provider(found);
    if (found.ownerId !== caller.userId)
      throw new ToolError("forbidden", "Only the sandbox owner may repair GitHub access.");
    if (provider.id === "modal") throw new ToolError("unsupported", GITHUB_REFRESH_MODAL_NATIVE);
    if (provider.id !== "boat")
      throw new ToolError("unsupported", "Use the next prompt to reconcile this provider's managed GitHub runtime.");
    const machine = await provider.get(found.providerSandboxId);
    if (!["ready", "running"].includes(machine.state))
      throw new ToolError("conflict", "GitHub repair requires a running sandbox.");
    if (!context.launchCredentials.refreshGitHub)
      throw new ToolError("unavailable", "GitHub repair is not configured.");
    const result = await context.launchCredentials.refreshGitHub(
      { userId: found.ownerId, orgId: found.orgId, role: "member" },
      provider,
      found.providerSandboxId,
    );
    return { id: found.id, status: "connected" as const, login: result.login };
  }
}

function validationMessage(message: string, error: z.ZodError) {
  const details = error.issues.map((issue) => `${issue.message} at ${issue.path.join(".")}`).join("\n");
  return `MCP error -32602: ${message}: ${details}`;
}
