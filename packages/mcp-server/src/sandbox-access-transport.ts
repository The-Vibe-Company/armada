import { randomUUID } from "node:crypto";
import type { RunnerRequest } from "@armada/agent-runtime";
import type { Provider } from "@armada/core";
import type { DelegatedAccessTransport } from "./delegated-access-contract.ts";
import { DelegatedAccessError } from "./delegated-access-contract.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";

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

export function createEnrolledDelegatedTransport(
  commands: Pick<ReturnType<typeof createRuntimeCommands>, "call">,
  input: { ownerId: string; sandboxId: string; epoch: string; lifecycleGeneration: string; mcpUrl: string },
) {
  const identity = () => ({ version: 1 as const, sandboxId: input.sandboxId, requestId: randomUUID() });
  async function acknowledged(command: RunnerRequest) {
    const accept = (reply: Awaited<ReturnType<typeof commands.call>>) =>
      reply.status === 200 &&
      reply.epoch === input.epoch &&
      reply.requestId === command.requestId &&
      reply.body.version === 1 &&
      reply.body.requestId === command.requestId &&
      reply.body.error === undefined &&
      (reply.body.result as { acknowledged?: unknown } | undefined)?.acknowledged === true;
    const reply = await commands.call(input.ownerId, command, { expectedEpoch: input.epoch, accept });
    if (!accept(reply)) throw new DelegatedAccessError("unavailable");
  }
  return {
    physicalGeneration: input.epoch,
    lifecycleGeneration: input.lifecycleGeneration,
    async deliver(token, binding) {
      if (binding.physicalGeneration !== input.epoch) throw new DelegatedAccessError("conflict");
      await acknowledged({ ...identity(), op: "installOrchestratorEpoch", token, binding, url: input.mcpUrl });
      return { acknowledged: true };
    },
    scrub: (tokenHash) =>
      acknowledged({
        ...identity(),
        op: "scrubOrchestratorEpoch",
        ...(tokenHash === undefined ? {} : { tokenHash }),
      }),
  } satisfies DelegatedAccessTransport;
}
