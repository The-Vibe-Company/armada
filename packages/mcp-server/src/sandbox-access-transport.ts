import type { Provider } from "@armada/core";
import type { DelegatedAccessTransport } from "./delegated-access-contract.ts";
import { DelegatedAccessError } from "./delegated-access-contract.ts";

/** Trusted server composition only. The bound physical generation must come from
 * provider state, not user fields or the SQL activity counter. No fallback through
 * exec/argv/files. A successful ACK is private runtime delivery, NOT native hot reload. */
export function createDelegatedTransport(input: {
  provider: Provider;
  providerSandboxId: string;
  physicalGeneration: string;
  lifecycleGeneration: string;
  mcpUrl: string;
}): DelegatedAccessTransport {
  const install = input.provider.installOrchestratorEpoch?.bind(input.provider);
  const scrub = input.provider.scrubOrchestratorEpoch?.bind(input.provider);
  if (!install || !scrub || !input.physicalGeneration) throw new DelegatedAccessError("unavailable");
  return {
    physicalGeneration: input.physicalGeneration,
    lifecycleGeneration: input.lifecycleGeneration,
    async deliver(token, binding) {
      if (binding.physicalGeneration !== input.physicalGeneration) throw new DelegatedAccessError("conflict");
      try {
        const ack = await install({ sandboxId: input.providerSandboxId, token, binding, url: input.mcpUrl });
        if (ack.acknowledged !== true) throw new DelegatedAccessError("unavailable");
        return { acknowledged: true };
      } catch {
        throw new DelegatedAccessError("unavailable");
      }
    },
    async scrub(tokenHash) {
      try {
        const ack = await scrub({
          sandboxId: input.providerSandboxId,
          physicalGeneration: input.physicalGeneration,
          ...(tokenHash === undefined ? {} : { tokenHash }),
        });
        if (ack.acknowledged !== true) throw new DelegatedAccessError("unavailable");
      } catch {
        throw new DelegatedAccessError("unavailable");
      }
    },
  };
}
