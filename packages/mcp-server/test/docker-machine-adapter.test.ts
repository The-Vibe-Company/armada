import { capabilities } from "@armada/core/machine-capabilities";
import type { MachineIdentity, MachineInventoryEntry, RetainedMachine } from "@armada/core/server";
import { type MachineConformanceFixture, testMachineConformance } from "../../core/test-support/machine-conformance.ts";
import { createDockerMachineAdapter, type DockerMachineMailbox } from "../src/docker-machine-adapter.ts";

type Container = MachineInventoryEntry & {
  bindingId: string;
  phase: "running" | "stopped";
  binding?: string;
  workspace?: string | undefined;
};

const fixture: () => MachineConformanceFixture = () => {
  const containers = new Map<string, Container>();
  const retained = new Map<string, RetainedMachine>();
  const operations = new Map<string, string>();
  const exits = new Set<string>();
  let nextId = 0;
  const key = (bindingId: string, target: Omit<MachineIdentity, "machineId">) =>
    JSON.stringify([bindingId, target.sandboxId, target.generation]);
  const completed = <T>(value: T) => ({ kind: "completed", value }) as const;

  return {
    adapter(scope, fault) {
      const local = key.bind(null, scope.bindingId);
      function intent(operation: string, request: Omit<MachineIdentity, "machineId">) {
        const operationKey = `${local(request)}/${operation}`;
        const fingerprint = JSON.stringify(request);
        const saved = operations.get(operationKey);
        if (saved !== undefined && saved !== fingerprint) throw new Error("Changed mailbox intent");
        operations.set(operationKey, fingerprint);
        fault?.(`${operation} intent committed`);
      }
      function allocate(request: Omit<MachineIdentity, "machineId">, workspace?: string) {
        const existing = containers.get(local(request));
        if (existing) return existing;
        const container: Container = {
          ...scope,
          sandboxId: request.sandboxId,
          generation: request.generation,
          machineId: String(++nextId),
          createdAt: new Date(0),
          phase: "running",
          workspace,
        };
        containers.set(local(request), container);
        return container;
      }
      function exact(request: MachineIdentity) {
        const container = containers.get(local(request));
        if (container?.machineId !== request.machineId) throw new Error("Unknown container");
        return container;
      }
      function identity({ sandboxId, generation, machineId }: MachineIdentity) {
        return { sandboxId, generation, machineId };
      }
      function remove(request: MachineIdentity) {
        if (!exits.has(local(request))) exact(request);
        containers.delete(local(request));
        exits.add(local(request));
      }

      const mailbox: DockerMachineMailbox = {
        async create(request) {
          intent("create", request);
          const container = allocate(request);
          fault?.("allocation receipt committed");
          return completed(identity(container));
        },
        async bootstrap(request) {
          intent("bootstrap", request);
          exact(request).binding = request.bindingRef;
          return completed(undefined);
        },
        async stop(request) {
          intent("stop", request);
          if (!request.retain) {
            remove(request);
            return null;
          }
          exact(request).phase = "stopped";
          const proof = {
            sandboxId: request.sandboxId,
            generation: request.generation,
            kind: "container" as const,
            ref: request.machineId,
          };
          retained.set(local(request), proof);
          return proof;
        },
        async resume(request) {
          intent("resume", request);
          const source = exact({ ...request.predecessor, machineId: request.predecessor.ref });
          if (source.phase !== "stopped") throw new Error("Missing predecessor exit");
          return completed(identity(allocate(request, source.workspace)));
        },
        async delete(request) {
          intent("delete", request);
          remove(request);
          return completed(undefined);
        },
        async observe(request) {
          const container = containers.get(local(request));
          if (!container) return { kind: exits.has(local(request)) ? "absent" : "unknown" };
          if (request.machineId && request.machineId !== container.machineId) return { kind: "unknown" };
          return { kind: "present", machine: identity(container), phase: container.phase };
        },
        async *listInventory() {
          for (const container of containers.values()) {
            if (container.bindingId === scope.bindingId)
              yield { ...identity(container), deploymentId: container.deploymentId, createdAt: container.createdAt };
          }
        },
      };
      return createDockerMachineAdapter(mailbox);
    },

    liveMachines: () => [...containers.values()],
    committedRetention: ({ bindingId }, target) => retained.get(key(bindingId, target)),
    runtimeBindings: (target) => {
      const binding = [...containers.values()].find(({ machineId }) => machineId === target.machineId)?.binding;
      return binding ? [binding] : [];
    },
    writeWorkspace(target, content) {
      const container = [...containers.values()].find(({ machineId }) => machineId === target.machineId);
      if (!container) throw new Error("Missing workspace");
      container.workspace = content;
    },
    readWorkspace: (target) =>
      [...containers.values()].find(({ machineId }) => machineId === target.machineId)?.workspace,
  };
};

testMachineConformance("Docker host mailbox", {
  fixture,
  capabilities: capabilities("docker"),
  inventory: true,
  faultSteps: {
    create: ["create intent committed"],
    bootstrap: ["bootstrap intent committed"],
    stop: ["stop intent committed"],
    resume: ["resume intent committed"],
    delete: ["delete intent committed"],
  },
  lostCreateResponseStep: "allocation receipt committed",
});
