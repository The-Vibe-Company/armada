import type { AgentEvent } from "@armada/core";
import type { RuntimeSessionScope } from "./runtime-enrolment.ts";

const commandPattern = /^workspace_(?:health_[a-f0-9-]{36}_[0-9]+|[0-9]+_(?:repository|init)_[0-9]+_[0-9]+)$/;

export function logWorkspaceCommand(
  { sandboxId, epoch }: RuntimeSessionScope,
  commandId: string,
  stage:
    | "admitted"
    | "admission_replayed"
    | "sent_poll"
    | "sent_socket"
    | "result_acknowledged"
    | "observed"
    | "wait_ended",
  observedAtMs: number,
  timings?: { durationMs?: number; resultReads?: number; resultReadMs?: number },
) {
  if (!commandPattern.test(commandId)) return;
  try {
    console.info(
      JSON.stringify({
        event: "runtime_workspace_command",
        sandboxId,
        epoch,
        commandId,
        stage,
        observedAtMs,
        ...timings,
      }),
    );
  } catch {}
}

export function logWorkspaceExecution(scope: RuntimeSessionScope, event: AgentEvent) {
  if (event.kind !== "other" || event.type !== "armada/workspaceStep") return;
  const match = /^workspace_(workspace_([0-9]+)_(?:repository|init)_[0-9]+_[0-9]+)_(running|finished|failed)$/.exec(
    event.id,
  );
  if (!match || match[2] !== scope.epoch) return;
  try {
    console.info(
      JSON.stringify({
        event: "runtime_workspace_execution",
        sandboxId: scope.sandboxId,
        epoch: scope.epoch,
        commandId: match[1],
        stage: match[3],
        runtimeAtMs: event.at,
      }),
    );
  } catch {}
}
