import { redact } from "./credentials.ts";
import { delay, type GoldenRecord } from "./golden.ts";
import {
  initCommand,
  pullCommand,
  REPOSITORY_FETCH_FAILED_EXIT,
  REPOSITORY_FETCH_FAILED_MARKER,
  type ShellCommand,
} from "./golden-config.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import type { Provider } from "./provider.ts";

const OUTPUT_LIMIT = 2000;
const OWNERSHIP_RETRY_DELAY_MS = 1000;

export async function prepareLaunchWorkspace(
  provider: Pick<Provider, "id" | "exec">,
  sandboxId: string,
  armadaSandboxId: string,
  golden: Pick<GoldenRecord, "config">,
  secrets: readonly string[],
  progress: (stage: LaunchInitializationStage) => void,
  sleep: (ms: number) => Promise<void> = delay,
  transport?: (
    request: Parameters<Provider["exec"]>[0],
    step: { phase: "repository" | "init"; index: number; attempt: number },
  ) => ReturnType<Provider["exec"]>,
  trackPushes = false,
): Promise<string[]> {
  const runner = (phase: "repository" | "init", index: number) => {
    let attempt = 0;
    return transport
      ? {
          id: provider.id,
          exec: (request: Parameters<Provider["exec"]>[0]) => transport(request, { phase, index, attempt: attempt++ }),
        }
      : provider;
  };
  const warnings: string[] = [];
  for (const [index, repo] of golden.config.repos.entries()) {
    progress("initialization_repository");
    const warning = await run(
      runner("repository", index),
      sandboxId,
      pullCommand(repo, trackPushes),
      `git pull of ${repo.dir}`,
      secrets,
      {
        dir: repo.dir,
        sandboxId: armadaSandboxId,
        sleep,
      },
    );
    if (warning) warnings.push(warning);
  }
  for (const [index, command] of golden.config.init.entries()) {
    progress("initialization_commands");
    await run(runner("init", index), sandboxId, initCommand(command), `init command ${index + 1}`, secrets);
  }
  return warnings;
}

function isFetchFailure(result: Awaited<ReturnType<Provider["exec"]>>): boolean {
  return (
    !result.detached &&
    result.exitCode === REPOSITORY_FETCH_FAILED_EXIT &&
    result.stderr.split(/\r?\n/).includes(REPOSITORY_FETCH_FAILED_MARKER)
  );
}

async function run(
  provider: Pick<Provider, "id" | "exec">,
  sandboxId: string,
  spec: ShellCommand,
  label: string,
  secrets: readonly string[],
  repository?: { dir: string; sandboxId: string; sleep: (ms: number) => Promise<void> },
): Promise<string | void> {
  const request = {
    sandboxId,
    command: spec.command,
    cwd: spec.cwd,
    timeoutSeconds: spec.timeoutSeconds,
  };
  let result = await provider.exec(request);
  // Production has shown intermittent refusals with either selector path. Retry only
  // a completed Git ownership rejection once; keep the same user and ownership guard.
  if (
    repository !== undefined &&
    !result.detached &&
    !result.timedOut &&
    (result.exitCode === 128 || isFetchFailure(result)) &&
    result.stderr.includes("detected dubious ownership in repository")
  ) {
    await repository.sleep(OWNERSHIP_RETRY_DELAY_MS);
    let retry: "ownership_refused" | "exit_nonzero" | "timed_out" | "detached" | "exec_threw" | "succeeded" =
      "exec_threw";
    try {
      result = await provider.exec(request);
      if (result.detached) retry = "detached";
      else if (result.timedOut) retry = "timed_out";
      else if (result.exitCode === 0) retry = "succeeded";
      else if (
        (result.exitCode === 128 || isFetchFailure(result)) &&
        result.stderr.includes("detected dubious ownership in repository")
      )
        retry = "ownership_refused";
      else retry = "exit_nonzero";
    } finally {
      try {
        console.error(
          JSON.stringify({
            event: "launch_repository_ownership_retry",
            sandboxId: repository.sandboxId,
            provider: provider.id,
            providerSandboxId: sandboxId,
            attempt: 2,
            delayMs: OWNERSHIP_RETRY_DELAY_MS,
            outcome: retry === "succeeded" ? "recovered" : "failed",
            retry,
          }),
        );
      } catch {
        // Best-effort diagnostics must not change launch or cleanup outcomes.
      }
    }
  }
  if (result.detached) throw new LaunchError("init_failed", `${label} started in the background.`);
  if (result.timedOut) {
    throw new LaunchError(
      "init_failed",
      `${label} timed out.${launchCommandOutput(result.stderr, result.stdout, secrets)}`,
    );
  }
  if (result.exitCode !== 0 && repository !== undefined) {
    // Match only fixed Git diagnostic classes. Never publish arbitrary stderr or credentials.
    if (
      /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Repository not found|repository .* not found|returned error: (?:401|403)/i.test(
        result.stderr,
      )
    )
      throw new LaunchError(
        "no_credentials",
        `Repository ${repository.dir} needs a GitHub connection with read access. Run armada github connect, grant your account and the Armada GitHub App access, then launch again.`,
      );
    if (
      isFetchFailure(result) &&
      /Could not resolve host|Failed to connect|Could not resolve proxy|Connection (?:timed out|reset)|RPC failed|early EOF|index-pack failed|returned error: (?:408|429|500|502|503|504)/i.test(
        result.stderr,
      )
    )
      return `Warning: repository ${repository.dir} could not refresh because the Git transfer failed; launching with its snapshot checkout. Retry refresh when the network is healthy.`;
  }
  if (result.exitCode !== 0) {
    const failure = new LaunchError(
      "init_failed",
      `${label} failed (exit ${result.exitCode}).${launchCommandOutput(result.stderr, result.stdout, secrets)}`,
    );
    // Inspect stderr before diagnostic-tail truncation; never bypass Git's ownership guard.
    if (repository !== undefined && result.stderr.includes("detected dubious ownership in repository"))
      throw new LaunchError(
        "init_failed",
        `Cannot update repository '${repository.dir}' in sandbox ${repository.sandboxId}: checkout ownership does not match the user running sandbox commands. Report this golden and sandbox ID to its administrator to check command-user and checkout UIDs before retrying.`,
        { cause: failure, safeReason: "repository_ownership_mismatch" },
      );
    throw failure;
  }
}

export function launchCommandOutput(stderr: string, stdout: string, secrets: readonly string[]): string {
  const text = redact([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"), secrets).trim();
  if (text === "") return "";
  const tail = text.length <= OUTPUT_LIMIT ? text : `...${text.slice(-OUTPUT_LIMIT)}`;
  return `\n${tail}`;
}
