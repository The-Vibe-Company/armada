import type { Harness } from "./contract.ts";
import type { CredentialKind } from "./database.types.ts";
import type { GitHubLaunchInfo } from "./launch.ts";
import type { MachineSize, MachineSizeEvidence } from "./machine-size.ts";
import type { HarnessModels } from "./models.ts";
import type { PromptOutcome } from "./outcome.ts";
import type { SandboxRecord } from "./sandbox.ts";
import type { SandboxUsage } from "./sandbox-usage.ts";

/** Placement is wider than golden identity: Docker plain images are not goldens. */
export type { SandboxPlacementProviderId } from "./sandbox-provider.ts";

import type { SandboxPlacementProviderId } from "./sandbox-provider.ts";
export interface DockerHostListRequest {
  org: string;
}
export interface DockerHostSummary {
  id: string;
  name: string | null;
  /** Online means a recent heartbeat, not a launch/readiness guarantee. */
  state: "pending" | "online" | "offline" | "revoked";
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** The daemon version the host last reported (#1453); absent or null until a host has reported one. */
  version?: string | null;
  /** Retained sandboxes, including stopped/failed, excluding deleted. */
  sandboxes: number;
}
export interface DockerHostListResponse {
  /** Normal launch is wired and opted in, not merely private preview availability. */
  placement: boolean;
  hosts: DockerHostSummary[];
}
export interface DockerHostRegistrationRequest {
  org: string;
  name?: string;
}
export interface DockerHostRegistrationResponse {
  hostId: string;
  /** Single-use, five-minute capability. Show once, never persist or log it. */
  registrationToken: string;
  /** One-click shell command containing only the short-lived registration capability. */
  command: string;
  expiresAt: string;
}
export interface DockerHostRevokeRequest {
  org: string;
  hostId: string;
}
export interface DockerHostRevokeResponse {
  revoked: true;
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
    version: number;
    enabled: boolean;
    followupVersion?: number;
    resumeVersion?: number;
    mcpVersion?: number;
    skillsVersion?: number;
    variablesVersion?: number;
    usageVersion?: number;
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
    enabled: boolean;
  };
}

/** Why a host reports a failed machine operation, when the person can act on it (#1507). */
export const DOCKER_JOB_FAILURE_REASONS = ["image_unavailable", "snapshot_build_failed"] as const;
export type DockerJobFailureReason = (typeof DOCKER_JOB_FAILURE_REASONS)[number];
/** What a sandbox and its launch say when its host could not fetch the image. */
export const DOCKER_IMAGE_UNAVAILABLE_MESSAGE =
  "Your host could not fetch the image. Check that the image exists and that the host can reach its registry, then launch again.";
/** Public diagnostics for admitted launch preparation; never derive these from command output. */
export const DOCKER_LAUNCH_FAILURE_MESSAGES = {
  startup: "Docker sandbox startup failed. Check the host and retry with a new request.",
  github:
    "Repository authorization failed. Connect GitHub and grant access to the requested repositories, then launch again.",
  githubDelivery:
    "GitHub configureGitHub setup step failed or was not acknowledged by the sandbox runtime. Check that the image includes git, gh and python3, and that the runtime is connected.",
  environment: "Sandbox environment preparation failed. Check variable and secret bindings, then launch again.",
  checkout:
    "Repository checkout failed or timed out. Check the repository branch and GitHub access, then launch again.",
  preparation: "Sandbox skill or MCP preparation failed. Check the launch configuration, then launch again.",
  prompt: "Sandbox first prompt admission failed. Inspect the sandbox and launch again.",
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
}
export interface DockerSandboxRecord extends Omit<SandboxRecord, "provider" | "goldenId" | "harness"> {
  provider: "docker";
  goldenId: null;
  snapshotId?: string | null;
  harness: Harness;
  hostId: string;
  image: string;
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
  /** Additive idle-pause wording; canonical status remains stopped. */
  statusMessage?: string | null;
  provider: "docker";
  hostId: string;
  image: string;
  id: string;
  golden: null;
  visibility: "private";
  harness: Harness;
  repositoryDir: null;
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
    state: PromptOutcome["state"];
    reason: string | null;
  } | null;
  settled: boolean;
}

export const DOCKER_SNAPSHOT_STATUSES = ["building", "ready", "failed"] as const;
export interface DockerSnapshotRecord {
  /** Frozen server release version; null only for snapshots created before version recording. */
  builtOnVersion: string | null;
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
