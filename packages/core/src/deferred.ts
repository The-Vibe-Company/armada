// Deferred launch state is derived from Linear's relations, never another dependency list.
import { shellWord } from "./brief.ts";
import type { ArmadaConfig } from "./config.ts";
import { inFlight } from "./fleet.ts";
import type { HandBackSnapshot, InboxItem, LatestEvent, PendingLaunch, RuntimeHandle } from "./live.ts";
import { isClosed, type Model } from "./model.ts";
import { routeProfile } from "./routing.ts";

export const DEFERRED_LAUNCH_DAYS = 7;
export const DEFERRED_LAUNCH_BACKOFF_MINUTES = 5;
export type DeferredAttempt =
  | { ok: true; attempt: number; attemptedAt?: string; tokenFence?: true }
  | { ok: false; why: string };

export const deferredExpired = (item: InboxItem, now: Date) =>
  now.getTime() >=
  Date.parse(
    item.request?.expiresAt ?? new Date(Date.parse(item.createdAt) + DEFERRED_LAUNCH_DAYS * 86400000).toISOString(),
  );

export interface DeferredLaunch {
  createdAt?: string;
  attempts?: number;
  attemptedAt?: string | null;
  pinned?: boolean;
  runtime?: string | null;
  notes?: string | null;
  profileReason?: string | null;
  expiresAt?: string | null;
  expired?: boolean;
  renewed?: boolean;
  guided?: boolean;
  id: number;
  ticket: string;
  author: string | null;
  profile: string | null;
  blockers: string[] | null;
  /** Null when unblocked and eligible; a missing reading always has a reason. */
  reason: string | null;
  command: string;
  /** Judged by the server against the authenticated caller, never supplied by the CLI. */
  owned: boolean;
}

export const deferredCommand = (
  ticket: string,
  profile: string | null,
  guided = false,
  options?: { runtime?: string | null; reason?: string | null },
) => {
  return `armada ${guided ? "brief" : "launch"} ${shellWord(ticket)}${profile ? ` --profile ${shellWord(profile)} --reason ${shellWord(options?.reason ?? "deferred launch requested by the coordinator")}` : ""}${options?.runtime && !guided ? ` --runtime ${shellWord(options.runtime)}` : ""}${guided ? " --prompt" : ""}`;
};

export function deferredHeld(
  model: Model,
  flight: NonNullable<HandBackSnapshot["flight"]>,
  now: Date,
  handles: RuntimeHandle[],
  events: Record<string, LatestEvent>,
): Set<string> {
  return new Set(
    inFlight(model, flight.program.comments, {
      now: now.getTime(),
      silentAfterMinutes: 0,
      live: { after: flight.after, events, handles: Object.fromEntries(handles.map((h) => [h.ticket, h])) },
    }).map((lane) => lane.issue.id),
  );
}

export function deferredLaunchState(
  item: InboxItem,
  model: Model | null,
  parkedLabel: string | undefined,
  held: boolean,
  coordinator?: string | null,
  guided = false,
  slots?: { taken: number; max: number | null },
  options?: {
    now?: Date;
    pendingLaunch?: PendingLaunch;
    config?: ArmadaConfig;
    expired?: boolean;
    uncertain?: boolean;
  },
): DeferredLaunch {
  const ticket = item.ticket ?? "";
  const issue = model?.program.find((i) => i.id === ticket);
  const blockers = issue && model ? model.openBlockersOf(issue) : null;
  const pinned = item.request?.pinned !== false;
  const profile = pinned ? (item.request?.profile ?? null) : null;
  const routed =
    options?.config && issue
      ? routeProfile(options.config, issue.labels, item.request?.runtime === "herdr" ? "herdr" : "conductor")?.name
      : null;
  guided =
    item.request?.runtime !== "herdr" &&
    (options?.config ? options.config.conductor.profiles[profile ?? routed ?? ""]?.runtime === "claude-code" : guided);
  const expired = options?.expired ?? (options?.now ? deferredExpired(item, options.now) : false);
  const pending = options?.pendingLaunch;
  const reason = expired
    ? `expired ${item.request?.expiresAt ?? new Date(Date.parse(item.createdAt) + DEFERRED_LAUNCH_DAYS * 86400000).toISOString()}`
    : options?.uncertain
      ? "launch outcome is uncertain; inspect and revoke before retrying"
      : pending
        ? `launched at ${pending.launchedAt.slice(11, 16)} UTC, waits for its claim`
        : (item.request?.attempts ?? 0) >= 3
          ? "gave up after 3 failed launches"
          : !model || parkedLabel === undefined
            ? "waiting for a stored reading"
            : !issue || !model.isLeaf(issue)
              ? "ticket is not in the program's launchable tickets"
              : isClosed(issue)
                ? `ticket is ${issue.status}`
                : issue.labels.includes(parkedLabel)
                  ? "parked"
                  : held || issue.prs.some((pr) => pr.state === "open")
                    ? "already in flight"
                    : blockers?.length
                      ? `waits on ${blockers.join(", ")}`
                      : slots?.max && slots.taken >= slots.max
                        ? `waits for a worker slot (${slots.taken} of ${slots.max})`
                        : options?.config && !issue.labels.includes(options.config.tracker.readyLabel)
                          ? `lacks ${options.config.tracker.readyLabel}`
                          : null;
  return {
    id: item.id,
    createdAt: item.createdAt,
    attempts: item.request?.attempts ?? 0,
    attemptedAt: item.request?.attemptedAt ?? null,
    ticket,
    author: item.author,
    profile,
    pinned,
    runtime: item.request?.runtime ?? null,
    notes: item.request?.notes ?? null,
    profileReason: item.request?.reason ?? null,
    expiresAt: item.request?.expiresAt ?? null,
    expired,
    guided,
    blockers,
    reason,
    command: deferredCommand(ticket, profile, guided, item.request),
    owned: (item.coordinator ?? "default") === (coordinator ?? "default"),
  };
}

export function deferredWakeBody(item: InboxItem, model: Model, command: string): string {
  const issue = model.byId.get(item.ticket ?? "");
  const closed = issue?.blockedBy.filter((b) => isClosed(model.byId.get(b.id) ?? b)).map((b) => b.id) ?? [];
  return `${item.ticket} is unblocked${closed.length ? ` (${closed.join(", ")} done)` : ""}: launch it now: ${command}`;
}

export function deferredExpiredBody(state: DeferredLaunch): string {
  const waiting = state.blockers?.length ? `still waits on ${state.blockers.join(", ")}` : "still waits for launch";
  return `${state.ticket} expired, ${waiting}: renew with armada launch ${state.ticket} --when-unblocked, or decline with armada answer ${state.id} "<why>"`;
}
