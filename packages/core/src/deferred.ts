// Deferred launch state is derived from Linear's relations, never another dependency list.
import { shellWord } from "./brief.ts";
import { inFlight } from "./fleet.ts";
import type { HandBackSnapshot, InboxItem, LatestEvent, RuntimeHandle } from "./live.ts";
import { isClosed, type Model } from "./model.ts";

export interface DeferredLaunch {
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

export const deferredCommand = (ticket: string, profile: string | null, guided = false) =>
  `armada ${guided ? "brief" : "launch"} ${shellWord(ticket)}${profile ? ` --profile ${shellWord(profile)} --reason ${shellWord("deferred launch requested by the coordinator")}` : ""}${guided ? " --prompt" : ""}`;

/** Match authenticated identities independently of mutable display names. */
function sameAuthor(stored: string | null, current?: string | null): boolean {
  if (!stored || !current) return false;
  const identity = (value: string) => value.match(/\[(user|api-key):([^[\]\s]+)\]$/)?.[0];
  const a = identity(stored);
  const b = identity(current);
  return a || b ? !!a && a === b : stored === current;
}

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
  author?: string | null,
  guided = false,
  slots?: { taken: number; max: number | null },
): DeferredLaunch {
  const ticket = item.ticket ?? "";
  const issue = model?.program.find((i) => i.id === ticket);
  const blockers = issue && model ? model.openBlockersOf(issue) : null;
  const reason =
    !model || parkedLabel === undefined
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
                  : null;
  return {
    id: item.id,
    ticket,
    author: item.author,
    profile: item.request?.profile ?? null,
    blockers,
    reason,
    command: deferredCommand(ticket, item.request?.profile ?? null, guided),
    owned: sameAuthor(item.author, author),
  };
}

export function deferredWakeBody(item: InboxItem, model: Model, command: string): string {
  const issue = model.byId.get(item.ticket ?? "");
  const closed = issue?.blockedBy.filter((b) => isClosed(model.byId.get(b.id) ?? b)).map((b) => b.id) ?? [];
  return `${item.ticket} is unblocked${closed.length ? ` (${closed.join(", ")} done)` : ""}: launch it now: ${command}`;
}
