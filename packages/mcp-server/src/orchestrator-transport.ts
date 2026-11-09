import type { Provider } from "@armada/core";
import type { OrchestratorRuntimeTransport } from "./orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

/** Trusted server composition only. The bound physical generation must come from
 * provider state, not user fields or the SQL activity counter. No fallback through
 * exec/argv/files. A successful ACK is private runtime delivery, NOT native hot reload. */
export function createOrchestratorTransport(input: {
  provider: Provider;
  providerSandboxId: string;
  physicalGeneration: string;
  lifecycleGeneration: string;
  mcpUrl: string;
}): OrchestratorRuntimeTransport {
  const install = input.provider.installOrchestratorEpoch?.bind(input.provider);
  const scrub = input.provider.scrubOrchestratorEpoch?.bind(input.provider);
  if (!install || !scrub || !input.physicalGeneration) throw new OrchestratorRuntimeError("unavailable");
  return {
    physicalGeneration: input.physicalGeneration,
    lifecycleGeneration: input.lifecycleGeneration,
    async deliver(token, binding) {
      if (binding.physicalGeneration !== input.physicalGeneration) throw new OrchestratorRuntimeError("conflict");
      try {
        const ack = await install({ sandboxId: input.providerSandboxId, token, binding, url: input.mcpUrl });
        if (ack.acknowledged !== true) throw new OrchestratorRuntimeError("unavailable");
        return { acknowledged: true };
      } catch {
        throw new OrchestratorRuntimeError("unavailable");
      }
    },
    async scrub(tokenHash) {
      try {
        const ack = await scrub({
          sandboxId: input.providerSandboxId,
          physicalGeneration: input.physicalGeneration,
          ...(tokenHash === undefined ? {} : { tokenHash }),
        });
        if (ack.acknowledged !== true) throw new OrchestratorRuntimeError("unavailable");
      } catch {
        throw new OrchestratorRuntimeError("unavailable");
      }
    },
  };
}
