import type { Harness } from "./contract.ts";
import type { SandboxStatus } from "./database.types.ts";
import type { MachineSize } from "./machine-size.ts";
import type { SandboxProviderId } from "./sandbox-provider.ts";
import type { TaskOutcome } from "./task-outcome.ts";

/** Version 1 organization list contract. Never extend from the interior SandboxRecord. */
export interface SandboxListMetadata {
  preservationNote?: string | null;
  /** Interior-only: null for organization metadata-only viewers. */
  taskOutcome?: TaskOutcome | null;
  id: string;
  orgId: string;
  ownerId: string;
  provider: SandboxProviderId;
  /** Canonical provider display id (bx_ on Boat), not a credential or routing URL. Null if unavailable. */
  providerSandboxId: string | null;
  /** Compatibility display alias: equals providerSandboxId for Boat, always null for Modal. */
  boatId: string | null;
  harness: Harness;
  model: string | null;
  reasoningEffort: string | null;
  status: SandboxStatus;
  createdAt: string;
  stoppedAt: string | null;
  expiresAt: string | null;
  effectiveTtlSeconds: number | null;
  /** Effective size only, not repository-specific size evidence. */
  machineSize: MachineSize | null;
  /** Generated from logical id, never the source golden's name/configuration. */
  displayLabel: string;
  canOpen: boolean;
  canManage: boolean;
}

/** The membership/role passed here MUST be read currently, not taken from a token claim. */
export function canAccessSandboxInterior(
  sandbox: { ownerId: string },
  caller: { userId: string; currentRole: "admin" | "member" | null },
): boolean {
  return caller.currentRole !== null && (sandbox.ownerId === caller.userId || caller.currentRole === "admin");
}
