import { mapHarnesses, type Provider, ProviderError } from "@armada/core";
import { runtimeHarnessSupported } from "./provider-runtime-admission.ts";

/** Sandbox-bound adapter. Caller supplies authorized persisted binding and a
 * compute-only host (no native model-auth lifecycle hooks). No spread/fallback
 * to host agent methods, including optional ports added in future.
 */
export function createRuntimeProvider(
  host: Provider,
  providerSandboxId: string,
  reads: Pick<Provider, "getPrompt" | "events">,
  operations?: Pick<Provider, "interrupt" | "steer" | "exec" | "testModelConnection">,
): Provider {
  if (host.id !== "boat" && host.id !== "modal") throw Error("boat_runtime_host_required");
  const unsupported = async (): Promise<never> => {
    throw new ProviderError({
      provider: host.id,
      code: "invalid_request",
      message: "This experimental runtime operation is not supported.",
      retryable: false,
    });
  };
  const target = (id: string) => {
    if (id !== providerSandboxId)
      throw new ProviderError({
        provider: host.id,
        code: "not_found",
        message: "No such runtime sandbox.",
        retryable: false,
      });
  };
  const capabilities = mapHarnesses(({ capabilities: capability }) => ({
    ...capability,
    steer: operations ? capability.steer : ("none" as const),
    interrupt: Boolean(operations),
    resume: false,
    parallelConversations: false,
  }));
  return {
    id: host.id,
    harnesses: (["codex", "claude", "opencode"] as const).filter((harness) =>
      runtimeHarnessSupported(host.id, harness),
    ),
    capabilities,
    ...(host.managementIdentity ? { managementIdentity: host.managementIdentity.bind(host) } : {}),
    ...(host.backendIdentity ? { backendIdentity: host.backendIdentity.bind(host) } : {}),
    async get(id, options) {
      target(id);
      return host.get(id, options);
    },
    async getPrompt(request) {
      target(request.sandboxId);
      return reads.getPrompt(request);
    },
    async events(request) {
      target(request.sandboxId);
      return reads.events(request);
    },
    async stop(request) {
      target(request.sandboxId);
      return host.stop(request);
    },
    async delete(request) {
      target(request.sandboxId);
      return host.delete(request);
    },
    ...(operations?.testModelConnection
      ? {
          async testModelConnection(request: Parameters<NonNullable<Provider["testModelConnection"]>>[0]) {
            target(request.sandboxId);
            return operations.testModelConnection!(request);
          },
        }
      : {}),
    // Declared outputs are a fixed host read (Boat command API, Modal container),
    // never a runner operation, so enrolled runtimes publish outputs like native sandboxes.
    ...(host.probeOutputs
      ? {
          async probeOutputs(request: Parameters<NonNullable<Provider["probeOutputs"]>>[0]) {
            target(request.sandboxId);
            return host.probeOutputs!(request);
          },
        }
      : {}),
    ...(host.readOutputs
      ? {
          async readOutputs(request: Parameters<NonNullable<Provider["readOutputs"]>>[0]) {
            target(request.sandboxId);
            return host.readOutputs!(request);
          },
        }
      : {}),
    ...(host.outputReadConcurrency !== undefined ? { outputReadConcurrency: host.outputReadConcurrency } : {}),
    ...(host.outputReadBytes !== undefined ? { outputReadBytes: host.outputReadBytes } : {}),
    ...(host.readOutputChunk
      ? {
          async readOutputChunk(request: Parameters<NonNullable<Provider["readOutputChunk"]>>[0]) {
            target(request.sandboxId);
            return host.readOutputChunk!(request);
          },
        }
      : {}),
    ...(host.listOutputEntries
      ? {
          async listOutputEntries(request: Parameters<NonNullable<Provider["listOutputEntries"]>>[0]) {
            target(request.sandboxId);
            return host.listOutputEntries!(request);
          },
        }
      : {}),
    // No quiescence/checkpoint/work-preservation/resume guarantee in this lane.
    quiesce: unsupported,
    prompt: unsupported,
    steer: operations
      ? async (request) => {
          target(request.sandboxId);
          return operations.steer(request);
        }
      : unsupported,
    interrupt: operations
      ? async (request) => {
          target(request.sandboxId);
          return operations.interrupt(request);
        }
      : unsupported,
    exec: operations
      ? async (request) => {
          target(request.sandboxId);
          return operations.exec(request);
        }
      : unsupported,
    sshKey: unsupported,
    createGolden: unsupported,
    snapshot: unsupported,
    getSnapshot: unsupported,
    deleteSnapshot: unsupported,
    fork: unsupported,
    list: unsupported,
  };
}
