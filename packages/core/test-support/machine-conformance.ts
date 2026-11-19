import { expect, test } from "bun:test";
import type {
  Machine,
  MachineCapabilities,
  MachineIdentity,
  MachineIncarnation,
  MachineInventoryEntry,
  MachineObservation,
  RetainedMachine,
} from "../src/machine.ts";

type Mutation = "create" | "bootstrap" | "stop" | "resume" | "delete";
type Scope = { deploymentId: string; bindingId: string };
type LiveMachine = MachineInventoryEntry & { bindingId: string };
type FaultHook = (step: string) => void;

export interface MachineConformanceFixture {
  adapter(scope: Scope, fault?: FaultHook): Machine;
  liveMachines(): readonly LiveMachine[];
  committedRetention(scope: Scope, machine: MachineIncarnation): RetainedMachine | undefined;
  runtimeBindings(machine: MachineIdentity): readonly string[];
  writeWorkspace(machine: MachineIdentity, content: string): void;
  readWorkspace(machine: MachineIdentity): string | undefined;
}

export interface MachineConformanceOptions {
  capabilities: MachineCapabilities;
  inventory: boolean;
  faultSteps: Readonly<Record<Mutation, readonly [string, ...string[]]>>;
  lostCreateResponseStep: string;
  fixture(): MachineConformanceFixture;
}

interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

const scope = { deploymentId: "deployment-a", bindingId: "binding-a" };
const incarnation = { sandboxId: "sandbox-a", generation: 1 };
const next = { ...incarnation, generation: 2 };
const workspace = "retained workspace marker";

function expectPresent(observation: MachineObservation, machine: MachineIdentity) {
  expect(observation).toMatchObject({ kind: "present", machine });
}

function expectExited(observation: MachineObservation) {
  if (observation.kind !== "absent") {
    expect(observation).toMatchObject({ kind: "present", phase: "stopped" });
  }
}

function physicalMachines(fixture: MachineConformanceFixture, incarnation: MachineIncarnation) {
  return fixture
    .liveMachines()
    .filter(
      (entry) =>
        entry.bindingId === scope.bindingId &&
        entry.deploymentId === scope.deploymentId &&
        entry.sandboxId === incarnation.sandboxId &&
        entry.generation === incarnation.generation,
    );
}

function expectAllocation(fixture: MachineConformanceFixture, machine: MachineIdentity) {
  expect(physicalMachines(fixture, machine).map((entry) => entry.machineId)).toEqual([machine.machineId]);
}

function expectRetention(retained: RetainedMachine | null, kind: MachineCapabilities["stopRetention"]) {
  expect(retained).toMatchObject({ ...incarnation, kind });
  if (!retained?.ref) throw new Error("Retained stop did not return a recovery reference");
  return retained;
}

