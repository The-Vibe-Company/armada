"use client";

import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  GitPullRequestIcon,
  OctagonPauseIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { OutcomeView, PreservationView } from "@/lib/outcome";
import { cn } from "@/lib/utils";

const OUTCOME_TONES: Record<OutcomeView["kind"], string> = {
  ready: "border-success/40 bg-success/10 text-success",
  blocked: "border-warning/40 bg-warning/10 text-warning",
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
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    const done = (result: "copied" | "failed") => {
      setCopied(result);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1600);
    };
    // No clipboard outside a secure context: the command stays on screen to select.
    if (!navigator.clipboard) return done("failed");
    navigator.clipboard.writeText(command).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all" title={command}>
        {command}
      </code>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label="Copy the recovery command">
        {copied === "copied" ? <CheckIcon /> : <CopyIcon />}
        {copied === "copied" ? "Copied" : copied === "failed" ? "Select to copy" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {copied === "copied"
          ? "The recovery command was copied."
          : copied === "failed"
            ? "The clipboard is unavailable: select the command to copy it."
            : ""}
      </span>
    </div>
  );
}
