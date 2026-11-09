import { createHmac } from "node:crypto";
import type { SshExecDeps } from "@armada/core/server";
import { type Provider, sshOrchestratorReceipt } from "@armada/core/server";
import { boatOrchestratorBridgeScript } from "./boat-orchestrator-bridge.ts";
import { boatOrchestratorControlScript } from "./boat-orchestrator-script.ts";

/** Provider-private Boat composition only. No exec endpoint, no token-bearing argv
 * or persistent native config. The root key stays server-side; the derived control
 * key is domain/VM/boot-bound and delivered only to broker memory on pinned stdin. */
export function createBoatOrchestratorProvider(
  provider: Provider,
  encryptionKey: string | undefined,
  deps: SshExecDeps = {},
): Provider {
  if (provider.id !== "boat" || !encryptionKey) throw Error("orchestrator_private_transport_unavailable");
  const privateCall = async (sandboxId: string, payload: Record<string, unknown>) => {
    try {
      return await sshOrchestratorReceipt(
        provider,
        {
          sandboxId,
          token: JSON.stringify({ sandboxId, ...payload }),
          script: boatOrchestratorControlScript,
        },
        deps,
      );
    } catch {
      throw Error("orchestrator_private_transport_unavailable");
    }
  };
  const control = (sandboxId: string, boot: string) =>
    createHmac("sha256", encryptionKey)
      .update(JSON.stringify(["armada-orchestrator-private-control-v1", sandboxId, boot]))
      .digest("hex");
  return new Proxy(provider, {
    get(target, key) {
      if (key === "get")
        return async (sandboxId: string, options?: { signal?: AbortSignal }) => {
          const current = await target.get(sandboxId, options);
          if (!["ready", "running"].includes(current.state)) return current;
          const generation = await privateCall(sandboxId, { op: "generation" });
          return { ...current, physicalGeneration: generation.physicalGeneration };
        };
      if (key === "installOrchestratorEpoch")
        return async (request: Parameters<NonNullable<Provider["installOrchestratorEpoch"]>>[0]) => {
          const current = await target.get(request.sandboxId);
          if (!["ready", "running"].includes(current.state)) throw Error("orchestrator_private_transport_unavailable");
          const installed = await privateCall(request.sandboxId, {
            op: "install",
            boot: request.binding.physicalGeneration,
            control: control(request.sandboxId, request.binding.physicalGeneration),
            epoch: request.binding.epoch,
            token: request.token,
            url: request.url,
          });
          if (
            !installed.acknowledged ||
            installed.physicalGeneration !== request.binding.physicalGeneration ||
            installed.epoch !== request.binding.epoch ||
            !installed.port ||
            installed.authorityInstalled !== true
          )
            throw Error("orchestrator_private_transport_unavailable");
          try {
            const configured = await sshOrchestratorReceipt(
              target,
              {
                sandboxId: request.sandboxId,
                token: JSON.stringify({ boot: installed.physicalGeneration, port: installed.port }),
                script: boatOrchestratorBridgeScript,
              },
              deps,
            );
            if (
              !configured.acknowledged ||
              configured.physicalGeneration !== installed.physicalGeneration ||
              configured.port !== installed.port
            )
              throw Error("orchestrator_private_transport_unavailable");
          } catch {
            throw Error("orchestrator_private_transport_unavailable");
          }
          return { acknowledged: true };
        };
      if (key === "scrubOrchestratorEpoch")
        return async (request: Parameters<NonNullable<Provider["scrubOrchestratorEpoch"]>>[0]) => {
          const current = await target.get(request.sandboxId);
          if (!["ready", "running"].includes(current.state)) throw Error("orchestrator_private_transport_unavailable");
          const result = await privateCall(request.sandboxId, {
            op: "scrub",
            boot: request.physicalGeneration,
            control: control(request.sandboxId, request.physicalGeneration),
            ...(request.tokenHash === undefined ? {} : { hash: request.tokenHash }),
          });
          if (
            !result.acknowledged ||
            result.physicalGeneration !== request.physicalGeneration ||
            (request.tokenHash === undefined && result.authorityInstalled !== false)
          )
            throw Error("orchestrator_private_transport_unavailable");
          return { acknowledged: true };
        };
      if (key === "quiesceOrchestrator")
        return async (request: Parameters<NonNullable<Provider["quiesceOrchestrator"]>>[0]) => {
          const before = await privateCall(request.sandboxId, { op: "generation" });
          if (before.physicalGeneration !== request.physicalGeneration)
            throw Error("orchestrator_private_transport_unavailable");
          await target.interrupt({ sandboxId: request.sandboxId });
          const after = await privateCall(request.sandboxId, { op: "generation" });
          if (after.physicalGeneration !== request.physicalGeneration)
            throw Error("orchestrator_private_transport_unavailable");
          // Native observation remains mandatory; this is only delivery of interrupt.
          return { acknowledged: true };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
