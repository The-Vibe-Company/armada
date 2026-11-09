import type { SandboxStatus } from "@armada/core";
import { isActiveStatus } from "./events.ts";

/**
 * The durable lifecycle of a sandbox (#565), additive to its row: `expiresAt` is the deadline Armada holds itself to
 * (not the provider's own `status.expiresAt` observation), `effectiveTtlSeconds` the lifetime in force,
 * `requestedTtlSeconds` the lifetime asked for at launch (null: the default), `lastObservedAt` the last time Armada
 * read the provider, `lifecycleError` why the last stop attempt failed. All are null on rows from before #565.
 */
export type SandboxLifecycle = {
  expiresAt: string | null;
  effectiveTtlSeconds: number | null;
  requestedTtlSeconds: number | null;
  lastObservedAt: string | null;
  lifecycleError: string | null;
};

/**
 * Reads the lifecycle fields from a sandbox as the dashboard receives it, under the DTO's camelCase names or their
 * snake_case column names. A missing or malformed field is null, never a guess.
 */
export function readLifecycle(row: object): SandboxLifecycle {
  const record = row as Record<string, unknown>;
  const pick = (camel: string, snake: string) => record[camel] ?? record[snake];
  return {
    expiresAt: isoOrNull(pick("expiresAt", "expires_at")),
    effectiveTtlSeconds: secondsOrNull(pick("effectiveTtlSeconds", "effective_ttl_seconds")),
    requestedTtlSeconds: secondsOrNull(pick("requestedTtlSeconds", "requested_ttl_seconds")),
    lastObservedAt: isoOrNull(pick("lastObservedAt", "last_observed_at")),
    lifecycleError: textOrNull(pick("lifecycleError", "lifecycle_error")),
  };
}

/** What the page says about a sandbox's lifetime. None of it changes the status, which only the server sets. */
export type LifecycleView = {
  /** "8 h", with "(default)" or "(requested 24 h)" when that differs. Null for a legacy row. */
  lifetime: string | null;
  /** For a live sandbox before its deadline: "1 h 20 min left". */
  remaining: string | null;
  /**
   * A live sandbox past its deadline (`overdue`), or one whose stop failed and is retried (`retrying`). Stopped
   * stays stopped only when the server observed it; this notice never claims it.
   */
  notice: { kind: "overdue" | "retrying"; title: string; text: string } | null;
};

export function lifecycleView(status: SandboxStatus, lifecycle: SandboxLifecycle, now: Date): LifecycleView {
  const live = isActiveStatus(status);
  const deadline = lifecycle.expiresAt ? Date.parse(lifecycle.expiresAt) : Number.NaN;
  const left = Number.isNaN(deadline) ? null : Math.floor((deadline - now.getTime()) / 1000);
  const lifetime =
    lifecycle.effectiveTtlSeconds === null
      ? null
      : `${formatDuration(lifecycle.effectiveTtlSeconds)}${
          lifecycle.requestedTtlSeconds === null
            ? " (default)"
            : lifecycle.requestedTtlSeconds !== lifecycle.effectiveTtlSeconds
              ? ` (requested ${formatDuration(lifecycle.requestedTtlSeconds)})`
              : ""
        }`;
  let notice: LifecycleView["notice"] = null;
  if (live && lifecycle.lifecycleError)
    notice = {
      kind: "retrying",
      title: "Stop failed, retrying",
      text: `${lifecycle.lifecycleError} The sandbox may still be running until a retry succeeds. It shows as stopped only once the provider confirms it.`,
    };
  else if (live && left !== null && left <= 0)
    notice = {
      kind: "overdue",
      title: "Past its deadline",
      text: "Armada is stopping it. It shows as stopped once the provider confirms it.",
    };
  return {
    lifetime,
    remaining: live && left !== null && left > 0 ? `${formatDuration(left)} left` : null,
    notice,
  };
}

/** Whole minutes, hours and days, at most two units: "45 min", "2 h 5 min", "3 d 4 h", "under a minute". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function secondsOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 300) : null;
}
