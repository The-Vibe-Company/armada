import { expect, test } from "bun:test";
import { capabilities, type MachineIdentity, type MachineObservation, type RetainedMachine } from "../src/machine.ts";
import {
  type MachineConformanceFixture,
  type MachineConformanceOptions,
  machineConformanceCases,
  testMachineConformance,
} from "../test-support/machine-conformance.ts";

const stopRetention = capabilities("modal").stopRetention;

function referenceFixture(loseCreateDeduplication = false): MachineConformanceFixture {
  const live = new Map<string, ReturnType<MachineConformanceFixture["liveMachines"]>[number]>();
  const allocations = new Map<string, MachineIdentity>();
  const bindings = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const checkpoints = new Map<string, { retained: RetainedMachine; content: string }>();
  let sequence = 0;

  return {
    liveMachines: () => [...live.values()],
    runtimeBindings: (machine) => {
      const binding = bindings.get(machine.machineId);
      return binding === undefined ? [] : [binding];
    },
    writeWorkspace: (machine, content) => {
      workspaces.set(machine.machineId, content);
    },
    readWorkspace: (machine) => workspaces.get(machine.machineId),
    adapter(scope, fault) {
      function key({ sandboxId, generation }: MachineIdentity | Pick<MachineIdentity, "sandboxId" | "generation">) {
        return JSON.stringify([scope.bindingId, scope.deploymentId, sandboxId, generation]);
      }

      function allocate({ sandboxId, generation }: Pick<MachineIdentity, "sandboxId" | "generation">) {
        const machine = { sandboxId, generation, machineId: `machine-${++sequence}` };
        live.set(machine.machineId, { ...scope, ...machine, createdAt: new Date(0) });
        allocations.set(key(machine), machine);
        return machine;
      }

      function matching(machine: MachineIdentity) {
        const entry = live.get(machine.machineId);
        return (
          entry &&
          key(entry) === key(machine) &&
          entry.bindingId === scope.bindingId &&
          entry.deploymentId === scope.deploymentId
        );
      }

      function exit(machine: MachineIdentity) {
        live.delete(machine.machineId);
        bindings.delete(machine.machineId);
        workspaces.delete(machine.machineId);
      }

      return {
        async create(request) {
          fault?.("before allocation");
          const machine = (!loseCreateDeduplication && allocations.get(key(request))) || allocate(request);
          fault?.("allocation reply lost");
          return machine;
        },
        async bootstrap(request) {
          fault?.("before binding");
          if (matching(request)) bindings.set(request.machineId, request.bindingRef);
          fault?.("binding reply lost");
        },
        async stop(request) {
          fault?.("before checkpoint");
          const id = key(request);
          if (request.retain && matching(request) && !checkpoints.has(id)) {
            const { sandboxId, generation } = request;
            checkpoints.set(id, {
              retained: { sandboxId, generation, kind: stopRetention, ref: request.machineId },
              content: workspaces.get(request.machineId) ?? "",
            });
          }
          fault?.("after checkpoint");
          if (matching(request)) exit(request);
          fault?.("stop reply lost");
          return request.retain ? (checkpoints.get(id)?.retained ?? null) : null;
        },
        async resume(request) {
          fault?.("before restore");
          const checkpoint = checkpoints.get(key(request.predecessor));
          if (!checkpoint || checkpoint.retained.ref !== request.predecessor.ref) {
            throw new Error("Unknown predecessor");
          }
          const machine = allocations.get(key(request)) ?? allocate(request);
          workspaces.set(machine.machineId, checkpoint.content);
          fault?.("restore reply lost");
          return machine;
        },
        async delete(request) {
          fault?.("before delete");
          if (matching(request)) exit(request);
          if (request.scope === "physical-and-retained") checkpoints.delete(key(request));
          fault?.("delete reply lost");
        },
        async observe(request): Promise<MachineObservation> {
          const machine = allocations.get(key(request));
          if (!machine || (request.machineId && request.machineId !== machine.machineId) || !matching(machine)) {
            return { kind: "absent" };
          }
          return { kind: "present", machine, phase: bindings.has(machine.machineId) ? "running" : "starting" };
        },
        async *listInventory() {
          for (const { bindingId, ...entry } of live.values()) {
            if (bindingId === scope.bindingId) yield entry;
          }
        },
      };
    },
  };
}

const options = {
  capabilities: capabilities("modal"),
  inventory: true,
  faultSteps: {
    create: ["before allocation"],
    bootstrap: ["before binding", "binding reply lost"],
    stop: ["before checkpoint", "after checkpoint", "stop reply lost"],
    resume: ["before restore", "restore reply lost"],
    delete: ["before delete", "delete reply lost"],
  },
  lostCreateResponseStep: "allocation reply lost",
  fixture: referenceFixture,
} satisfies MachineConformanceOptions;

testMachineConformance("reference machine", options);

test("an adapter that reallocates after a lost create response fails the named recovery case", async () => {
  const scenario = machineConformanceCases({ ...options, fixture: () => referenceFixture(true) }).find(
    ({ name }) => name === "create recovers after allocation reply lost",
  );
  if (!scenario) throw new Error("Missing lost-response case");
  await expect(scenario.run()).rejects.toThrow(/machine-1/);
});
