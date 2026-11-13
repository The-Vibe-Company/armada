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
  /** No host naming write exists yet. */
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
}
export interface DockerHostRegistrationResponse {
  hostId: string;
  /** Single-use, five-minute capability. Show once, never persist or log it. */
  registrationToken: string;
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
    controlsVersion?: number;
    enabled: boolean;
  };
}

/** Normal API/CLI contract. Discover capabilities.launch before offering this source. */
export interface DockerLaunchRequest {
  org: string;
  provider: "docker";
  hostId: string;
  image: string;
  harness: Harness;
  credentialId: string;
  credentialVersion?: number;
  requestId: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  ttlSeconds?: number;
  visibility?: "private";
}
export interface DockerSandboxRecord extends Omit<SandboxRecord, "provider" | "goldenId" | "harness"> {
  provider: "docker";
  goldenId: null;
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
