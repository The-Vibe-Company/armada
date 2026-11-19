import type { HarnessCredentials } from "./credentials.ts";
import type { GoldenActor } from "./golden.ts";
import type { GitHubLaunchInfo, LaunchPlan, LaunchResult } from "./launch.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import type { LaunchStage } from "./launch-stages.ts";
import type { Provider } from "./provider.ts";
import type { SandboxRecord, SandboxStore } from "./sandbox.ts";

interface LaunchStartContext {
  actor: GoldenActor;
  launchId: string;
  record: SandboxRecord;
  providerSandboxId: string;
  signal: AbortSignal;
  progress(stage: LaunchInitializationStage): void;
  runtimeStarted(): void;
  mark(stage: LaunchStage): Promise<void>;
  reportGitHub(github: GitHubLaunchInfo): void;
}

export interface LaunchStrategy {
  kind: "native" | "enrolled";
  forkEnv(plan: LaunchPlan): HarnessCredentials["env"];
  recordFields(
    plan: LaunchPlan,
  ): Pick<Parameters<SandboxStore["insert"]>[0], "boatRuntime" | "runtimeTransport" | "pullRequestSource">;
  initialize(
    plan: LaunchPlan,
    context: LaunchStartContext,
  ): Promise<{ github: GitHubLaunchInfo; prompt: Provider["prompt"]; runtime?: LaunchResult["runtime"] }>;
}

export function requireLaunchHeadroom(record: SandboxRecord): void {
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now())
    throw new LaunchError("invalid_request", "Provider lifetime has no remaining preservation headroom.");
}
