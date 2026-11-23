import { isSandboxProvider, mapHarnesses, type Provider, ProviderError } from "@armada/core";
import type { ModalRuntimeCapture } from "@armada/provider-modal";
import { runtimeBridgeProfiles, runtimeHarnessSupported } from "./provider-runtime-admission.ts";

type RuntimeTtlPort = {
  setRuntimeTtl?(request: { sandboxId: string; ttlSeconds: number; signal: AbortSignal }): Promise<void>;
};

type RuntimeWorkPort = {
  captureRuntimeWork?: ModalRuntimeCapture;
  observeCaptureBoot?(sandboxId: string, signal: AbortSignal): Promise<string | null>;
};
export type RuntimeWorkProvider = Provider & RuntimeTtlPort & RuntimeWorkPort;

/** Sandbox-bound adapter. Caller supplies authorized persisted binding and a
 * compute-only host (no native model-auth lifecycle hooks). No spread/fallback
 * to host agent methods, including optional ports added in future.
 */
export function createRuntimeProvider(
  host: RuntimeWorkProvider,
  providerSandboxId: string,
  reads: Pick<Provider, "getPrompt" | "events">,
  operations?: Pick<Provider, "interrupt" | "steer" | "exec" | "testModelConnection">,
  modalCapture?: ModalRuntimeCapture,
): RuntimeWorkProvider {
  if (!isSandboxProvider(host.id)) throw Error("boat_runtime_host_required");
  const { hostPorts } = runtimeBridgeProfiles[host.id];
  const setRuntimeTtl = hostPorts ? host.setRuntimeTtl : undefined;
  const captureRuntimeWork = hostPorts ? host.captureRuntimeWork?.bind(host) : modalCapture;
  const observeCaptureBoot = hostPorts ? host.observeCaptureBoot?.bind(host) : undefined;
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
  const outputPort = <Request extends { sandboxId: string }, Result>(
    name: "openRetainedOutputs" | "probeOutputs" | "readOutputs" | "readOutputChunk" | "listOutputEntries",
    method: ((request: Request) => Promise<Result>) | undefined,
  ) =>
    method && {
      [name]: async (request: Request) => {
        target(request.sandboxId);
        return method.call(host, request);
      },
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
    ...(setRuntimeTtl
      ? {
          async setRuntimeTtl(request: Parameters<typeof setRuntimeTtl>[0]) {
            target(request.sandboxId);
            request.signal.throwIfAborted();
            await setRuntimeTtl.call(host, request);
          },
        }
      : {}),
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
    ...outputPort("openRetainedOutputs", host.openRetainedOutputs),
    ...outputPort("probeOutputs", host.probeOutputs),
    ...outputPort("readOutputs", host.readOutputs),
    ...outputPort("readOutputChunk", host.readOutputChunk),
    ...outputPort("listOutputEntries", host.listOutputEntries),
    ...(host.outputReadConcurrency !== undefined ? { outputReadConcurrency: host.outputReadConcurrency } : {}),
    ...(host.outputReadBytes !== undefined ? { outputReadBytes: host.outputReadBytes } : {}),
    ...(observeCaptureBoot
      ? {
          observeCaptureBoot(id: string, signal: AbortSignal) {
            target(id);
            signal.throwIfAborted();
            return observeCaptureBoot(id, signal);
          },
        }
      : {}),
    ...(captureRuntimeWork
      ? {
          captureRuntimeWork(request: Parameters<typeof captureRuntimeWork>[0]) {
            target(request.sandboxId);
            request.signal.throwIfAborted();
            return captureRuntimeWork(request);
          },
        }
      : {}),
    // Ordinary runtime commands carry no stop-time or retained-resume authority.
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
  };
}
