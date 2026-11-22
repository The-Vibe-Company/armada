import type { MachineCapabilities, MachineSize } from "./machine-capabilities.ts";
import type { ProviderInventoryMachine } from "./provider.ts";

export { capabilities, type MachineCapabilities } from "./machine-capabilities.ts";

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

  listInventory?(signal?: AbortSignal): AsyncIterable<MachineInventoryEntry | ProviderInventoryMachine>;
}
