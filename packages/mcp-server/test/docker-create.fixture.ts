import type { Sql } from "@armada/core";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";

export async function queueMachineAllocation(
  sql: Sql,
  key: string,
  actor: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[0],
  input: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[1],
) {
  const sandbox = await createDockerSandboxService(sql).reserve(actor, input);
  const allocation = await createDockerHostStore(sql, key).submitMachineCreate(actor, {
    sandboxId: sandbox.id,
    generation: sandbox.lifecycleGeneration,
    source: { kind: "image", ref: input.image },
    size: null,
    computeTtlSeconds: sandbox.ttlSeconds,
  });
  if (allocation.kind !== "pending") throw new Error("Expected pending Docker allocation.");
  return sandbox;
}

export const fixtureMachineId = "d".repeat(64);

export async function queueMachineCreate(
  sql: Sql,
  key: string,
  actor: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[0],
  input: Parameters<ReturnType<typeof createDockerSandboxService>["reserve"]>[1],
  installationId: string,
) {
  const sandbox = await queueMachineAllocation(sql, key, actor, input);
  if (sandbox.installationId !== installationId) throw new Error("Unexpected Docker installation.");
  const target = { sandboxId: sandbox.id, generation: sandbox.lifecycleGeneration };
  const context = {
    signal: new AbortController().signal,
    canDispatch: async () => true,
    handoffGeneration: async () => {
      throw new Error("Bootstrap does not hand off generations.");
    },
  };
  return { sandbox, target: { ...target, machineId: fixtureMachineId }, context };
}

export function pollMachineBootstrap(
  hosts: ReturnType<typeof createDockerHostStore>,
  token: string,
  installationId: string,
) {
  return hosts.poll(
    token,
    installationId,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    false,
    false,
    false,
    true,
  );
}
