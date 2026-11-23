import {
  failureDiagnostic,
  PROVIDER_LIMITS,
  type Provider,
  ProviderError,
  SANDBOX_STOP_MARGIN_SECONDS,
  type SandboxRecord,
  type SandboxStore,
  sandboxActivity,
} from "@armada/core/server";
import type { ServerSandboxPatch, ServerSandboxStore } from "./data.ts";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import { ToolError } from "./tool-error.ts";

const stateRefusals = {
  sandbox_not_running: "Only running or idle sandboxes can be extended.",
  deadline_not_extended: "The requested deadline must extend the existing lifetime.",
  boat_runtime_unsupported: "Enrolled Boat sandboxes do not support lifetime extension.",
  generation_unavailable: "The runtime lifecycle generation is unavailable.",
  compute_not_running: "Only running compute can be extended.",
  physical_deadline_unavailable: "The physical Modal deadline is unavailable.",
  provider_extension_unsupported: "Provider does not support lifetime extension.",
  provider_state_refused: "Sandbox cannot be extended in this state.",
  provider_deadline_unconfirmed:
    "Provider could not confirm the requested lifetime; an unsafe shortened lifetime is scheduled for preservation and stop. Refresh status.",
} as const;

/** Caller resolves owner/admin interior access (or scoped own-child authority) before entry. */
export async function extendSandbox(
  store: Omit<SandboxStore, "update"> & Pick<ServerSandboxStore, "update">,
  sandbox: SandboxRecord,
  provider: Provider,
  ttlSeconds: number,
  renewLeases?: () => Promise<void>,
) {
  const max = PROVIDER_LIMITS[sandbox.provider].maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS;
  const refuse = (message: string): never => {
    throw new ProviderError({ provider: provider.id, code: "invalid_request", retryable: false, message });
  };
  if (ttlSeconds > max) throw new ToolError("extension_maximum", "Requested lifetime exceeds the provider maximum.");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > max)
    refuse(`TTL must be a whole number of seconds from 1 to ${max}.`);
  function stateRefusal(refusalCode: keyof typeof stateRefusals) {
    const error = new ToolError("extension_state", stateRefusals[refusalCode]);
    recordOperatorDiagnostic("sandbox.extend", failureDiagnostic(error), {
      sandboxId: sandbox.id,
      code: error.code,
      refusalCode,
    });
    return error;
  }
  if (!["ready", "running"].includes(sandbox.status)) throw stateRefusal("sandbox_not_running");
  const requested = new Date(Date.now() + ttlSeconds * 1000);
  if (sandbox.expiresAt && requested.getTime() <= new Date(sandbox.expiresAt).getTime())
    throw stateRefusal("deadline_not_extended");
  if (sandbox.boatRuntime) throw stateRefusal("boat_runtime_unsupported");
  if (sandbox.runtimeTransport === "dialout") {
    // Modal's compute deadline is fixed. Observe it, then publish only the logical
    // deadline, since advancing the lifecycle generation would revoke the enrolled epoch.
    if (sandbox.lifecycleGeneration === undefined) throw stateRefusal("generation_unavailable");
    const physical = await provider.get(sandbox.providerSandboxId);
    if (
      physical.providerState !== "active" ||
      !["ready", "running"].includes(physical.state) ||
      physical.physicalExitConfirmed
    )
      throw stateRefusal("compute_not_running");
    const hard = physical.expiresAt?.getTime() ?? NaN;
    if (!Number.isFinite(hard)) throw stateRefusal("physical_deadline_unavailable");
    if (hard < requested.getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000)
      throw new ToolError("extension_maximum", "Requested lifetime exceeds the physical provider deadline.");
    const expiresAt = requested.toISOString();
    await store.update(sandbox.id, {
      modalRuntimeExtensionTarget: sandbox.providerSandboxId,
      expectedGeneration: sandbox.lifecycleGeneration,
      expiresAt,
      effectiveTtlSeconds: ttlSeconds,
    });
    return { id: sandbox.id, expiresAt, ttlSeconds };
  }
  if (!provider.extendLifetime) throw stateRefusal("provider_extension_unsupported");
  const result = await sandboxActivity<{ id: string; expiresAt: string; ttlSeconds: number } | ToolError | null>(
    store,
    sandbox,
    {},
    async (signal) => {
      signal.throwIfAborted();
      const hard = await provider.extendLifetime!({
        sandboxId: sandbox.providerSandboxId,
        ttlSeconds: ttlSeconds + SANDBOX_STOP_MARGIN_SECONDS,
      }).catch((error) => {
        if (error instanceof ProviderError) {
          if (error.code === "not_found") return new ToolError("extension_not_found", "Sandbox not found.");
          if (error.code === "forbidden")
            return new ToolError("extension_not_allowed", "You are not allowed to extend this sandbox.");
          if (error.code === "invalid_request" && provider.id === "modal")
            return new ToolError("extension_maximum", "Requested lifetime exceeds the physical provider deadline.");
          if (["invalid_request", "sandbox_not_ready"].includes(error.code))
            return stateRefusal("provider_state_refused");
        }
        throw error;
      });
      if (hard instanceof ToolError) return { result: hard, patch: {} };
      signal.throwIfAborted();
      if (
        !Number.isFinite(hard.getTime()) ||
        hard.getTime() < requested.getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000
      ) {
        const unsafe =
          !Number.isFinite(hard.getTime()) ||
          !sandbox.expiresAt ||
          hard.getTime() < new Date(sandbox.expiresAt).getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000;
        const patch: ServerSandboxPatch = unsafe ? { expireAfterExtension: true } : {};
        return { result: null, patch };
      }
      await renewLeases?.();
      const expiresAt = requested.toISOString();
      return {
        result: { id: sandbox.id, expiresAt, ttlSeconds },
        patch: { expiresAt, effectiveTtlSeconds: ttlSeconds },
      };
    },
  );
  if (result instanceof ToolError) throw result;
  if (result === null) throw stateRefusal("provider_deadline_unconfirmed");
  return result;
}
