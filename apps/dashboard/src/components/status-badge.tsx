import type { SandboxStatus } from "@armada/core";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { type ConnectionState, connectionLook, statusLook, TONE_BADGE, TONE_DOT, type Tone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/** A sandbox's state: a dot that pulses while the state moves on its own, and its name. */
export function StatusBadge({ status, className }: { status: SandboxStatus; className?: string }) {
  const look = statusLook(status);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 pr-2 pl-1.5", TONE_BADGE[look.tone], status === "deleted" && "line-through", className)}
      data-status={status}
    >
      <StatusDot tone={look.tone} pulse={look.pulse} />
      {look.label}
    </Badge>
  );
}

/** The dot alone, for a place that already names the state. Decorative: the label beside it carries the meaning. */
export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-pulse={pulse || undefined}
      className={cn("relative flex size-1.5 shrink-0", className)}
    >
      {pulse && <span className={cn("absolute inset-0 rounded-full motion-safe:animate-live", TONE_DOT[tone])} />}
      <span className={cn("relative size-1.5 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

/**
 * Any state as a pill in the #758 tones: a dot and its label (a provider's connection, why a golden cannot launch).
 * The label carries the meaning; the colour only repeats it.
 */
export function ToneBadge({
  tone,
  pulse = false,
  className,
  children,
  ...props
}: { tone: Tone; pulse?: boolean } & ComponentProps<typeof Badge>) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 pr-2 pl-1.5", TONE_BADGE[tone], className)} {...props}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </Badge>
  );
}

/** A provider's or GitHub's connection, in the same pill everywhere. */
export function ConnectionBadge({ state, className }: { state: ConnectionState; className?: string }) {
  const look = connectionLook(state);
  return (
    <ToneBadge tone={look.tone} className={className} data-connection-state={state}>
      {look.label}
    </ToneBadge>
  );
}
