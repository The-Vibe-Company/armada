import { GITHUB_REFRESH_MODAL_NATIVE, GitHubHydrationError, providerRateLimitDetails } from "@armada/core";
import { controlRouteKey, githubOperations } from "@armada/core/contract";
import { ProviderError, VaultError } from "@armada/core/server";
import type { z } from "zod";
import { sandboxToolContext } from "./control-tool-routes.ts";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";
import { describeToolFailure, logToolFailure } from "./tool-failure.ts";
import type { ToolContext } from "./tools.ts";

const githubByRoute = {
  [controlRouteKey(githubOperations.refreshGitHub.route)]: githubOperations.refreshGitHub,
  [controlRouteKey(githubOperations.readRuntimeGitHubStatus.route)]: githubOperations.readRuntimeGitHubStatus,
} as const;

type GitHubRestRoute = keyof typeof githubByRoute;

export async function dispatchGitHubRestControl(
  context: Pick<ToolContext, "caller" | "data" | "provider" | "launchCredentials" | "dockerControls" | "logError"> & {
    runtimeGitHub?: RuntimeGitHub;
  },
  route: GitHubRestRoute,
  body: Record<string, unknown>,
) {
  const contract = githubByRoute[route];
  const parsed = contract.input.body.pick({ id: true }).safeParse(body);
  const name = contract.name === "refreshGitHub" ? "github_refresh" : "runtime_github_status";
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
    if (contract.name === "readRuntimeGitHubStatus") {
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

function githubSandboxCommand(route: GitHubRestRoute) {
  return async ({ caller, body, options }: ControlRouteContext) => {
    const context = await sandboxToolContext({ route, caller, body, options });
    return dispatchGitHubRestControl(
      { ...context, ...(options.runtimeGitHub ? { runtimeGitHub: options.runtimeGitHub } : {}) },
      route,
      body,
    );
  };
}

export const githubSandboxRoutes = defineRoutes("github-sandbox", {
  [controlRouteKey(githubOperations.refreshGitHub.route)]: githubSandboxCommand(
    controlRouteKey(githubOperations.refreshGitHub.route),
  ),
  [controlRouteKey(githubOperations.readRuntimeGitHubStatus.route)]: githubSandboxCommand(
    controlRouteKey(githubOperations.readRuntimeGitHubStatus.route),
  ),
});
