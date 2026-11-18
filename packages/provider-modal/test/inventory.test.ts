import { expect, test } from "bun:test";
import { ProviderError, type ProviderInventoryMachine } from "@armada/core";
import type { ModalClient } from "modal";
import { createModalProvider, type Machine, type ModalProviderOptions, type ModalStore } from "../src/index.ts";

const appId = "ap_bound";
const deploymentId = "staging_server";
const tags = {
  armada_deployment: deploymentId,
  armada_sandbox: "modal_owned",
  armada_generation: "3",
};
type List = ModalClient["cpClient"]["sandboxListV2"];
type Page = Awaited<ReturnType<List>>;
type ListedSandbox = Page["sandboxes"][number];

function listed(id: string, createdAt: number, ownership: Record<string, string>, app = appId): ListedSandbox {
  return {
    id,
    appId: app,
    createdAt,
    tags: Object.entries(ownership).map(([tagName, tagValue]) => ({ tagName, tagValue })),
  } as ListedSandbox;
}

function fixture(overrides: Partial<ModalProviderOptions> = {}, sdk: Partial<ModalClient> = {}) {
  return createModalProvider({
    client: {
      apps: {
        async fromName(name: string, options: object) {
          expect(name).toBe("bound");
          expect(options).toEqual({ environment: "modal_env", createIfMissing: false });
          return { appId };
        },
      },
      ...sdk,
    } as ModalClient,
    deploymentId,
    scope: {
      orgId: "org",
      userId: "user",
      visibility: "org",
      binding: { workspace: "workspace", environment: "modal_env", appId },
    },
    appName: "bound",
    store: {} as ModalStore,
    distribution: {
      capabilities: {},
      image: async () => {
        throw new Error("Unexpected builder image");
      },
      start: async () => {},
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    },
    runner: {
      async call() {
        throw new Error("Unexpected runner call");
      },
    },
    ...overrides,
  });
}

async function collect(iterable: AsyncIterable<ProviderInventoryMachine>) {
  const machines: ProviderInventoryMachine[] = [];
  for await (const machine of iterable) machines.push(machine);
  return machines;
}

test("Modal inventory paginates the bound App and yields only exact deployment matches", async () => {
  const pages = new Map<number | undefined, ListedSandbox[]>([
    [
      undefined,
      [
        listed("sb_first", 50.125, tags),
        listed("sb_untagged", 49, { armada_sandbox: "modal_untagged" }),
        listed("sb_foreign", 48, { ...tags, armada_deployment: "production_server" }),
        listed("sb_other_app", 47, tags, "ap_other"),
      ],
    ],
    [47, [listed("sb_second", 40.5, { ...tags, armada_sandbox: "modal_second", armada_generation: "1" })]],
    [40.5, []],
  ]);
  const sandboxListV2: List = async (request) => {
    expect(request.appId).toBe(appId);
    expect(request.includeFinished).toBe(false);
    expect(request.tags).toEqual([{ tagName: "armada_deployment", tagValue: deploymentId }]);
    const sandboxes = pages.get(request.beforeTimestamp);
    if (!sandboxes) throw new Error("Unexpected page cursor");
    pages.delete(request.beforeTimestamp);
    return { sandboxes };
  };
  const provider = fixture({}, { cpClient: { sandboxListV2 } as ModalClient["cpClient"] });

  expect(await collect(provider.listInventory())).toEqual([
    { machineId: "sb_first", sandboxId: "modal_owned", generation: "3", deploymentId, createdAt: new Date(50_125) },
    { machineId: "sb_second", sandboxId: "modal_second", generation: "1", deploymentId, createdAt: new Date(40_500) },
  ]);
  expect(pages.size).toBe(0);
});

test("Modal inventory surfaces a later page failure as a retryable provider error", async () => {
  const sandboxListV2: List = async ({ beforeTimestamp }) => {
    if (beforeTimestamp === undefined) return { sandboxes: [listed("sb_first", 50, tags)] };
    throw Object.assign(new Error("private SDK diagnostic"), { name: "TimeoutError" });
  };
  const provider = fixture({}, { cpClient: { sandboxListV2 } as ModalClient["cpClient"] });
  const pages = provider.listInventory();
  expect((await pages.next()).value).toMatchObject({ machineId: "sb_first" });
  try {
    await pages.next();
    throw new Error("Expected inventory to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "modal", code: "unavailable", retryable: true });
    expect((error as Error).message).not.toContain("private SDK diagnostic");
  }
});

test("Modal attaches deployment ownership to the allocation request for a runtime fork", async () => {
  const snapshot = {
    info: { name: "golden", status: "ready" },
    sourceId: "modal_golden",
    imageId: "im_golden",
    managementAuthority: { credentialScope: "org", credentialOwnerId: "org" },
  };
  let machine: Machine;
  const store = {
    image: async () => snapshot,
    reserve: async (_key: string, reservation: Machine) => {
      machine = reservation;
      return reservation;
    },
    lease: async (id: string, work: (row: Machine, save: () => Promise<void>) => Promise<unknown>) =>
      work(id === snapshot.sourceId ? ({ golden: true } as Machine) : machine, async () => {}),
  } as ModalStore;
  let creationTags: Record<string, string> | undefined;
  const provider = fixture(
    { store, commonRuntime: true },
    {
      images: { fromId: async () => ({ imageId: snapshot.imageId }) } as unknown as ModalClient["images"],
      sandboxes: {
        async create(_app: unknown, _image: unknown, params: { tags: Record<string, string> }) {
          creationTags = params.tags;
          return { sandboxId: "sb_new" };
        },
      } as unknown as ModalClient["sandboxes"],
    },
  );

  const fork = await provider.fork({ from: snapshot.info.name });
  expect(creationTags).toMatchObject({
    armada_deployment: deploymentId,
    armada_sandbox: fork.id,
    armada_generation: "1",
  });
});
