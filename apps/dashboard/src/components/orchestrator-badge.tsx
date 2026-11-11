import type { OrchestratorState } from "@armada/core";
import { Badge } from "@/components/ui/badge";
import { STATE_LABELS } from "@/lib/orchestrators";
import { cn } from "@/lib/utils";

const TONES: Record<OrchestratorState, string> = {
  creating: "border-warning/40 bg-warning/10 text-warning",
  ready: "border-success/40 bg-success/10 text-success",
  stopping: "border-warning/40 bg-warning/10 text-warning",
  stopped: "text-muted-foreground",
  resuming: "border-warning/40 bg-warning/10 text-warning",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  blocked: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function OrchestratorStateBadge({ state }: { state: OrchestratorState }) {
  return (
    <Badge variant="outline" className={cn(TONES[state])} data-orchestrator-state={state}>
      {STATE_LABELS[state]}
    </Badge>
  );
}
