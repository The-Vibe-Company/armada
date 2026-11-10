import { ArchiveIcon, GitPullRequestIcon, OctagonPauseIcon, TriangleAlertIcon } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { OutcomeView, PreservationView } from "@/lib/outcome";
import { TONE_BADGE } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

const OUTCOME_TONES: Record<OutcomeView["kind"], string> = {
  ready: TONE_BADGE.success,
  blocked: TONE_BADGE.warning,
};

/** The outcome as a badge: "Ready to merge" or "Blocked". */
export function OutcomeBadge({ outcome }: { outcome: OutcomeView }) {
  const Icon = outcome.kind === "ready" ? GitPullRequestIcon : OctagonPauseIcon;
  return (
    <span
      data-outcome={outcome.kind}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        OUTCOME_TONES[outcome.kind],
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {outcome.label}
    </span>
  );
}

/** What the outcome says beyond its label: the pull request and the short commit, or why the agent is blocked. */
export function OutcomeDetail({ outcome, className }: { outcome: OutcomeView; className?: string }) {
  if (outcome.kind === "blocked")
    return (
      <p data-outcome-detail="blocked" className={cn("text-sm break-words text-warning", className)}>
        <span className="font-medium">Blocked:</span> <span className="text-foreground">{outcome.reason}</span>
      </p>
    );
  if (!outcome.pr && !outcome.sha) return null;
  return (
    <p data-outcome-detail="ready" className={cn("flex flex-wrap items-center gap-x-2 text-sm", className)}>
      {outcome.pr &&
        (outcome.pr.href ? (
          <a
            href={outcome.pr.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
            {outcome.pr.label}
          </a>
        ) : (
          <span className="font-medium">{outcome.pr.label}</span>
        ))}
      {outcome.sha && (
        <code className="rounded bg-muted px-1 font-mono text-xs" title="Head commit">
          {outcome.sha}
        </code>
      )}
    </p>
  );
}

/** A stopped sandbox's work-preservation receipt, with the command that retrieves the archive when there is one. */
export function PreservationNotice({
  preservation,
  className,
}: {
  preservation: PreservationView;
  className?: string;
}) {
  const failed = preservation.kind === "failed";
  const Icon = failed ? TriangleAlertIcon : ArchiveIcon;
  return (
    <div
      data-preservation={preservation.kind}
      className={cn(
        "space-y-2 rounded-md border p-3 text-sm",
        failed ? "border-warning/40 bg-warning/5" : "bg-muted/30",
        className,
      )}
    >
      <p className={cn("flex items-center gap-1.5 font-medium", failed && "text-warning")}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {preservation.text}
      </p>
      {preservation.kind === "preserved" && preservation.command && <CopyLine command={preservation.command} />}
    </div>
  );
}

function CopyLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all" title={command}>
        {command}
      </code>
      <CopyButton value={command} label="Copy the recovery command" />
    </div>
  );
}
