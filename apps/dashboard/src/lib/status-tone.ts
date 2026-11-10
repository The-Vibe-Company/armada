import type { SandboxStatus } from "@armada/core";

/**
 * The colour a state is drawn in (#757). Colour carries meaning only: `info` is in flight (an agent working),
 * `success` live and idle, `warning` in transition, `destructive` failed, `neutral` at rest or gone.
 */
export type Tone = "info" | "success" | "warning" | "destructive" | "neutral";

export type StatusLook = {
  tone: Tone;
  /** Whether the state is still moving on its own: its dot pulses (unless the viewer asked for reduced motion). */
  pulse: boolean;
  label: string;
};

const LOOKS: Record<SandboxStatus, StatusLook> = {
  starting: { tone: "warning", pulse: true, label: "Starting" },
  ready: { tone: "success", pulse: false, label: "Ready" },
  running: { tone: "info", pulse: true, label: "Running" },
  stopping: { tone: "warning", pulse: true, label: "Stopping" },
  stopped: { tone: "neutral", pulse: false, label: "Stopped" },
  failed: { tone: "destructive", pulse: false, label: "Failed" },
  deleted: { tone: "neutral", pulse: false, label: "Deleted" },
};

/** How a sandbox status looks. An unknown status (a newer server) is shown as itself, at rest. */
export function statusLook(status: string): StatusLook {
  return (
    (LOOKS as Record<string, StatusLook | undefined>)[status] ?? {
      tone: "neutral",
      pulse: false,
      label: status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown",
    }
  );
}

/** The badge classes of each tone: a tinted fill, a hairline of the same hue and AA text. */
export const TONE_BADGE: Record<Tone, string> = {
  info: "border-info/25 bg-info/10 text-info",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  destructive: "border-destructive/25 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** The dot of each tone. */
export const TONE_DOT: Record<Tone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};

/** Whether something the org or the viewer connects (a sandbox provider, GitHub) is usable now. */
export type ConnectionState = "connected" | "not-connected" | "revoked" | "unavailable";

const CONNECTION_LOOKS: Record<ConnectionState, StatusLook> = {
  connected: { tone: "success", pulse: false, label: "Connected" },
  "not-connected": { tone: "neutral", pulse: false, label: "Not connected" },
  revoked: { tone: "destructive", pulse: false, label: "Revoked" },
  unavailable: { tone: "warning", pulse: false, label: "Unavailable" },
};

/** How a connection's state looks: connected is live, not connected at rest, revoked failed, unread in doubt. */
export function connectionLook(state: ConnectionState): StatusLook {
  return CONNECTION_LOOKS[state];
}
