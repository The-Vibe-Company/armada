import { randomUUID } from "node:crypto";
import type { RunnerRequest } from "@armada/agent-runtime";
import type { Sql } from "@armada/core";
import type { DelegatedAccessTransport } from "./delegated-access-contract.ts";
import { DelegatedAccessError } from "./delegated-access-contract.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";

export function createEnrolledDelegatedTransport(
  commands: Pick<ReturnType<typeof createRuntimeCommands>, "call" | "enqueue">,
  input: {
    ownerId: string;
    sandboxId: string;
    epoch: string;
    lifecycleGeneration: string;
    mcpUrl: string;
    signal: AbortSignal;
    assertClaim?: (tx: Sql) => Promise<void>;
  },
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
    const reply = await commands.call(input.ownerId, command, {
      expectedEpoch: input.epoch,
      signal: input.signal,
      ...(input.assertClaim ? { assertClaim: input.assertClaim } : {}),
      accept,
    });
    input.signal.throwIfAborted();
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
    async scrub(tokenHash) {
      await commands.enqueue(
        input.ownerId,
        {
          ...identity(),
          op: "scrubOrchestratorEpoch",
          ...(tokenHash === undefined ? {} : { tokenHash }),
        },
        input.epoch,
        input.assertClaim,
      );
    },
  } satisfies DelegatedAccessTransport;
}
