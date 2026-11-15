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
  viewerOwns = true,
}: {
  status: SandboxStatus;
  viewerOwns?: boolean;
  idlePaused?: boolean | undefined;
  expiresAt?: string | null | undefined;
  statusMessage?: string | null | undefined;
  readyLabel?: string | undefined;
}) {
  const paused = idlePauseMessage(
    { status, idlePaused: idlePaused === true, expiresAt: expiresAt ?? null },
    new Date(),
  );
  const waiting = status === "running" && /waiting for a free (agent )?slot/i.test(statusMessage ?? "");
  const look = statusLook(status);
  const label =
    status === "ready" && !viewerOwns && readyLabel !== "Finished"
      ? "Waiting"
      : paused
        ? "Paused"
        : status === "ready"
          ? (readyLabel ?? look.label)
          : look.label;
  const hollow = paused || status === "stopped";
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm", status === "failed" && viewerOwns && "text-destructive")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          hollow
            ? "border border-muted-foreground"
            : !viewerOwns || waiting || look.tone === "neutral"
              ? "bg-muted-foreground/60"
              : label === "Waiting for you"
                ? "bg-warning"
                : status === "failed"
                  ? "bg-destructive"
                  : "bg-success",
        )}
      />
      {label}
    </span>
  );
}
