import { isModelConnectionTestResult, OPENCODE_ENDPOINT_ENV } from "@armada/core";
import { type GoldenActor, resolveModelChoice, resolveOrg, sandboxActivity, VaultError } from "@armada/core/server";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { optional, required, UUID } from "./control-input.ts";
import { sandboxToolRoutes } from "./control-tool-routes.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { defineRoutes } from "./routes.ts";

export const sandboxRoutes = defineRoutes("sandbox", {
  "sandbox/test-model-connection": async ({ caller, body, options }) => {
    if (Object.keys(body).some((key) => !["id", "model", "org"].includes(key)))
      throw new VaultError("invalid", "Connection checks accept only id, model and org.");
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be an Armada sandbox UUID.");
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const scoped = await selectedCaller(options, caller, optional(body, "org"));
    const data = options.data(scoped);
    const found = await data.sandboxes.get(id);
    if (!found) throw new VaultError("not_found", "Sandbox not found.");
    if (found.ownerId !== caller.userId)
      throw new VaultError("forbidden", "Only the sandbox owner may test its model connection.");
    if (
      !(found.provider === "modal" || (found.provider === "boat" && found.boatRuntime)) ||
      !["ready", "running"].includes(found.status) ||
      found.stopRequestedAt ||
      !found.credentialId ||
      !found.credentialVersion
    )
      throw new VaultError(
        "conflict",
        "Connection checks require a running, bound Modal or Boat shared-runtime sandbox; no resume is performed.",
      );
    const harness = found.harness;
    if (harness !== "claude" && harness !== "codex" && harness !== "opencode")
      throw new VaultError("invalid", "Connection checks support Claude, Codex and custom OpenCode connections only.");
    const model = resolveModelChoice(harness, { model: required(body, "model") }).model;
    const credentials = launchCredentials(options.store, options.encryptionKey, undefined, options.modelAuth);
    const actor: GoldenActor = { userId: found.ownerId, orgId: found.orgId, role: "member" };
    const bound = await credentials.resolve(actor, found.harness, found.credentialId, found.credentialVersion);
    if (harness === "opencode") {
      if (!bound.env[OPENCODE_ENDPOINT_ENV] || !bound.env.OPENCODE_API_KEY)
        throw new VaultError("invalid", "OpenCode checks require a custom connection, not a plan key.");
    } else {
      const apiKey =
        harness === "codex"
          ? bound.env.OPENAI_API_KEY
          : (bound.env.ANTHROPIC_AUTH_TOKEN ?? bound.env.ANTHROPIC_API_KEY);
      if (!apiKey) throw new VaultError("invalid", "This check requires an API-key account, not a subscription.");
    }
    await credentials.assertTurn?.(actor, found.id, false);
    const provider = await options.providers.resolve(found, scoped);
    if (!provider.testModelConnection)
      throw new VaultError("unavailable", "Runtime connection checks are unavailable.");
    const testConnection = async (signal?: AbortSignal) => {
      const result = await provider.testModelConnection!({
        sandboxId: found.providerSandboxId,
        harness,
        model,
        ...(signal ? { signal } : {}),
      });
      if (!isModelConnectionTestResult(result)) throw new VaultError("unavailable", "Invalid connection-test receipt.");
      return result;
    };
    if (found.provider === "boat" && found.boatRuntime) {
      const test = await testConnection(AbortSignal.timeout(30000));
      return { id: found.id, test };
    }
    const machine = await provider.get(found.providerSandboxId);
    if (!["ready", "running"].includes(machine.state))
      throw new VaultError("conflict", "Sandbox must already be running.");
    const test = await sandboxActivity(
      data.sandboxes,
      found,
      {},
      async () => ({ result: await testConnection(), patch: {} }),
      { deadlineMs: 30000, failurePatch: () => ({}) },
    );
    return { id: found.id, test };
  },
  "sandbox/bind-credential": async ({ caller, body, options }) => {
    const org = scopedOrg(caller, optional(body, "org"));
    const { store } = options;
    const userId = caller.userId;
    if (!options.credentialBindingRecovery) throw new VaultError("unavailable", "Binding recovery is not configured.");
    return options.credentialBindingRecovery(
      caller,
      {
        id: required(body, "id"),
        credentialId: required(body, "credentialId"),
        ...(org ? { org: (await resolveOrg(store, userId, org)).id } : {}),
      },
      async (id, sandboxOrg) => {
        const stopped = await sandboxToolRoutes.handlers["sandbox/stop"]!({
          route: "sandbox/stop",
          caller,
          options,
          body: { id, org: sandboxOrg, only_if_idle: true, request_id: crypto.randomUUID() },
        });
        if (!stopped || typeof stopped !== "object" || !("status" in stopped) || stopped.status !== "stopped")
          throw new VaultError(
            "credential_binding_unsafe",
            "Stop is still pending; wait for stopped and retry. The account is unchanged.",
          );
        if ("preservationNote" in stopped && stopped.preservationNote === "checkpoint_failed_disk_not_retained")
          throw new VaultError(
            "credential_binding_unsafe",
            "Checkpointing failed and retained compute cannot resume. The account is unchanged; inspect preserved work.",
          );
      },
    );
  },
  "sandbox/mcp-preflight-v1": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    if (body.runtimeVersion !== 1 || !options.runtimeMcp)
      throw new VaultError("unavailable", "Runtime MCP v1 is unavailable.");
    if (body.toolInventory !== undefined && typeof body.toolInventory !== "boolean")
      throw new VaultError("invalid", "toolInventory must be boolean.");
    return options.runtimeMcp.preflight(caller, {
      org: required(body, "org"),
      connections: body.connections as string[],
      ...(body.toolInventory === true ? { toolInventory: true } : {}),
    });
  },
  "sandbox/github-preflight-v1": ({ caller, body, options }) => {
    scopedOrg(caller, optional(body, "org"));
    if (body.runtimeVersion !== 1 || !options.runtimeGitHub)
      throw new VaultError("unavailable", "Runtime GitHub v1 is unavailable.");
    return options.runtimeGitHub.preflight(caller, {
      org: required(body, "org"),
      golden: required(body, "golden"),
      repository: required(body, "repository"),
    });
  },
});
