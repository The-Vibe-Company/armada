import { capabilities, type MachineIdentity } from "@armada/core/server";
import { type ModalClient, NotFoundError } from "modal";
import { type MachineConformanceFixture, testMachineConformance } from "../../core/test-support/machine-conformance.ts";
import { createModalMachine, type ModalMachineJournal, type ModalMachineOptions } from "../src/machine.ts";

type Entry = NonNullable<Awaited<ReturnType<ModalMachineJournal["read"]>>>;
type SDK = ModalMachineOptions["client"];
type CreateParams = NonNullable<Parameters<SDK["sandboxes"]["experimentalCreate"]>[2]>;
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
      runtime: Set<string>;
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
          async snapshotFilesystem() {
            fault("snapshot dispatch");
            const imageId = `snapshot-${images.size}`;
            images.set(imageId, machine.workspace);
            fault("snapshot response");
            return { imageId };
          },
          async terminate() {
            machine.exited = true;
            fault("termination response");
          },
          async exec(argv: string[]) {
            fault("bootstrap dispatch");
            if (machine.exited) throw new Error("Machine exited");
            let received = false;
            return {
              stdin: {
                async writeText(text: string) {
                  received = Boolean(JSON.parse(text).enrolmentToken);
                },
                async close() {
                  const binding = /, binding="([a-f0-9]+)";/.exec(argv.at(-1) ?? "")?.[1];
                  if (!received || !binding) throw new Error("Missing stdin ticket or binding guard");
                  machine.runtime.add(binding);
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
              runtime: new Set<string>(),
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
        async resolveRuntimeTicket() {
          return {
            serverUrl: "https://armada.invalid",
            artifact: { sha256: "a".repeat(64), bytes: 1 },
            cacheDir: "/home/user/runtime-cache",
            enrolmentToken: `armada_enrol_${"b".repeat(64)}`,
          };
        },
        async prepareCheckpoint() {},
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
      const binding = new Bun.CryptoHasher("sha256").update(JSON.stringify("replacement-binding")).digest("hex");
      return Array.from(get(machine.machineId).runtime, (key) =>
        key === binding ? "replacement-binding" : "runtime-binding",
      );
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
    stop: ["snapshot dispatch", "snapshot response", "retention receipt", "termination response"],
    resume: ["restore response"],
    delete: ["termination response", "delete receipt"],
  },
});
