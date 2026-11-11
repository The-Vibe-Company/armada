import type {
  AgentEvent,
  EventPage,
  EventsRequest,
  HarnessCapabilities,
  MachineSize,
  ModalBinding,
  SandboxInfo,
  SnapshotInfo,
} from "@armada/core";
import type { Image, ModalClient, Sandbox } from "modal";

/** Structural protocol1 type until the shared core optional configureMcp method is merged. */
export type McpConfiguration = {
  revision: string;
  servers: Record<
    string,
    | { type: "http"; url: string; headers?: Record<string, string> }
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  >;
};

/** Structural private protocol1 exec allowlist; validated again by the bundled runtime. */
export interface ExecEnvironment {
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  HOME?: string;
  PATH?: string;
  GIT_CONFIG_GLOBAL?: string;
  GIT_TERMINAL_PROMPT?: "0";
}
export interface Scope {
  orgId: string;
  userId: string;
  visibility: "org" | "private";
  binding: ModalBinding;
  /** Trusted server-only restriction; never part of a runner claim or scope key. */
  cleanup?: import("@armada/core").OrchestratorCleanupScope;
}
/** Trusted source-connection provenance, independent of resource access visibility. No tokens. */
export interface ModalManagementProvenance {
  credentialScope: "org" | "user";
  credentialOwnerId: string;
}
/** Captured through the authenticated SDK before user work, scoped to one physical incarnation. */
export interface ProcessBaseline {
  version: 1;
  physicalId: string;
  generation: number;
  namespace: { pid: string; mount: string };
  processes: { pid: number; start: string }[];
  admissionState?: "pending" | "sealed" | "legacy";
  managedRunnerPid?: number;
}

import type { ModalOrchestratorCheckpointRecord } from "./orchestrator-checkpoint.ts";

