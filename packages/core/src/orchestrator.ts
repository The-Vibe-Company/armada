import type { Harness } from "./contract.ts";
import type { MachineSize } from "./machine-size.ts";
import type { AgentEvent } from "./provider.ts";
import type { SandboxProviderId } from "./sandbox-provider.ts";

/** Proposed v1 wire contract. No routes or authorization are enabled by this module. */
export const ORCHESTRATOR_CONTRACT_VERSION = 1 as const;
export const ORCHESTRATOR_DEFAULTS = {
  idleSeconds: 7200,
  minIdleSeconds: 900,
  maxIdleSeconds: 86400,
  maxActiveChildren: 3,
  delegationSeconds: 86400,
  waitLeaseSeconds: 900,
  maxWaitSeconds: 86400,
} as const;

export type OrchestratorState = "creating" | "ready" | "stopping" | "stopped" | "resuming" | "blocked";
export type OrchestratorContinuity = "not_started" | "native" | "unverified" | "lost";
export type OrchestratorScope = "worker:launch" | "worker:read" | "worker:message" | "worker:stop" | "worker:extend";

/** All dates are UTC ISO-8601 strings, all IDs are opaque Armada IDs, never provider secrets. */
export interface OrchestratorCreate {
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  orgId: string;
  name: string;
  goldenId: string;
  provider: SandboxProviderId;
  harness: Harness;
  repo?: string;
  /** Public Skillpack catalog reference, pinned as org/slug@version. */
  skill?: string;
  /** Optional override; absent still uses the selected repository/golden policy. */
  size?: MachineSize;
  model: string;
  reasoningEffort?: string;
  /** Opaque authorized model-account reference; not a credential or MCP connection ID. */
  modelAccountId: string;
  idleSeconds?: number;
  maxActiveChildren?: number;
}

export interface Orchestrator {
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  id: string;
  ownerId: string;
  configuration: OrchestratorCreate;
  state: OrchestratorState;
  /** CAS revision for orchestrator operations, distinct from sandbox lifecycle_generation. */
  revision: number;
  sandboxId: string | null;
  conversationId: string | null;
  continuity: OrchestratorContinuity;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleDeadline: string | null;
  /** Legacy installer revision metadata; 40 zeroes means none. Does not select a skill. */
  skillRevision: string;
  skillReceipt?: OrchestratorSkillReceipt | null;
  blockedReason: string | null;
}

/** Required on message/steer/stop/resume and wait mutations; create uses only Idempotency-Key. */
export interface OrchestratorFence {
  expectedRevision: number;
}
export interface OrchestratorMessage extends OrchestratorFence {
  text: string;
}
export interface OrchestratorOperation {
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  id: string;
  orchestratorId: string;
  kind: "create" | "message" | "steer" | "stop" | "resume";
  state: "pending" | "succeeded" | "failed" | "uncertain";
  revision: number;
  /** Safe stable code, never a raw SDK exception. */
  errorCode: string | null;
}
export interface OrchestratorWait extends OrchestratorFence {
  kind: "ci" | "child" | "external" | "task";
  /** Same-org child or server-validated external/task reference; never arbitrary polling URLs. */
  reference: string;
  reason: string;
  expiresAt: string;
}
export interface OrchestratorWaitLease {
  id: string;
  orchestratorId: string;
  kind: OrchestratorWait["kind"];
  reference: string;
  reason: string;
  expiresAt: string;
  /** Absolute cap across renewals. */
  deadline: string;
}
export interface OrchestratorDelegation {
  id: string;
  orchestratorId: string;
  ownerId: string;
  orgId: string;
  scopes: OrchestratorScope[];
  expiresAt: string;
  revokedAt: string | null;
  /** Only children launched by this orchestrator, not all owner/org sandboxes. */
  childPolicy: "owned_children";
}
export type OrchestratorEvent = {
  id: string;
  orchestratorId: string;
  at: string;
  revision: number;
} & (
  | { kind: "agent"; event: AgentEvent }
  | { kind: "state"; state: OrchestratorState; continuity: OrchestratorContinuity }
  | { kind: "operation"; operation: OrchestratorOperation }
  | { kind: "wait"; lease: OrchestratorWaitLease; status: "active" | "released" | "expired" }
  | { kind: "child"; sandboxId: string; operationId: string }
);
export interface OrchestratorEventPage {
  olderCursor?: string;
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  events: OrchestratorEvent[];
  cursor: string | null;
  hasMore: boolean;
}
export interface OrchestratorList {
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  items: Orchestrator[];
  cursor: string | null;
}
export interface OrchestratorDetail {
  version: typeof ORCHESTRATOR_CONTRACT_VERSION;
  orchestrator: Orchestrator;
  operations: OrchestratorOperation[];
  waits: OrchestratorWaitLease[];
  delegation: OrchestratorDelegation | null;
  childSandboxIds: string[];
}

export interface OrchestratorSkillReceipt {
  reference: string;
  version: string;
  skillId: string;
  checksum: string;
  origin: string;
}

/** Only anonymous catalog references are supported in the first slice. */
export const ORCHESTRATOR_SKILL_PATTERN =
  /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;
