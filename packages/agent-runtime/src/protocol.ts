import type { AgentEvent, ExecRequest, PromptRequest, PromptStatus } from "@armada/core";
export const PROTOCOL_VERSION = 1;
export const AUTH_HEADER = "x-armada-runner-grant";
export type McpConnection =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };
/** Values are transient. Persist only revision; server owns refresh and grants. */
export interface McpConfiguration {
  revision: string;
  servers: Record<string, McpConnection>;
}
export interface ConfigureMcpRequest {
  op: "configureMcp";
  configuration: McpConfiguration;
}
export interface ConfigureMcpResult {
  revision: string;
}
/** Trusted private control only; never a model tool or a public owner DTO. */
export interface OrchestratorEpochBinding {
  epoch: string;
  physicalGeneration: string;
}
export interface InstallOrchestratorEpochRequest {
  op: "installOrchestratorEpoch";
  token: string;
  binding: OrchestratorEpochBinding;
  url: string;
}
export interface ScrubOrchestratorEpochRequest {
  op: "scrubOrchestratorEpoch";
  tokenHash?: string;
}
export interface Grant {
  token: string;
  sandboxId: string;
  generation: string;
  expiresAt: number;
}
export type CheckpointIdentity = Pick<Grant, "sandboxId" | "generation">;
export type DriverEvent =
  | Omit<Extract<AgentEvent, { kind: "message" }>, "id" | "at" | "conversationId" | "promptId">
  | { kind: "other"; type: string; data: unknown };
export interface RuntimePromptRequest extends PromptRequest {
  /** Private native cwd supplied by the provider after server-side repository validation. */
  cwd?: string;
}
/** Trusted private bootstrap only, not a Provider.exec or runner HTTP request field. */
export interface ExecEnvironment {
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  HOME?: string;
  PATH?: string;
  GIT_CONFIG_GLOBAL?: string;
  GIT_TERMINAL_PROMPT?: "0";
}
export interface RunnerExecutionOptions {
  execEnv?: ExecEnvironment;
  credentialFreeBuilder?: boolean;
  ghConfigDir?: string;
}
export interface DriverContext {
  request: RuntimePromptRequest;
  sessionId?: string;
  signal: AbortSignal;
  emit(event: DriverEvent): void;
  session(id: string): void;
  mcp?: McpConfiguration;
}
export interface Turn {
  done: Promise<"finished" | "interrupted">;
  interrupt(): Promise<void>;
  steer(text: string): Promise<void>;
}
/** Native handshake only; there is deliberately no user text in this input. */
export type DriverResumeContext = Omit<DriverContext, "request" | "session" | "emit" | "sessionId"> & {
  request: Omit<RuntimePromptRequest, "text">;
  sessionId: string;
};
export interface Driver {
  /** Optional only when the native SDK can verify an existing session without a turn. */
  resumeSession?(context: DriverResumeContext): Promise<{ sessionId: string }>;
  start(context: DriverContext): Turn;
  close(): Promise<void>;
}
export interface IngestClient {
  append(batch: {
    sandboxId: string;
    generation: string;
    events: { sequence: number; event: AgentEvent }[];
  }): Promise<{ acknowledgedSequence: number }>;
}
export type RunnerRequest = { version: 1; requestId: string; sandboxId: string } & (
  | { op: "health" }
  | { op: "observeOrchestrator"; conversationId?: string }
  | {
      op: "resumeNativeSession";
      conversationId: string;
      expectedSessionId: string;
      input: Omit<RuntimePromptRequest, "text">;
    }
  | { op: "resourceObservation" }
  | ConfigureMcpRequest
  | InstallOrchestratorEpochRequest
  | ScrubOrchestratorEpochRequest
  | { op: "prompt"; input: RuntimePromptRequest }
  | { op: "getPrompt"; promptId: string }
  | { op: "steer"; conversationId: string; text: string }
  | { op: "interrupt"; conversationId?: string }
  | { op: "events"; cursor?: string; limit?: number; conversationId?: string }
  | { op: "exec"; input: ExecRequest }
  | { op: "getExec"; processId: number }
  | { op: "checkpoint" }
);
export interface StoredPrompt {
  promptId: string;
  conversationId: string;
  status: PromptStatus;
  request: RuntimePromptRequest;
}
