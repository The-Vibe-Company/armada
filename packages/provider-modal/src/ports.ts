import type {
  AgentEvent,
  EventPage,
  EventsRequest,
  Harness,
  HarnessCapabilities,
  MachineSize,
  ModalBinding,
  SandboxInfo,
  SnapshotInfo,
} from "@armada/core";
import type { Image, ModalClient, Sandbox } from "modal";

export type McpConfiguration = {
  revision: string;
  servers: Record<
    string,
    | { type: "http"; url: string; headers?: Record<string, string> }
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  >;
};

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
}
export interface ModalManagementProvenance {
  credentialScope: "org" | "user";
  credentialOwnerId: string;
}
export interface ProcessBaseline {
  version: 1;
  physicalId: string;
  generation: number;
  namespace: { pid: string; mount: string };
  processes: { pid: number; start: string }[];
  admissionState?: "pending" | "sealed" | "legacy";
  managedRunnerPid?: number;
}

export interface Machine {
  deletePhysicalExitGeneration?: number;
  commonRuntime?: true;
  runtimeStartAttempted?: true;
  runtimeResumeGeneration?: number;
  runtimeCheckpoint?: { epoch: string; watermark: number; physicalId: string; generation: number };
  info: SandboxInfo;
  generation: number;
  runtimePolicy?: "explicit-vm-v1";
  runtimeEvidence?: { version: 1; runtime: "vm"; physicalId: string; generation: number };
  launchUserId?: string;
  managementAuthority?: ModalManagementProvenance;
  sourceImage?: { scopeKey: string; name: string; imageId: string };
  grantExpiresAt?: number;
  eventBase?: number;
  checkpointWatermark?: number;
  quiesced?: boolean;
  ordinaryStopAttempted?: boolean;
  modelDefaults?: Record<Harness, { model: string; reasoningEffort: string }>;
  harnessCwds?: Partial<Record<Harness, string>>;
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
  snapshotImages?: { name: string; imageId: string }[];
  goldenRestore?: { snapshotId: string; sourceImageId?: string; imageId: string; generation: number };
  freshStatePreparedGeneration?: number;
  golden: boolean;
  ttlSeconds: number;
  size?: MachineSize;
  physicalName: string;
}
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
  goldenClean?: boolean;
  info: SnapshotInfo;
  imageId?: string;
  sourceId: string;
  managementAuthority?: ModalManagementProvenance;
  deleted?: boolean;
  collecting?: boolean;
  collectToken?: string;
  collectUntil?: number;
}
export interface ModalStore {
  reserve(key: string, machine: Machine, runtimeSourceId?: string): Promise<Machine>;
  findByRequestKey(key: string): Promise<Machine | null>;
  get(id: string): Promise<Machine>;
  watermark(id: string, generation: number): Promise<number>;
  list(): Promise<Machine[]>;
  lease<T>(id: string, work: (row: Machine, save: (row: Machine) => Promise<void>) => Promise<T>): Promise<T>;
  image(name: string): Promise<SavedImage>;
  saveImage(image: SavedImage): Promise<void>;
  removeImage(name: string): Promise<void>;
  purgeImage(name: string, sourceId: string, imageId: string): Promise<void>;
  claimImage(name: string, sourceId: string, imageId: string): Promise<void>;
  takeImage(name: string, sourceId: string, imageId: string, token: string): Promise<boolean>;
  releaseImage(name: string, sourceId: string, imageId: string, token: string): Promise<void>;
  images(sourceId: string): Promise<SavedImage[]>;
  tombstoneSources(): Promise<string[]>;
  imageReferenced(imageId: string): Promise<boolean>;
  events(input: EventsRequest): Promise<EventPage>;
  latestPrompt(sandboxId: string, promptId: string): Promise<Extract<AgentEvent, { kind: "prompt" }> | null>;
}
export interface RunnerTransport {
  call<T>(machine: Machine, op: string, input: object): Promise<T>;
}
export interface RunnerDistribution {
  image(client: ModalClient): Promise<Image>;
  readonly capabilities: Readonly<Partial<Record<Harness, HarnessCapabilities>>>;
  prepareFreshMachine?(sandbox: Sandbox, machine: Machine): Promise<void>;
  captureProcessBaseline?(sandbox: Sandbox, machine: Machine): Promise<ProcessBaseline>;
  sealProcessBaseline?(sandbox: Sandbox, machine: Machine, managedRunnerPid: number): Promise<ProcessBaseline>;
  prepareRuntime?(sandbox: Sandbox, machine: Machine): Promise<void>;
  start(sandbox: Sandbox, machine: Machine, env: Readonly<Record<string, string>>): Promise<void>;
  restoreEnv(machine: Machine): Promise<Readonly<Record<string, string>>>;
  prepareSnapshot(sandbox: Sandbox, machine: Machine): Promise<void>;
}
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
