import { OPENCODE_ENDPOINT_ENV } from "@armada/core";
import { sandboxCheckOperations } from "@armada/core/contract";
import { type GoldenActor, resolveModelChoice, resolveOrg, sandboxActivity, VaultError } from "@armada/core/server";
import { z } from "zod";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { sandboxToolRoutes } from "./control-tool-routes.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { runtimeBridgeProfile } from "./provider-runtime-admission.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function field<T extends z.ZodType>(schema: T, body: Record<string, unknown>, name: string, invalidText?: string) {
  const value = body[name];
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (value == null) throw new VaultError("invalid", `${name} is required.`);
  throw new VaultError("invalid", typeof value === "string" && invalidText ? invalidText : `${name} must be text.`);
}

const handlers = {
  testSandboxModelConnection: async ({ caller, body, options }: ControlRouteContext) => {
    const { input, output } = sandboxCheckOperations.testSandboxModelConnection;
    const shape = input.body.shape;
    if (Object.keys(body).some((key) => !Object.hasOwn(shape, key)))
      throw new VaultError("invalid", "Connection checks accept only id, model and org.");
    const id = field(shape.id, body, "id", "id must be an Armada sandbox UUID.");
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const scoped = await selectedCaller(options, caller, field(shape.org, body, "org") ?? undefined);
    const data = options.data(scoped);
    const found = await data.sandboxes.get(id);
    if (!found) throw new VaultError("not_found", "Sandbox not found.");
    if (found.ownerId !== caller.userId)
      throw new VaultError("forbidden", "Only the sandbox owner may test its model connection.");
    const modelCheck = runtimeBridgeProfile(found.provider)?.modelCheck;
    if (
      !modelCheck ||
      (modelCheck === "runtime-command" && !found.boatRuntime) ||
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
    const model = resolveModelChoice(harness, { model: field(shape.model, body, "model") }).model;
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
      if (!output.shape.test.safeParse(result).success)
        throw new VaultError("unavailable", "Invalid connection-test receipt.");
      return result;
    };
    if (modelCheck === "runtime-command") {
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
  bindSandboxCredential: async ({ caller, body, options }: ControlRouteContext) => {
    const { shape } = sandboxCheckOperations.bindSandboxCredential.input.body;
    const org = scopedOrg(caller, field(shape.org, body, "org") ?? undefined);
    const { store } = options;
    const userId = caller.userId;
    if (!options.credentialBindingRecovery) throw new VaultError("unavailable", "Binding recovery is not configured.");
    return options.credentialBindingRecovery(
      caller,
      {
        id: field(z.string(), body, "id"),
        credentialId: field(z.string(), body, "credentialId"),
        ...(org ? { org: (await resolveOrg(store, userId, org)).id } : {}),
      },
      async (id, sandboxOrg) => {
        const stopped = await sandboxToolRoutes.handlers["sandbox/stop"]!.handler({
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
  postSandboxMcpPreflightV1: ({ caller, body, options }: ControlRouteContext) => {
    const { shape } = sandboxCheckOperations.postSandboxMcpPreflightV1.input.body;
    scopedOrg(caller, field(shape.org.nullish(), body, "org") ?? undefined);
    if (!shape.runtimeVersion.safeParse(body.runtimeVersion).success || !options.runtimeMcp)
      throw new VaultError("unavailable", "Runtime MCP v1 is unavailable.");
    const toolInventory = shape.toolInventory.safeParse(body.toolInventory);
    if (!toolInventory.success) throw new VaultError("invalid", "toolInventory must be boolean.");
    return options.runtimeMcp.preflight(caller, {
      org: field(shape.org, body, "org"),
      connections: body.connections,
      ...(toolInventory.data === true ? { toolInventory: true } : {}),
    });
  },
  postSandboxGithubPreflightV1: ({ caller, body, options }: ControlRouteContext) => {
    const { shape } = sandboxCheckOperations.postSandboxGithubPreflightV1.input.body;
    scopedOrg(caller, field(shape.org.nullish(), body, "org") ?? undefined);
    if (!shape.runtimeVersion.safeParse(body.runtimeVersion).success || !options.runtimeGitHub)
      throw new VaultError("unavailable", "Runtime GitHub v1 is unavailable.");
    return options.runtimeGitHub.preflight(caller, {
      org: field(shape.org, body, "org"),
      golden: field(shape.golden, body, "golden"),
      repository: field(shape.repository, body, "repository"),
    });
  },
  listSandboxTurns: ({ body, caller, options }: ControlRouteContext) => {
    const org = field(sandboxCheckOperations.listSandboxTurns.input.body.shape.org, body, "org");
    if (caller.via !== "supabase" || !caller.orgs.some(({ orgId }) => orgId === org))
      throw new VaultError("forbidden", "Organization membership is required.");
    if (!options.sandboxListTurns) throw new VaultError("unavailable", "Sandbox activity is unavailable.");
    return options.sandboxListTurns(caller, org);
  },
} satisfies Record<keyof typeof sandboxCheckOperations, (context: ControlRouteContext) => unknown>;

export const sandboxRoutes = defineRoutes(
  "sandbox",
  Object.fromEntries(
    Object.values(sandboxCheckOperations).map(({ name, route }) => [
      route.path.slice("/api/v1/".length),
      { methods: [route.method], handler: handlers[name] },
    ]),
  ),
);
