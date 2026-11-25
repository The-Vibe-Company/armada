import type { DockerHostVersionOffer, DockerJobFailureReason } from "./docker-api.ts";
import type { DockerHostJob } from "./docker-host-job.ts";
import type { DockerHostResources, DockerSandboxLimits } from "./docker-resource-policy.ts";

import type { SnapshotBaselineTool } from "./snapshot-baseline.ts";

export const DOCKER_HOST_MACHINE_BOOTSTRAP_HEADER = "x-armada-docker-host-machine-bootstrap";
export const DOCKER_HOST_RESTORE_RECOVERY_HEADER = "x-armada-docker-host-restore-recovery";
export const DOCKER_HOST_PREFER_STARTUP_HEADER = "x-armada-docker-host-prefer-startup";

export interface DockerHostPollRequest {
  installationId: string;
  version: string;
  resumeClaimProtocol: 1;
  resources: DockerHostResources;
  resourcePolicyVersion: 1;
  retentionSeconds: number;
  nextCleanupAt: string | null;
  deadlines: { sandboxId: string; generation: string; deadline: string }[];
  diskFreeBytes?: number | null;
  stoppedSandboxBytes?: number | null;
  skipSnapshots?: true;
  waitSeconds?: number;
  running?: string[];
}

export interface DockerHostPollResponse extends DockerHostVersionOffer {
  job: DockerHostJob | null;
  containerInventory?: 1;
  containerInventoryDeploymentId?: string;
  held?: true;
  limits?: DockerSandboxLimits;
  retentionSeconds?: number;
  restoreRecovery?: Extract<DockerHostJob, { operation: "restore" }>;
  pendingStarts?: { sandboxId: string; generation: string }[];
  resumeClaims?: { requestId: string; sandboxId: string; generation: string }[];
}

export type DockerHostResultRequest = { installationId: string; requestId: string; imageId?: string } & (
  | { claimed: boolean }
  | { cleaned: true; cleanupReason?: "retention_elapsed" | "disk_pressure" }
  | { expired: true }
  | {
      outcome: "completed" | "failed";
      reason?: DockerJobFailureReason;
      machineId?: string;
      absentMachineId?: string;
      baselineVersion?: number;
      baselineTool?: SnapshotBaselineTool;
      missingRefIndex?: number;
    }
);
