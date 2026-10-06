import {
  ArmadaApiError,
  type ArmadaConfig,
  BriefError,
  type DeferredLaunch,
  type Fleet,
  type MergeOutcome,
  RuntimeError,
} from "@armada/core";
import { UsageError } from "./io.ts";
import { redactRuntimeText } from "./runtimes/adapter.ts";

export interface DeferredLaunchResult {
  ticket: string;
  request: number;
  status: "launched" | "manual" | "failed";
  command: string;
  output?: string;
}

/** A confirmed merge stays successful even if a requested follow-on launch fails. */
export async function launchDeferredAfterMerge(
  outcome: MergeOutcome,
  config: ArmadaConfig,
  fleet: Fleet | null,
  launch: (request: DeferredLaunch) => Promise<string>,
): Promise<DeferredLaunchResult[]> {
  if (!outcome.merged || !outcome.ticket || !outcome.unblocked?.ready.length || !fleet) return [];
  let requests: DeferredLaunch[];
  try {
    requests = await fleet.deferredLaunches();
  } catch {
    outcome.warnings.push(
      "could not read deferred launch requests; run armada status to check what the merge unblocked",
    );
    return [];
  }
  const results: DeferredLaunchResult[] = [];
  for (const ticket of outcome.unblocked.ready) {
    // A stored reading is mandatory; fresh post-close readiness can supersede its old blockers.
    const request = requests.find(
      (r) =>
        r.ticket === ticket.id &&
        r.owned &&
        r.blockers !== null &&
        (r.reason === null || r.reason.startsWith("waits on ")),
    );
    if (!request) continue;
    const profile = request.profile ? config.conductor.profiles[request.profile] : null;
    if (!ticket.readyForAgent || profile?.runtime === "claude-code") {
      results.push({
        ticket: request.ticket,
        request: request.id,
        status: "manual",
        command:
          profile?.runtime === "claude-code"
            ? `${request.command.replace(/^armada launch /, "armada brief ")} --prompt`
            : request.command,
      });
      continue;
    }
    try {
      const output = await launch(request);
      results.push({
        ticket: request.ticket,
        request: request.id,
        status: "launched",
        command: request.command,
        output,
      });
    } catch (error) {
      const reason =
        error instanceof UsageError ||
        error instanceof RuntimeError ||
        error instanceof BriefError ||
        error instanceof ArmadaApiError
          ? redactRuntimeText(error.message)
          : "the launcher could not complete; inspect the pending launch before retrying";
      outcome.warnings.push(
        `${request.ticket} was not launched: ${reason}. Request #${request.id} stays pending; ${request.command}`,
      );
      results.push({ ticket: request.ticket, request: request.id, status: "failed", command: request.command });
    }
  }
  return results;
}
