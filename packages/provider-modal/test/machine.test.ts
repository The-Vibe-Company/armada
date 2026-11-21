import { expect, test } from "bun:test";
import { capabilities, type MachineIdentity } from "@armada/core/server";
import { ModalClient, NotFoundError } from "modal";
import { type MachineConformanceFixture, testMachineConformance } from "../../core/test-support/machine-conformance.ts";
import { createModalMachine, type ModalMachineJournal, type ModalMachineOptions } from "../src/machine.ts";

type Entry = NonNullable<Awaited<ReturnType<ModalMachineJournal["read"]>>>;
type SDK = ModalMachineOptions["client"];
type CreateParams = NonNullable<Parameters<SDK["sandboxes"]["create"]>[2]>;
type Scope = Parameters<MachineConformanceFixture["adapter"]>[0];

function fixture() {
  const entries = new Map<string, Entry>();
  const images = new Map<string, string>([["source", ""]]);
  const allocations = new Map<
    string,
    {
      id: string;
      bindingId: string;
      tags: Record<string, string>;
      name: string;
      created: number;
      exited: boolean;
      workspace: string;
      runtime: string | undefined;
    }
  >();
  const get = (id: string) => {
    const machine = allocations.get(id);
    if (!machine) throw new NotFoundError("Machine missing");
    return machine;
  };

  return {
    adapter({ deploymentId, bindingId }: Scope, fault = () => {}) {
      function handle(machine: ReturnType<typeof get>) {
        return {
          sandboxId: machine.id,
          async getTags() {
            return machine.tags;
          },
          async poll() {
            return machine.exited ? 0 : null;
          },
          async snapshotFilesystem({ ttlMs }: { ttlMs: null }) {
            if (ttlMs !== null) throw new Error("Retained image must not expire");
            const imageId = `snapshot-${images.size}`;
            images.set(imageId, machine.workspace);
            return { imageId };
          },
          async terminate() {
            machine.exited = true;
            fault("termination response");
          },
          async exec(argv: string[]) {
            fault("bootstrap dispatch");
            if (machine.exited) throw new Error("Machine exited");
            let binding: string | undefined;
            return {
              stdin: {
                async writeText(text: string) {
                  binding = JSON.parse(text).enrolmentToken;
                },
                async close() {
                  if (!binding || !argv.at(-1)?.includes("stdio:['pipe','ignore','ignore',9]"))
                    throw new Error("Missing stdin ticket or inherited lock");
                  machine.runtime ??= binding;
                },
              },
              async wait() {
                fault("bootstrap response");
                return 0;
              },
            };
          },
        };
      }
      const client = {
        apps: {
          async fromName() {
            return { appId: bindingId };
          },
        },
        images: {
          async fromId(imageId: string) {
            if (!images.has(imageId)) throw new NotFoundError("Image missing");
            return { imageId };
          },
          async delete(imageId: string) {
            if (!images.delete(imageId)) throw new NotFoundError("Image missing");
          },
        },
        sandboxes: {
          async experimentalCreate(_app: unknown, image: { imageId: string }, params: CreateParams) {
            const created = allocations.size + 1;
            const machine = {
              id: `physical-${created}`,
              bindingId,
              tags: params.tags ?? {},
              name: params.name ?? "",
              created,
              exited: false,
              workspace: images.get(image.imageId) ?? "",
              runtime: undefined as string | undefined,
            };
            allocations.set(machine.id, machine);
            fault(
              deploymentId === "deployment-a" && machine.tags.armada_generation === "2"
                ? "restore response"
                : "create response",
            );
            return handle(machine);
          },
          async fromName(_app: string, name: string) {
            const machine = Array.from(allocations.values()).find(
              (row) => row.bindingId === bindingId && row.name === name,
            );
            if (!machine) throw new NotFoundError("Name missing");
            return handle(machine);
          },
          async fromId(id: string) {
            return handle(get(id));
          },
        },
        cpClient: {
          async sandboxListV2({ appId, beforeTimestamp = Infinity }: { appId: string; beforeTimestamp?: number }) {
            const sandboxes = Array.from(allocations.values())
              .filter((row) => row.bindingId === appId && !row.exited && row.created < beforeTimestamp)
              .sort((a, b) => b.created - a.created)
              .slice(0, 1)
              .map((row) => ({
                id: row.id,
                appId,
                createdAt: row.created,
                tags: Object.entries(row.tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
              }));
            return { sandboxes };
          },
        },
      } as unknown as ModalClient;

      return createModalMachine({
        client,
        appName: "app",
        binding: { appId: bindingId, workspace: bindingId, environment: "test" },
        deploymentId,
        journal: {
          async read(key) {
            return entries.get(key);
          },
          async compareAndSet(key, revision, next) {
            if (entries.get(key)?.revision !== revision) return false;
            entries.set(key, next);
            if (next.phase === "stopping" && next.recoveryImageId) fault("retention receipt");
            if (next.phase === "deleted") fault("delete receipt");
            return true;
          },
        },
        async resolveRuntimeTicket({ bindingRef, machineId }) {
          if (get(machineId).runtime) return null;
          return {
            serverUrl: "https://armada.invalid",
            artifact: { sha256: "a".repeat(64), bytes: 1 },
            cacheDir: "/home/user/runtime-cache",
            enrolmentToken: `armada_enrol_${(bindingRef === "replacement-binding" ? "c" : "b").repeat(64)}`,
          };
        },
        async prepareCheckpoint() {
          fault("before snapshot intent");
        },
      });
    },
    liveMachines() {
      return Array.from(allocations.values())
        .filter((row) => !row.exited)
        .map((row) => ({
          machineId: row.id,
          bindingId: row.bindingId,
          deploymentId: row.tags.armada_deployment ?? "",
          sandboxId: row.tags.armada_sandbox ?? "",
          generation: Number(row.tags.armada_generation),
          createdAt: new Date(row.created * 1000),
        }));
    },
    committedRetention(scope, incarnation) {
      const machine = Array.from(allocations.values()).find(
        (row) =>
          row.bindingId === scope.bindingId &&
          row.tags.armada_deployment === scope.deploymentId &&
          row.tags.armada_sandbox === incarnation.sandboxId &&
          Number(row.tags.armada_generation) === incarnation.generation,
      );
      const entry = Array.from(entries.values()).find((row) => row.machineId === machine?.id);
      return entry?.recoveryImageId
        ? {
            sandboxId: incarnation.sandboxId,
            generation: incarnation.generation,
            kind: "image",
            ref: entry.recoveryImageId,
          }
        : undefined;
    },
    runtimeBindings(machine: MachineIdentity) {
      const token = get(machine.machineId).runtime;
      return token ? [token.endsWith("c") ? "replacement-binding" : "runtime-binding"] : [];
    },
    writeWorkspace(machine, content) {
      get(machine.machineId).workspace = content;
    },
    readWorkspace(machine) {
      return get(machine.machineId).workspace;
    },
  } satisfies MachineConformanceFixture;
}

testMachineConformance("Modal machine", {
  capabilities: capabilities("modal"),
  inventory: true,
  fixture,
  lostCreateResponseStep: "create response",
  faultSteps: {
    create: ["create response"],
    bootstrap: ["bootstrap dispatch", "bootstrap response"],
    stop: ["before snapshot intent", "retention receipt", "termination response"],
    resume: ["restore response"],
    delete: ["termination response", "delete receipt"],
  },
});

for (const recovery of ["bootstrap", "delete"] as const) {
  test(`Modal can ${recovery} an observed allocation after the create response is lost`, async () => {
    const world = fixture();
    const scope = { deploymentId: "deployment-a", bindingId: "binding-a" };
    const incarnation = { sandboxId: "interrupted-launch", generation: 1 };
    const interrupted = world.adapter(scope, (step) => {
      if (step === "create response") throw new Error("create response lost");
    });
    await expect(
      interrupted.create({
        ...incarnation,
        source: { kind: "image", ref: "source" },
        size: null,
        computeTtlSeconds: 600,
      }),
    ).rejects.toThrow("create response lost");

    const successor = world.adapter(scope);
    const observed = await successor.observe(incarnation);
    if (observed.kind !== "present") throw new Error("Expected the original Modal allocation");
    const { machine } = observed;
    if (recovery === "bootstrap") {
      await successor.bootstrap({ ...machine, bindingRef: "runtime-binding" });
      expect(world.runtimeBindings(machine)).toEqual(["runtime-binding"]);
      expect(world.liveMachines().map(({ machineId }) => machineId)).toEqual([machine.machineId]);
    } else {
      await successor.delete({ ...machine, scope: "physical-only" });
      expect(await successor.observe(machine)).toEqual({ kind: "absent", receipt: { operation: "delete" } });
      expect(world.liveMachines()).toEqual([]);
    }
  });
}

test("Modal Machine recovers a lost create reply with the SDK profile set to V1", async () => {
  type CreateV2 = Parameters<ModalClient["cpClient"]["sandboxCreateV2"]>[0];
  let v2: CreateV2 | undefined;
  let allocations = 0;
  const machineId = "sbv2-allocation";
  const loseReply = () => {
    allocations++;
    throw new Error("Lost create reply");
  };
  const sdk = new ModalClient({
    tokenId: "test",
    tokenSecret: "test",
    cpClient: {
      sandboxCreate: async () => loseReply(),
      async sandboxCreateV2(request: CreateV2) {
        v2 = request;
        loseReply();
      },
      async sandboxGetFromNameV2({ sandboxName, includeTerminated }) {
        if (!includeTerminated || !v2 || sandboxName !== v2.definition?.name)
          throw new Error("V2 allocation is unavailable by name");
        return { sandboxId: machineId };
      },
      async sandboxTagsGetV2() {
        return { tags: v2?.tags ?? [] };
      },
      async sandboxWaitV2() {
        return {};
      },
    } as ModalClient["cpClient"],
  });
  sdk.profile.sandboxV2 = false;
  const entries = new Map<string, Entry>();
  const adapter = () =>
    createModalMachine({
      client: {
        ...sdk,
        apps: { fromName: async () => ({ appId: "app-id" }) } as SDK["apps"],
        images: { fromId: async () => ({ imageId: "source", async build() {} }) } as SDK["images"],
      },
      appName: "app",
      binding: { appId: "app-id", workspace: "workspace", environment: "test" },
      deploymentId: "deployment",
      journal: {
        async read(key) {
          return entries.get(key);
        },
        async compareAndSet(key, revision, next) {
          if (entries.get(key)?.revision !== revision) return false;
          entries.set(key, next);
          return true;
        },
      },
      resolveRuntimeTicket: async () => null,
      prepareCheckpoint: async () => {},
    });
  const incarnation = { sandboxId: "sandbox", generation: 1 };
  const request = {
    ...incarnation,
    source: { kind: "image" as const, ref: "source" },
    size: null,
    computeTtlSeconds: 60,
  };
  try {
    await expect(adapter().create(request)).rejects.toThrow("Lost create reply");
    const successor = adapter();
    const identity = { ...incarnation, machineId };
    expect(await successor.observe(incarnation)).toMatchObject({ kind: "present", machine: identity });
    expect(await successor.create(request)).toEqual(identity);
    expect(allocations).toBe(1);
  } finally {
    sdk.close();
  }
});
