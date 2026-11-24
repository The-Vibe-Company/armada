import type { HarnessCredentials } from "./credentials.ts";
import type { GoldenActor } from "./golden.ts";
import type { GitHubLaunchInfo, LaunchPlan, LaunchResult } from "./launch.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import type { LaunchStage } from "./launch-stages.ts";
import type { SandboxRecord, SandboxStore } from "./sandbox.ts";

interface LaunchStartContext {
  actor: GoldenActor;
  record: SandboxRecord;
  signal: AbortSignal;
  progress(stage: LaunchInitializationStage): void;
  runtimeStarted(): void;
  runtimeEnrolled(epoch: string): void;
  mark(stage: LaunchStage): Promise<void>;
  reportGitHub(github: GitHubLaunchInfo): void;
}

export interface LaunchStrategy {
  forkEnv(plan: LaunchPlan): HarnessCredentials["env"];
  recordFields(
    plan: LaunchPlan,
  ): Pick<Parameters<SandboxStore["insert"]>[0], "boatRuntime" | "modalTransport" | "pullRequestSource">;
  initialize(
    plan: LaunchPlan,
    context: LaunchStartContext,
  ): Promise<{
    github: GitHubLaunchInfo;
    prompt: (request: import("./provider.ts").PromptRequest) => Promise<import("./provider.ts").PromptReceipt>;
    runtime?: LaunchResult["runtime"];
  }>;
}

export function requireLaunchHeadroom(record: SandboxRecord): void {
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now())
    throw new LaunchError("invalid_request", "Provider lifetime has no remaining preservation headroom.");
}
