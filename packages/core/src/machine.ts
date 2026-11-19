import { MACHINE_SIZES, type MachineSize } from "./machine-size.ts";
import { PROVIDER_LIMITS, type SandboxPlacementProviderId } from "./sandbox-provider.ts";

export interface MachineCapabilities {
  readonly maxTtlSeconds: number;
  readonly stopRetention: "disk" | "image" | "container";
  readonly snapshots: "required" | "optional";
  readonly extendLifetime: boolean;
  readonly humanSsh: boolean;
  readonly resourceSampler: boolean;
  readonly sizes: readonly MachineSize[];
}

const catalogSizes = Object.freeze([...MACHINE_SIZES]);
const machineCapabilities: Readonly<Record<SandboxPlacementProviderId, MachineCapabilities>> = {
  boat: Object.freeze({
    maxTtlSeconds: PROVIDER_LIMITS.boat.maxTtlSeconds,
    stopRetention: "disk",
    snapshots: "required",
    extendLifetime: true,
    humanSsh: true,
    resourceSampler: true,
    sizes: catalogSizes,
  }),
  modal: Object.freeze({
    maxTtlSeconds: PROVIDER_LIMITS.modal.maxTtlSeconds,
    stopRetention: "image",
    snapshots: "optional",
    extendLifetime: true,
    humanSsh: true,
    resourceSampler: true,
    sizes: catalogSizes,
  }),
  docker: Object.freeze({
    maxTtlSeconds: PROVIDER_LIMITS.docker.maxTtlSeconds,
    stopRetention: "container",
    snapshots: "optional",
    extendLifetime: false,
    humanSsh: false,
    resourceSampler: false,
    sizes: Object.freeze([]),
  }),
};

export function capabilities(providerId: SandboxPlacementProviderId) {
  return machineCapabilities[providerId];
}

export interface MachineIncarnation {
  readonly sandboxId: string;
  readonly generation: number;
}

export interface MachineIdentity extends MachineIncarnation {
  readonly machineId: string;
}

export interface RetainedMachine extends MachineIncarnation {
  readonly kind: MachineCapabilities["stopRetention"];
  readonly ref: string;
}

export interface MachineInventoryEntry extends MachineIdentity {
  readonly deploymentId: string;
  readonly createdAt: Date;
}

export type MachineReceipt =
  | { readonly operation: "create" | "resume"; readonly machine: MachineIdentity }
  | { readonly operation: "bootstrap"; readonly bindingRef: string }
  | { readonly operation: "stop"; readonly retained: RetainedMachine | null }
  | { readonly operation: "delete" };

export type MachineObservation =
  | {
      readonly kind: "present";
      readonly machine: MachineIdentity;
      readonly phase: "starting" | "running" | "stopping" | "stopped";
      readonly receipt?: MachineReceipt;
    }
  | { readonly kind: "absent"; readonly receipt?: MachineReceipt }
  | { readonly kind: "unknown" };

type OperationOptions = { readonly signal?: AbortSignal };
type AllocationOptions = OperationOptions & {
  readonly size: MachineSize | null;
  readonly computeTtlSeconds: number;
};

export interface Machine {
  create(
    request: MachineIncarnation &
      AllocationOptions & { readonly source: { readonly kind: "image" | "snapshot"; readonly ref: string } },
  ): Promise<MachineIdentity>;

  bootstrap(request: MachineIdentity & OperationOptions & { readonly bindingRef: string }): Promise<void>;

  stop(request: MachineIdentity & OperationOptions & { readonly retain: boolean }): Promise<RetainedMachine | null>;

  resume(
    request: MachineIncarnation & AllocationOptions & { readonly predecessor: RetainedMachine },
  ): Promise<MachineIdentity>;

  delete(
    request: MachineIdentity & OperationOptions & { readonly scope: "physical-only" | "physical-and-retained" },
  ): Promise<void>;

  observe(
    request: MachineIncarnation & OperationOptions & { readonly machineId?: string },
  ): Promise<MachineObservation>;

  listInventory?(signal?: AbortSignal): AsyncIterable<MachineInventoryEntry>;
}
