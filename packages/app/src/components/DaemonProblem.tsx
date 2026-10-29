import { APP_TOO_OLD, DAEMON_TOO_OLD } from "@armada/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LOG_BEHIND, NOT_FOLDED } from "@/protocol/client";
import { useDaemon } from "@/protocol/store";

/** What went wrong with the daemon, on every screen, with Reload where reloading helps; nothing when all is well. */
export function DaemonProblem({ onReload, className }: { onReload: () => void; className?: string }) {
  const { problem, status } = useDaemon();
  if (!problem) return null;
  // Reloading helps after an update, or when the daemon's log went back; not with an address it cannot open.
  const reload =
    problem === LOG_BEHIND || problem === NOT_FOLDED || problem === APP_TOO_OLD || problem === DAEMON_TOO_OLD;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring",
        status === "refused" ? "text-red" : "text-amber",
        className,
      )}
    >
      <span className="flex-1">{problem}</span>
      {reload && (
        <Button variant="soft" onClick={onReload}>
          Reload
        </Button>
      )}
    </div>
  );
}
