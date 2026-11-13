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

/**
 * The plain Linux image a Docker host launch uses when none is given (#1507): Debian with HTTPS CA roots, pinned by
 * digest. The launch API, the CLI and the dashboard all default to it, so a person never has to know what an image is.
 */
export const DOCKER_DEFAULT_IMAGE =
  "buildpack-deps@sha256:58021c2a0204361b62a23d2e0244d144d74c29af2d678e2a1f7e6611885d6949";

/** Normal API/CLI contract. Discover capabilities.launch before offering this source. */
export interface DockerLaunchRequest {
  /** GitHub checkouts, using the same single-segment directory rules as goldens. */
  repos?: import("./golden-config.ts").GoldenRepo[];
  org: string;
  provider: "docker";
  hostId?: string;
  snapshotId?: string;
  /** Immutable registry digest or host-approved full local image ID; omitted means DOCKER_DEFAULT_IMAGE. */
  image?: string;
  harness: Harness;
  credentialId: string;
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
  runtime: { kind: "armada"; epoch: string };
  ttlSeconds: number;
  expiresAt: string;
  conversationId?: string;
  promptId?: string;
}
export interface DockerSandboxStatus {
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
  status: (typeof DOCKER_SNAPSHOT_STATUSES)[number];
  image: string | null;
  config: import("./golden-config.ts").GoldenConfig;
  createdAt: string;
}
