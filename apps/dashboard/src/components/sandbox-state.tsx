import { idlePauseMessage, type SandboxStatus } from "@armada/core";
import { statusLook } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/** Plain state vocabulary; colour is reserved for work, user attention and terminal failure. */
export function SandboxState({
  status,
  idlePaused,
  expiresAt,
  statusMessage,
  readyLabel,
  activityLabel,
  viewerOwns = true,
}: {
  status: SandboxStatus;
  viewerOwns?: boolean;
  idlePaused?: boolean | undefined;
  expiresAt?: string | null | undefined;
  statusMessage?: string | null | undefined;
  activityLabel?: string | undefined;
  readyLabel?: string | undefined;
}) {
  const paused = idlePauseMessage(
    { status, idlePaused: idlePaused === true, expiresAt: expiresAt ?? null },
    new Date(),
  );
  const waiting = status === "running" && /waiting for a free (agent )?slot/i.test(statusMessage ?? "");
  const look = statusLook(status);
  const label =
    activityLabel ??
    (status === "ready" && !viewerOwns && readyLabel !== "Finished"
      ? "Waiting"
      : paused
        ? "Paused"
        : status === "ready"
          ? (readyLabel ?? look.label)
          : look.label);
  const working = label === "Working" && !waiting;
  const hollow = !working && (paused || status === "stopped");
  const dotClass = hollow
    ? "border border-muted-foreground"
    : working
      ? "bg-success"
      : !viewerOwns || waiting
        ? "bg-muted-foreground/60"
        : label === "Waiting for you"
          ? "bg-warning"
          : status === "failed"
            ? "bg-destructive"
            : "bg-muted-foreground/60";
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-2 text-sm",
        status === "failed" && viewerOwns && "text-destructive",
      )}
    >
      <span
        aria-hidden="true"
        data-pulse={working || undefined}
        className={cn("relative inline-flex size-2 shrink-0", !working && "rounded-full", !working && dotClass)}
      >
        {working && (
          <>
            <span className={cn("absolute inset-0 rounded-full motion-safe:animate-live", dotClass)} />
            <span className={cn("relative block size-full rounded-full", dotClass)} />
          </>
        )}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
