import type { Harness } from "./contract.ts";
import type { CredentialKind } from "./database.types.ts";
import { DOCKER_DISK_FLOOR_MESSAGE } from "./docker-disk-policy.ts";
import { DOCKER_HOST_DRAINING_MESSAGE } from "./docker-host-drain.ts";
import { GITHUB_CALLER_NOT_CONNECTED } from "./github.ts";
import type { GitHubLaunchInfo } from "./launch.ts";
import type { MachineSize, MachineSizeEvidence } from "./machine-size.ts";
import type { HarnessModels } from "./models.ts";
import type { PromptOutcome } from "./outcome.ts";
import type { SandboxRecord } from "./sandbox.ts";
import type { SandboxUsage } from "./sandbox-usage.ts";

/** Placement is wider than golden identity: Docker plain images are not goldens. */
export type { SandboxPlacementProviderId } from "./sandbox-provider.ts";

import type { SandboxPlacementProviderId } from "./sandbox-provider.ts";
export interface DockerHostResourceSummary {
  machine: { cpus: number; memoryBytes: number; availableCpus?: number; availableMemoryBytes?: number };
  perSandbox: { cpus: number; memoryBytes: number; pids: number };
  capacity: number;
  /** Automatic slots withheld because external workloads consume headroom. */
  heldBack?: number;
  mode: "automatic" | "manual";
}
export interface DockerHostSummary {
  id: string;
  name: string | null;
  /** Online means a recent heartbeat, not a launch/readiness guarantee. Draining takes no new work. */
  state: "pending" | "online" | "offline" | "draining" | "revoked";
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** The daemon version the host last reported (#1453); absent or null until a host has reported one. */
  version?: string | null;
  /** Physical reservations, including pending starts until confirmed stopped. */
  running?: number;
  /** Missing on older servers; null until upgraded host hardware has been observed. */
  resources?: DockerHostResourceSummary | null;
  canManageLimits?: boolean;
  retentionSeconds?: number | null;
  retentionOverrideSeconds?: number | null;
  nextCleanupAt?: string | null;
  /** Available bytes on the Docker data filesystem; absent/null on older or unreadable hosts. */
  diskFreeBytes?: number | null;
  /** Approximate container writable layers plus attached volumes for owned stopped sandboxes. */
  stoppedSandboxBytes?: number | null;
  limitsSupported?: boolean;
  /** Retained sandboxes, including stopped/failed, excluding deleted. */
  sandboxes: number;
}
export interface DockerHostListResponse {
  serverVersion?: string;
  /** Normal launch is wired and opted in, not merely private preview availability. */
  placement: boolean;
  hosts: DockerHostSummary[];
}
export interface DockerHostRegistrationResponse {
  hostId: string;
  /** Single-use, five-minute capability. Show once, never persist or log it. */
  registrationToken: string;
  /** One-click shell command containing only the short-lived registration capability. */
  command: string;
  expiresAt: string;
}

/** Code/feature support only. Authorization and selected-account admission remain server policy. */
export interface LaunchProviderCapabilities {
  launch: boolean;
  status: boolean;
  logs: boolean;
  followupPrompts: boolean;
  stop: boolean;
  delete: boolean;
  resume: boolean;
  goldens: boolean;
  repositories: boolean;
  /** Absent on older servers: no readable-variable delivery support. */
  variables?: boolean;
  secrets?: boolean;
  machineSizes: boolean;
  github: boolean;
  mcp: boolean;
  skills: boolean;
  exec: boolean;
  steer: boolean;
  interrupt: boolean;
}
export type LaunchCapabilityName = keyof LaunchProviderCapabilities;
export interface LaunchProviderOption {
  id: SandboxPlacementProviderId;
  enabled: boolean;
  launchSources: readonly ("golden" | "image")[];
  harnesses: readonly Harness[];
  capabilities: LaunchProviderCapabilities;
  unsupportedReasons: Partial<Record<LaunchCapabilityName, string>>;
}
export interface LaunchOptionsResponse {
  harnesses: readonly (HarnessModels & { id: Harness; credentialKinds: readonly CredentialKind[] })[];
  machineSizes: readonly MachineSize[];
  ttl: { defaultSeconds: number; maxSeconds: Partial<Record<SandboxPlacementProviderId, number>> };
  providers: LaunchProviderOption[];
  modalRuntime?: {
    defaultPath?: "native" | "runtime";
    version: number;
    enabled: boolean;
    followupVersion?: number;
    idleLaunchVersion?: number;
    emptyResumeVersion?: number;
    idleTemplateVersion?: number;
    resumeVersion?: number;
    mcpVersion?: number;
    skillsVersion?: number;
    variablesVersion?: number;
    usageVersion?: number;
    claudeVersion?: number;
    opencodeVersion?: number;
    opencodeShellProofVersion?: number;
    opencodeMcpProofVersion?: number;
  };
  dockerRuntime?: {
    opencodeMcpProofVersion?: number;
  };
  boatRuntime: {
    defaultPath?: "native" | "runtime";
    version: number;
    diagnosticsVersion: number;
    followupVersion: number;
    checkpointVersion: number;
    resumeVersion: number;
    githubVersion: number;
    mcpVersion: number;
    skillsVersion?: number;
    workspaceVersion?: number;
    controlsVersion?: number;
    opencodeVersion?: number;
    opencodeMcpProofVersion?: number;
    enabled: boolean;
  };
}

/** Why a host reports a failed machine operation, when the person can act on it (#1507). */
export const DOCKER_JOB_FAILURE_REASONS = ["image_unavailable", "snapshot_build_failed", "disk_full"] as const;
export type DockerJobFailureReason = (typeof DOCKER_JOB_FAILURE_REASONS)[number];
/** What a sandbox and its launch say when its host could not fetch the image. */
export const DOCKER_IMAGE_UNAVAILABLE_MESSAGE =
  "Your host could not fetch the image. Check that the image exists and that the host can reach its registry, then launch again.";
/** Public diagnostics for admitted launch preparation; never derive these from command output. */
export const DOCKER_LAUNCH_FAILURE_MESSAGES = {
  disk: DOCKER_DISK_FLOOR_MESSAGE,
  startup: "Docker sandbox startup failed. Check the host and retry with a new request.",
  github:
    "Repository authorization failed. Connect GitHub and grant access to the requested repositories, then launch again.",
  githubNotConnected: GITHUB_CALLER_NOT_CONNECTED,
  githubDelivery:
    "GitHub configureGitHub setup step failed or was not acknowledged by the sandbox runtime. Check that the image includes git, gh and python3, and that the runtime is connected.",
  environment: "Sandbox environment preparation failed. Check variable and secret bindings, then launch again.",
  checkout:
    "Repository checkout failed or timed out. Check the repository branch and GitHub access, then launch again.",
  preparation: "Sandbox skill or MCP preparation failed. Check the launch configuration, then launch again.",
  prompt: "Sandbox first prompt admission failed. Inspect the sandbox and launch again.",
  hostUnavailable:
    "The Docker host became unavailable before this sandbox could start. Launch again on another host or re-register it.",
} as const;

/**
 * Closed set of safe snapshot build diagnostics. The database constraint and every writer share this
 * list so a new reason cannot be persisted by one path and rejected by the schema.
 */
export const DOCKER_SNAPSHOT_FAILURE_MESSAGES = {
  expired: "Snapshot build expired before an image was published.",
  authorization: "Snapshot build authorization is no longer valid.",
  build:
    "Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.",
  retired: "Host retired before snapshot publication.",
  disk: DOCKER_DISK_FLOOR_MESSAGE,
  draining: DOCKER_HOST_DRAINING_MESSAGE,
} as const;

/** Legacy operator/compatibility fixture image. Normal launches use officialSandboxImage(). */
export const DOCKER_DEFAULT_IMAGE =
  "buildpack-deps@sha256:58021c2a0204361b62a23d2e0244d144d74c29af2d678e2a1f7e6611885d6949";

/** Normal API/CLI contract. Discover capabilities.launch before offering this source. */
export interface DockerLaunchRequest {
  secrets?: import("./application-secret-bindings.ts").ApplicationSecretBinding[];
  variables?: import("./readable-variables.ts").ReadableVariableBinding[];
  /** GitHub checkouts, using the same single-segment directory rules as goldens. */
  repos?: import("./golden-config.ts").GoldenRepo[];
  org: string;
  provider: "docker";
  hostId?: string;
  snapshotId?: string;
  harness: Harness;
  /** Omit to resolve the caller's compatible personal default, then freeze its ID/version at admission. */
  credentialId?: string;
  credentialVersion?: number;
  requestId: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  ttlSeconds?: number;
  visibility?: "private";
  skills?: string[];
  connections?: string[];
  skipSkillDefaults?: boolean;
  stopWhenWorkMerged?: boolean;
}
export interface DockerSandboxRecord extends Omit<SandboxRecord, "provider" | "goldenId" | "harness"> {
  provider: "docker";
  goldenId: null;
  snapshotId?: string | null;
  harness: Harness;
  hostId: string;
  image: string;
}
/** Durable server admission before native execution starts. Read status with this stable promptId. */
export interface DockerQueuedPromptReceipt {
  id: string;
  requestId: string;
  promptId: string;
  conversationId: string;
  status: "queued";
}
export interface DockerLaunchResult {
  sandbox: DockerSandboxRecord;
  golden: null;
  helper: null;
  github: GitHubLaunchInfo;
  runtime: { kind: "armada"; epoch: string } | null;
  ttlSeconds: number;
  expiresAt: string;
  conversationId?: string;
  promptId?: string;
}
export interface DockerSandboxStatus {
  pullRequests?: NonNullable<SandboxRecord["pullRequests"]>;
  /** Additive idle-pause wording; canonical status remains stopped. */
  statusMessage?: string | null;
  provider: "docker";
  hostId: string;
  image: string;
  id: string;
  golden: null;
  visibility: "private";
  harness: Harness;
  repositoryDir: string | null;
  machineSize: MachineSizeEvidence | null;
  model: string | null;
  reasoningEffort: string | null;
  status: SandboxRecord["status"];
  statusReason: string | null;
  providerState: string | null;
  conversationIds: string[];
  expiresAt: string | null;
  usage?: SandboxUsage | null;
  prompt: {
    promptId: string;
    conversationId: string | null;
    state: PromptOutcome["state"] | "queued";
    reason: string | null;
  } | null;
  settled: boolean;
}

export const DOCKER_SNAPSHOT_STATUSES = ["building", "ready", "failed"] as const;
export interface DockerSnapshotRecord {
  /** Frozen server release version; null only for snapshots created before version recording. */
  builtOnVersion: string | null;
  /** Absent from older APIs and null when a verified build receipt is unavailable. */
  baselineVersion?: number | null;
  baselineOutdated?: boolean;
  id: string;
  orgId: string;
  ownerId: string;
  name: string;
  provider: "docker";
  visibility: "private" | "org";
  hostId: string;
  installationId: string;
  hostName: string | null;
  hostAvailable: boolean;
  definitionHash: string;
  status: (typeof DOCKER_SNAPSHOT_STATUSES)[number];
  image: string | null;
  /** Safe build diagnostic; absent on older servers. Never contains command output. */
  failureReason?: string | null;
  config: import("./golden-config.ts").GoldenConfig;
  createdAt: string;
}
