import type { SandboxStatus } from "@armada/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONES: Record<SandboxStatus, string> = {
  starting: "border-warning/40 bg-warning/10 text-warning",
  ready: "border-success/40 bg-success/10 text-success",
  running: "border-success/40 bg-success/10 text-success",
  stopping: "border-warning/40 bg-warning/10 text-warning",
  stopped: "text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  deleted: "text-muted-foreground line-through",
};

export function StatusBadge({ status }: { status: SandboxStatus }) {
  return (
    <Badge variant="outline" className={cn("capitalize", TONES[status])} data-status={status}>
      {status}
    </Badge>
  );
}