export function machineConformanceCases(options: MachineConformanceOptions) {
  const { capabilities } = options;
  const allocation = {
    size: capabilities.sizes[0] ?? null,
    computeTtlSeconds: Math.min(60, capabilities.maxTtlSeconds),
  };
  const createRequest = (id: MachineIncarnation) => ({
    ...id,
    ...allocation,
    source: { kind: capabilities.snapshots === "required" ? ("snapshot" as const) : ("image" as const), ref: "source" },
  });
  const bootstrap = (adapter: Machine, machine: MachineIdentity) =>
    adapter.bootstrap({ ...machine, bindingRef: "runtime-binding" });
  const remove = (adapter: Machine, machine: MachineIdentity) => adapter.delete({ ...machine, scope: "physical-only" });

  const cases: ConformanceCase[] = [
    {
      name: "duplicate create",
      async run() {
        const fixture = options.fixture();
        const request = createRequest(incarnation);
        const first = await fixture.adapter(scope).create(request);
        expect(first).toMatchObject(incarnation);
        expect(await fixture.adapter(scope).create(request)).toEqual(first);
        expectAllocation(fixture, first);
      },
    },
    {
      name: "delete is idempotent",
      async run() {
        const fixture = options.fixture();
        const machine = await fixture.adapter(scope).create(createRequest(incarnation));
        await remove(fixture.adapter(scope), machine);
        expect(physicalMachines(fixture, machine)).toEqual([]);
        await remove(fixture.adapter(scope), machine);
        expect(physicalMachines(fixture, machine)).toEqual([]);
        expect(await fixture.adapter(scope).observe(machine)).toMatchObject({ kind: "absent" });
      },
    },
    {
      name: "non-retaining stop returns no recovery reference",
      async run() {
        const adapter = options.fixture().adapter(scope);
        const machine = await adapter.create(createRequest(incarnation));
        expect(await adapter.stop({ ...machine, retain: false })).toBeNull();
        expectExited(await adapter.observe(machine));
      },
    },
  ];

  async function retainedSource(fixture: MachineConformanceFixture) {
    const adapter = fixture.adapter(scope);
    const machine = await adapter.create(createRequest(incarnation));
    fixture.writeWorkspace(machine, workspace);
    const retained = expectRetention(await adapter.stop({ ...machine, retain: true }), capabilities.stopRetention);
    expectExited(await adapter.observe(machine));
    return { machine, retained };
  }

  cases.push({
    name: "retained stop and resume preserve workspace",
    async run() {
      const fixture = options.fixture();
      const { machine, retained } = await retainedSource(fixture);
      const adapter = fixture.adapter(scope);
      expect(await adapter.stop({ ...machine, retain: true })).toEqual(retained);
      const request = { ...next, ...allocation, predecessor: retained };
      const restored = await adapter.resume(request);
      expect(restored).toMatchObject(next);
      expect(await fixture.adapter(scope).resume(request)).toEqual(restored);
      expect(fixture.readWorkspace(restored)).toBe(workspace);
      expectAllocation(fixture, restored);
    },
  });

  for (const operation of ["bootstrap", "stop", "delete"] as const) {
    for (const target of ["predecessor", "replacement"] as const) {
      cases.push({
        name: `stale ${operation} with ${target} ID leaves replacement intact`,
        async run() {
          const fixture = options.fixture();
          const { machine, retained } = await retainedSource(fixture);
          const adapter = fixture.adapter(scope);
          const replacement = await adapter.resume({ ...next, ...allocation, predecessor: retained });
          await adapter.bootstrap({ ...replacement, bindingRef: "replacement-binding" });
          const before = await adapter.observe(replacement);
          if (before.kind !== "present") throw new Error("Replacement was not observable before the stale request");
          const stale = { ...machine, machineId: target === "predecessor" ? machine.machineId : replacement.machineId };
          const staleOperation = {
            bootstrap: () => bootstrap(adapter, stale),
            stop: () => adapter.stop({ ...stale, retain: true }),
            delete: () => remove(adapter, stale),
          }[operation];
          await staleOperation().catch(() => undefined);
          expect(await adapter.observe(replacement)).toMatchObject({
            kind: "present",
            machine: replacement,
            phase: before.phase,
          });
          expectAllocation(fixture, replacement);
          expect(fixture.runtimeBindings(replacement)).toEqual(["replacement-binding"]);
          expect(fixture.readWorkspace(replacement)).toBe(workspace);
        },
      });
    }
  }

  type FaultScenario = {
    setup(fixture: MachineConformanceFixture): Promise<{
      invoke(adapter: Machine): Promise<unknown>;
      recover(adapter: Machine, step: string): Promise<void>;
    }>;
  };
  const scenarios: Record<Mutation, FaultScenario> = {
    create: {
      async setup(fixture) {
        const request = createRequest(incarnation);
        return {
          invoke: (adapter) => adapter.create(request),
          async recover(adapter, step) {
            const observed = await adapter.observe(incarnation);
            if (step === options.lostCreateResponseStep) {
              expect(observed).toMatchObject({ kind: "present", machine: incarnation });
            }
            const machine = await adapter.create(request);
            expect(machine).toMatchObject(incarnation);
            if (observed.kind === "present") expect(observed.machine).toEqual(machine);
            expectPresent(await adapter.observe(incarnation), machine);
            expectAllocation(fixture, machine);
          },
        };
      },
    },
    bootstrap: {
      async setup(fixture) {
        const machine = await fixture.adapter(scope).create(createRequest(incarnation));
        return {
          invoke: (adapter) => bootstrap(adapter, machine),
          async recover(adapter) {
            await bootstrap(adapter, machine);
            expect(fixture.runtimeBindings(machine)).toEqual(["runtime-binding"]);
            expectPresent(await adapter.observe(machine), machine);
            expectAllocation(fixture, machine);
          },
        };
      },
    },
    stop: {
      async setup(fixture) {
        const machine = await fixture.adapter(scope).create(createRequest(incarnation));
        fixture.writeWorkspace(machine, workspace);
        const request = { ...machine, retain: true };
        return {
          invoke: (adapter) => adapter.stop(request),
          async recover(adapter) {
            const committed = fixture.committedRetention(scope, machine);
            const retained = expectRetention(await adapter.stop(request), capabilities.stopRetention);
            if (committed) expect(retained).toEqual(committed);
            expectExited(await adapter.observe(machine));
            const restored = await adapter.resume({ ...next, ...allocation, predecessor: retained });
            expect(fixture.readWorkspace(restored)).toBe(workspace);
          },
        };
      },
    },
    resume: {
      async setup(fixture) {
        const { retained } = await retainedSource(fixture);
        const request = { ...next, ...allocation, predecessor: retained };
        return {
          invoke: (adapter) => adapter.resume(request),
          async recover(adapter) {
            const committed = physicalMachines(fixture, next);
            const restored = await adapter.resume(request);
            expect(restored).toMatchObject(next);
            for (const prior of committed) expect(restored.machineId).toBe(prior.machineId);
            expectPresent(await adapter.observe(next), restored);
            expectAllocation(fixture, restored);
            expect(fixture.readWorkspace(restored)).toBe(workspace);
          },
        };
      },
    },
    delete: {
      async setup(fixture) {
        const machine = await fixture.adapter(scope).create(createRequest(incarnation));
        return {
          invoke: (adapter) => remove(adapter, machine),
          async recover(adapter) {
            await remove(adapter, machine);
            expect(physicalMachines(fixture, machine)).toEqual([]);
            expect(await adapter.observe(machine)).toMatchObject({ kind: "absent" });
          },
        };
      },
    },
  };

  for (const operation of ["create", "bootstrap", "stop", "resume", "delete"] as const) {
    const steps = new Set(options.faultSteps[operation]);
    if (operation === "create") steps.add(options.lostCreateResponseStep);
    for (const step of steps) {
      cases.push({
        name: `${operation} recovers after ${step}`,
        async run() {
          const fixture = options.fixture();
          const { invoke, recover } = await scenarios[operation].setup(fixture);
          let tripped = false;
          const adapter = fixture.adapter(scope, (boundary) => {
            if (boundary !== step) return;
            tripped = true;
            throw new Error(`Injected fault at ${step}`);
          });
          await invoke(adapter).catch(() => undefined);
          expect(tripped).toBe(true);
          await recover(fixture.adapter(scope), step);
        },
      });
    }
  }

  if (options.inventory) {
    cases.push({
      name: "inventory is scoped to the bound account or host",
      async run() {
        const fixture = options.fixture();
        const adapter = fixture.adapter(scope);
        const own = await adapter.create(createRequest(incarnation));
        const otherDeployment = { ...scope, deploymentId: "deployment-b" };
        const sameBinding = await fixture.adapter(otherDeployment).create(createRequest(next));
        await fixture.adapter({ ...scope, bindingId: "binding-b" }).create(createRequest({ ...next, generation: 3 }));
        if (!adapter.listInventory) throw new Error("Adapter did not implement inventory");
        const entries = await Array.fromAsync(adapter.listInventory());
        expect(entries).toHaveLength(2);
        expect(entries).toContainEqual({ ...own, deploymentId: scope.deploymentId, createdAt: expect.any(Date) });
        expect(entries).toContainEqual({
          ...sameBinding,
          deploymentId: otherDeployment.deploymentId,
          createdAt: expect.any(Date),
        });
      },
    });
  }
  return cases;
}

export function testMachineConformance(name: string, options: MachineConformanceOptions) {
  for (const scenario of machineConformanceCases(options)) {
    test(`${name}: ${scenario.name}`, scenario.run);
  }
}