export interface Machine {
  orchestratorCheckpoint?: ModalOrchestratorCheckpointRecord;
  orchestratorCreateRecovery?: {
    request: import("@armada/core").OrchestratorCreateRecoveryRequest;
    binding: Omit<import("@armada/core").OrchestratorCreateRecoveryProof, "state">;
    state: "dispatched" | "terminated";
  };
  info: SandboxInfo;
  generation: number;
  /** Assigned only when reserving a NEW managed launch; legacy/unknown rows stay unknown. */
  runtimePolicy?: "explicit-vm-v1";
  /** Confirmed successful named create, bound to one physical incarnation. */
  runtimeEvidence?: { version: 1; runtime: "vm"; physicalId: string; generation: number };
  launchUserId?: string;
  managementAuthority?: ModalManagementProvenance;
  sourceImage?: { scopeKey: string; name: string; imageId: string };
  grantExpiresAt?: number;
  eventBase?: number;
  checkpointWatermark?: number;
  quiesced?: boolean;
  ordinaryStopAttempted?: boolean;
  modelDefaults?: Record<"claude" | "codex", { model: string; reasoningEffort: string }>;
  /** Trusted, nonsensitive POSIX paths only; never a wrapper command or harness auth state. */
  harnessCwds?: Partial<Record<"claude" | "codex", string>>;
  phase:
    | "reserved"
    | "restoring"
    | "creating"
    | "booting"
    | "active"
    | "checkpoint"
    | "snapshot"
    | "terminate"
    | "stopped"
    | "deleting"
    | "deleted";
  physicalId?: string;
  processBaseline?: ProcessBaseline;
  imageId?: string;
  recoveryImageId?: string;
  retainedRecoveryIds?: string[];
  /** Observed named Image IDs retained for failure recovery/audit, not automatic deletion. */
  snapshotImages?: { name: string; imageId: string }[];
  goldenRestore?: { snapshotId: string; sourceImageId?: string; imageId: string; generation: number };
  /** Durable before first bootstrap: never purge managed state again on a same-generation retry. */
  freshStatePreparedGeneration?: number;
  golden: boolean;
  ttlSeconds: number;
  /** Immutable explicit resource selection, retained across physical restorations. Undefined preserves legacy defaults. */
  size?: MachineSize;
  physicalName: string;
}
/** Server/owner-only provenance receipt. No labels, prompts, config, auth or raw SDK errors. */
export interface ModalResourceReceipt {
  sandboxId: string;
  phase: Machine["phase"];
  observedPhase: Machine["phase"];
  registryConfirmed: boolean;
  generation: number;
  physicalName: string;
  physicalId?: string;
  imageId?: string;
  recoveryImageIds: string[];
  snapshotImages: { name: string; imageId: string }[];
  sourceImage?: Machine["sourceImage"];
  managementAuthority?: ModalManagementProvenance;
  binding: Scope["binding"];
  appName: string;
}
export interface SavedImage {
  /** Only set after owned golden checkpoint, writer shutdown and complete managed-history cleanup. */
  goldenClean?: boolean;
  info: SnapshotInfo;
  imageId?: string;
  sourceId: string;
  managementAuthority?: ModalManagementProvenance;
  deleted?: boolean;
}
/** Store instances are bound to the authenticated caller AND immutable Modal binding. No unscoped lookup. */
export interface ModalStore {
  reserve(key: string, machine: Machine): Promise<Machine>;
  findByRequestKey(key: string): Promise<Machine | null>;
  get(id: string): Promise<Machine>;
  watermark(id: string, generation: number): Promise<number>;
  list(): Promise<Machine[]>;
  /** Atomic, expiring lease; concurrent controllers fail closed. */
  lease<T>(id: string, work: (row: Machine, save: (row: Machine) => Promise<void>) => Promise<T>): Promise<T>;
  image(name: string): Promise<SavedImage>;
  saveImage(image: SavedImage): Promise<void>;
  removeImage(name: string): Promise<void>;
  purgeImage(name: string): Promise<void>;
  images(sourceId: string): Promise<SavedImage[]>;
  /** Server-only boolean: checks references across target visibility scopes without exposing rows. */
  imageReferenced(imageId: string): Promise<boolean>;
  events(input: EventsRequest): Promise<EventPage>;
  /** Latest ingested transition of a turn, without replaying its transcript. */
  latestPrompt(sandboxId: string, promptId: string): Promise<Extract<AgentEvent, { kind: "prompt" }> | null>;
}
export interface RunnerGrant {
  token: string;
  expiresAt: number;
  ingestUrl: string;
}
export interface RunnerTransport {
  /** Must validate version/requestId and translate structured runtime errors to ProviderError. */
  call<T>(machine: Machine, op: string, input: object): Promise<T>;
}
export interface RunnerDistribution {
  /** Credential-free, reproducibly built tools + dist/main.js. Must not include auth, sessions or SSH host keys. */
  image(client: ModalClient): Promise<Image>;
  readonly capabilities: Readonly<Record<"claude" | "codex", HarnessCapabilities>>;
  /** Starts runner with PRIVATE stdin bootstrap, explicit allowlisted model env, fresh expiring grants.
   * Re-resolve credentials on restore; never persist env/bootstrap in registry or Image layers. */
  /** Freshly allocated golden master or NEW logical fork only, before first bootstrap. Purge inherited
   * managed history after proving no open writer; NEVER for ordinary working recovery generations. */
  prepareFreshMachine?(sandbox: Sandbox, machine: Machine): Promise<void>;
  /** Mandatory for privileged build images: capture before first user/runner/init work. */
  captureProcessBaseline?(sandbox: Sandbox, machine: Machine): Promise<ProcessBaseline>;
  /** Seal exact trusted controls after bootstrap health, before the first user admission. */
  sealProcessBaseline?(sandbox: Sandbox, machine: Machine, managedRunnerPid: number): Promise<ProcessBaseline>;
  /** Install only the trusted current public runtime on eligible fresh machines,
   * before capturing the control-process baseline. Never touches native history. */
  prepareRuntime?(sandbox: Sandbox, machine: Machine): Promise<void>;
  start(sandbox: Sandbox, machine: Machine, env: Readonly<Record<string, string>>): Promise<void>;
  restoreEnv(machine: Machine): Promise<Readonly<Record<string, string>>>;
  /** After verified checkpoint ACK: quiesce ALL writers/SSH and remove transient keys/auth.
   * Golden saves must remove managed journal/request/process/native history only after file handles
   * are closed; ordinary recovery MUST preserve sanitized native sessions. Owned composition uses
   * prepareFilesystemSnapshot with kernel FD checks. No unlink of a live SQLite database. */
  prepareSnapshot(sandbox: Sandbox, machine: Machine): Promise<void>;
}
/** #505 owns the eventual Provider.sshKey API. This port prepares an authorized ephemeral key + pinned
 * host key transport without sharing management credentials. Never called while building image layers. */
export interface SshPreparation {
  prepare(
    sandbox: Sandbox,
    machine: Machine,
    publicKey: string,
  ): Promise<{ endpoint: string; hostPublicKey: string; username: "user" | "root" }>;
}
export interface IngestGrantClaims {
  sandboxId: string;
  generation: string;
  expiresAt: number;
}
export interface IngestPayload {
  sandboxId: string;
  generation: string;
  sequence: number;
  event: AgentEvent;
}
