// PROTOCOL_VERSION = 1
import type { AgentEvent, ExecRequest, Harness, OutputChunkRequest, PromptRequest, PromptStatus } from "@armada/core";
import type { GitHubBrokerConfiguration } from "./github-broker.ts";
import type { ModelConnectionTestResult } from "./model-connection-test.ts";
export declare const MAX_COMMAND_RESPONSE_BYTES = 1048576;
export declare const PROTOCOL_VERSION = 1;
export declare const AUTH_HEADER = "x-armada-runner-grant";
export type McpConnection = {
    type: "http";
    url: string;
    headers?: Record<string, string>;
} | {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
};
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
export interface OrchestratorEpochBinding {
    epoch: string;
    physicalGeneration: string;
}
interface InstallOrchestratorEpochRequest {
    op: "installOrchestratorEpoch";
    token: string;
    binding: OrchestratorEpochBinding;
    url: string;
}
interface ScrubOrchestratorEpochRequest {
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
export type DriverEvent = Omit<Extract<AgentEvent, {
    kind: "message";
}>, "id" | "at" | "conversationId" | "promptId"> | {
    kind: "other";
    type: string;
    data: unknown;
    rawDiagnostic?: true;
};
export interface RuntimePromptRequest extends PromptRequest {
    cwd?: string;
}
export interface ExecEnvironment {
    GH_TOKEN?: string;
    GITHUB_TOKEN?: string;
    HOME?: string;
    PATH?: string;
    GIT_CONFIG_GLOBAL?: string;
    GIT_TERMINAL_PROMPT?: "0";
}
export interface RunnerExecutionOptions {
    workspaceHost?: import("./workspace-exec.ts").WorkspaceExecutionHost;
    prepareWorkspace?: () => Promise<void>;
    reportHarnessFailure?: (stage: import("../../core/src/runtime-startup-failure.ts").RuntimeHarnessFailureStage, error: unknown, requestId: string, reason?: string) => void;
    restoredFrom?: {
        epoch: string;
        watermark: number;
        conversationId: string | null;
    };
    testModelConnection?: (harness: "claude" | "codex" | "opencode", model: string, signal: AbortSignal) => Promise<ModelConnectionTestResult>;
    configureGitHub?: (configuration: GitHubBrokerConfiguration | null) => Promise<void>;
    refreshNativeSecrets?: () => void;
    exclusiveNativeAuth?: boolean;
    publishNativeAuth?: () => Promise<void>;
    execEnv?: ExecEnvironment;
    readableVariables?: Record<string, string>;
    credentialFreeBuilder?: boolean;
    ghConfigDir?: string;
    githubToolsRoot?: string;
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
export type DriverResumeContext = Omit<DriverContext, "request" | "session" | "emit" | "sessionId"> & {
    request: Omit<RuntimePromptRequest, "text">;
    sessionId: string;
};
export interface Driver {
    configureReadableVariables?(variables: Record<string, string>): void;
    resumeSession?(context: DriverResumeContext): Promise<{
        sessionId: string;
    }>;
    start(context: DriverContext): Turn;
    close(): Promise<void>;
}
export interface IngestClient {
    append(batch: {
        sandboxId: string;
        generation: string;
        events: {
            sequence: number;
            event: AgentEvent;
        }[];
    }): Promise<{
        acknowledgedSequence: number;
    }>;
}
export type RunnerRequest = {
    version: 1;
    requestId: string;
    sandboxId: string;
} & ({
    op: "health";
} | {
    op: "testModelConnection";
    harness: "claude" | "codex" | "opencode";
    model: string;
} | {
    op: "observeOrchestrator";
    conversationId?: string;
} | {
    op: "resumeNativeSession";
    conversationId: string;
    expectedSessionId: string;
    input: Omit<RuntimePromptRequest, "text">;
} | {
    op: "configureReadableVariables";
    harness: Harness;
    variables: Record<string, string>;
    secretKeys?: string[];
} | {
    op: "workspaceExec";
    input: import("./workspace-exec.ts").WorkspaceExec;
} | {
    op: "installSkills";
    input: import("./skills.ts").SkillInstallInput;
} | {
    op: "configureGitHub";
    configuration: GitHubBrokerConfiguration | null;
} | {
    op: "resourceObservation";
} | {
    op: "readOutputs";
    part?: OutputChunkRequest | null;
} | ConfigureMcpRequest | InstallOrchestratorEpochRequest | ScrubOrchestratorEpochRequest | {
    op: "prompt";
    input: RuntimePromptRequest;
} | {
    op: "getPrompt";
    promptId: string;
} | {
    op: "steer";
    conversationId: string;
    text: string;
} | {
    op: "interrupt";
    conversationId?: string;
} | {
    op: "events";
    cursor?: string;
    limit?: number;
    conversationId?: string;
} | {
    op: "exec";
    input: ExecRequest;
} | {
    op: "getExec";
    processId: number;
} | {
    op: "checkpoint";
});
export interface StoredPrompt {
    promptId: string;
    conversationId: string;
    status: PromptStatus;
    request: RuntimePromptRequest;
}
export {};
