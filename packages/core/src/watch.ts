// `armada watch`: the coordinator keeps listening to its fleet. An agent only
// learns of something new when a command it runs ends, so the watch runs in
// the background and ends exactly when something needs the coordinator: an
// item it has not seen yet, or nothing left to watch. Every coordinator
// command ends on the re-arm line, which says whether to start it again, and
// the Claude Code stop hook refuses to end a turn while workers are in flight
// and no watch runs. This file is the pure side: the loop over an injected
// fleet and clock, the line and the hook's decision; the watch state file is
// `machine.ts`.

import { ArmadaApiError, installCommand, releaseNotesUrl } from "./armada-api.ts";
import { shellWord } from "./brief.ts";
import {
  entryKey,
  eventCursor,
  type Fleet,
  FOLLOW_EVENT_KINDS,
  type InboxEntry,
  type InboxEntryKind,
  parseEventCursor,
} from "./live.ts";
import { redactor } from "./redact.ts";

/** How often the watch asks Armada while a worker is in flight; Armada answers 304 while nothing changed. */
export const WATCH_POLL_MS = 15_000;
/** How often it asks when no worker is in flight but items stay open (the owner may answer from the dashboard). */
export const WATCH_IDLE_POLL_MS = 60_000;
/** Waits after a failed ask, one more step per failure in a row. */
export const WATCH_BACKOFF_MS = [15_000, 30_000, 60_000] as const;

/** The environment variable that turns the stop hook off: `ARMADA_STOP_HOOK=off`. */
export const STOP_HOOK_VARIABLE = "ARMADA_STOP_HOOK";

/**
 * What one machine remembers of a project's watch, in
 * `armada/watch/<project>.json` (`machine.ts`). No secret.
 */
export interface PeekTail {
  generation: string;
  lastReply: { at: string | null; text: string } | null;
  actions: {
    id?: string;
    at: string | null;
    kind: "command" | "tool" | "message";
    text: string;
    exit?: number | null;
  }[];
  truncated: boolean;
}

export interface WatchState {
  /** Coordinator session ids and their last registration on this machine (at most ten). */
  claudeSessions?: Record<string, string>;
  /** Bounded incremental Stop transcript cursors, keyed by Claude session id. */
  habitCursors?: Record<string, { path: string; offset: number }>;
  /** Shorter external watch lifetime observed on this machine. */
  harnessLimitMinutes?: number;
  /** The checkout (directory of armada.toml) where `armada watch` last ran: the coordinator's. */
  root: string | null;
  cursor?: string;
  eventIds?: number[];
  baselinePending?: boolean;
  freshStart?: boolean;
  /** Last attempted Conductor observation, per handle and generation (60 s throttle). */
  runtimeObserved?: Record<string, string>;
  /** Last attempted job status probe; kept in a dedicated machine namespace. */
  jobObserved?: Record<string, string>;
  /** Transcript cursors use a dedicated <project>.peek namespace, separate from fleet watch. */
  peek?: Record<string, string>;
  peekTail?: Record<string, PeekTail>;
  /** Entries shown by inbox or watch; follow mode retains this history. */
  seen: string[];
  /** First show and number of reminders delivered; listings never reset either. */
  shownAt?: Record<string, { first: string; level: number }>;
  /** Scope of the last pruning read; a narrower read preserves broader history. */
  seenScope?: "mine" | "all";
  /** Tickets a worker held at the last read, the coordinator's own excluded; null when unknown. */
  inFlight: string[] | null;
  waiting?: string[];
  slots?: { taken: number; max: number | null };
  openJobs?: number[];
  /** When `inFlight` was read. */
  readAt: string | null;
  /** Why the last watch ended on a refusal (signed out, refused); null otherwise. */
  stopped: string | null;
}

export const EMPTY_WATCH_STATE: WatchState = { root: null, seen: [], inFlight: null, readAt: null, stopped: null };

const REMINDED: readonly InboxEntryKind[] = [
  "question",
  "plan",
  "hand-back",
  "answer-request",
  "launch-request",
  "merge-request",
  "release-request",
  "plan-changes",
  "decision",
  "runtime-blocked",
  "queue-refused",
  "not-started",
  "stopped",
];

/** Plain watch wakes only for the selected coordinator's own and unowned work. */
export function wakingEligible(entry: InboxEntry, coordinatorName = "default"): boolean {
  return !entry.queue && (entry.owner == null || entry.owner === coordinatorName);
}

/** Intervals double (10, then 20, then 40 more minutes), anchored to the first show. */
export function remindDue(
  entry: InboxEntry,
  shownAt: WatchState["shownAt"],
  now: Date,
  minutes: number,
  coordinatorName = "default",
): boolean {
  const shown = shownAt?.[entryKey(entry)];
  return (
    minutes > 0 &&
    !!shown &&
    wakingEligible(entry, coordinatorName) &&
    REMINDED.includes(entry.kind) &&
    now.getTime() - Date.parse(shown.first) >= minutes * 60_000 * (2 ** (shown.level + 1) - 1)
  );
}

/**
 * A failure worth waiting out: Armada unreachable, timed out, overloaded or
 * failing (5xx, even as a proxy's HTML page). An answer this CLI cannot read
 * or a refusal is not: waiting would hide it.
 */
export function transientFailure(err: unknown): boolean {
  if (!(err instanceof ArmadaApiError)) return false;
  const s = err.status;
  if (s !== null) return s >= 500 || s === 408 || s === 429;
  return /\bunreachable\b|\bHTTP (?:5\d\d|408|429) without JSON\b/.test(err.message);
}

export interface WatchOptions {
  scope?: import("./live.ts").CoordinatorScope;
  coordinatorName?: string;
  signal?: AbortSignal;
  until?: Date;
  facts?: import("./live.ts").CoordinatorFacts;
  project: string;
  coordinator: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  launchGraceMinutes?: number;
  ciWaitMinutes?: number;
  quietAfterMinutes?: number;
  /** `policy.not_started_minutes`. */
  notStartedMinutes?: number;
  /** Entries already shown to the coordinator (`WatchState.seen`). */
  seen: readonly string[];
  shownAt?: WatchState["shownAt"];
  /** policy.coordinator_minutes; zero disables reminders. */
  coordinatorMinutes?: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** After every read that answered: the entries and tickets in flight, to keep in the watch state. */
  onRead?: (read: {
    items: InboxEntry[];
    inFlight: string[] | null;
    waiting?: string[];
    ownedWaiting?: string[];
    slots?: { taken: number; max: number | null };
    ownedInFlight?: string[];
    openJobs?: number[];
    ownedOpenJobs?: number[];
  }) => Promise<void>;
  /** A failure the watch waits out. */
  onRetry?: (message: string) => void;
  /**
   * A required CLI upgrade (`releaseEntry`), asked after every read.
   */
  release?: () => Promise<InboxEntry | null> | InboxEntry | null;
  pollMs?: number;
  idlePollMs?: number;
}

export interface WatchReport {
  shownAt: NonNullable<WatchState["shownAt"]>;
  waiting?: string[];
  ownedWaiting?: string[];
  slots?: { taken: number; max: number | null };
  ownedInFlight?: string[];
  ownedOpenJobs?: number[];
  project: string;
  generatedAt: string;
  /** `items`: something the coordinator has not seen (marked `new`); `nothing`: no worker in flight, nothing open. */
  outcome: "items" | "nothing" | "timeout";
  /** Every open entry, oldest first. */
  items: InboxEntry[];
  /** Tickets a worker holds; null when Armada did not say. */
  inFlight: string[] | null;
  openJobs?: number[];
  warnings: string[];
}

/** Stops even an outstanding request or an injected sleep; late answers cannot advance the watch. */
async function untilAborted<T>(signal: AbortSignal | undefined, work: () => T | Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await work();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Watches the coordinator's inbox until something needs the coordinator, then
 * returns it. It asks Armada every `pollMs` (every `idlePollMs` when no worker
 * is in flight) with the etag of its last read, so an unchanged inbox costs a
 * 304. A failure Armada may recover from (unreachable, 5xx) is waited out,
 * longer each time; a refusal (signed out, forbidden) is thrown. It has no time
 * limit of its own.
 */
export async function watchInbox(fleet: Fleet, o: WatchOptions): Promise<WatchReport> {
  const query = {
    coordinator: o.coordinator,
    coordinatorName: o.coordinatorName,
    scope: o.scope,
    silentAfterMinutes: o.silentAfterMinutes,
    launchGraceMinutes: o.launchGraceMinutes,
    ciWaitMinutes: o.ciWaitMinutes,
    quietAfterMinutes: o.quietAfterMinutes,
    ...(o.facts ? { facts: o.facts } : {}),
    ...(o.notStartedMinutes !== undefined ? { notStartedMinutes: o.notStartedMinutes } : {}),
  };
  const pollMs = o.pollMs ?? WATCH_POLL_MS;
  const idlePollMs = o.idlePollMs ?? WATCH_IDLE_POLL_MS;
  let known = new Set(o.seen);
  const shownAt = { ...o.shownAt };
  let etag: string | null = null;
  let items: InboxEntry[] = [];
  let inFlight: string[] | null = null;
  let waiting: string[] = [];
  let ownedWaiting: string[] | undefined;
  let slots: { taken: number; max: number | null } | undefined;
  let ownedInFlight: string[] | undefined;
  let openJobs: number[] = [];
  let ownedOpenJobs: number[] | undefined;
  let failures = 0;
  const warnings = new Set<string>();
  const report = (outcome: WatchReport["outcome"]): WatchReport => {
    if (outcome === "items")
      for (const item of items) {
        const key = entryKey(item);
        shownAt[key] ??= { first: o.now().toISOString(), level: 0 };
      }
    return {
      project: o.project,
      generatedAt: o.now().toISOString(),
      shownAt,
      outcome,
      items,
      inFlight,
      waiting,
      ownedWaiting,
      slots,
      ...(ownedInFlight ? { ownedInFlight } : {}),
      ...(openJobs.length ? { openJobs } : {}),
      ...(ownedOpenJobs ? { ownedOpenJobs } : {}),
      warnings: [...warnings],
    };
  };
  for (;;) {
    if (o.until && o.now() >= o.until) return report("timeout");
    let read: Awaited<ReturnType<Fleet["inbox"]>>;
    try {
      read = await untilAborted(o.signal, () => fleet.inbox({ ...query, etag }));
    } catch (err) {
      if (err instanceof ArmadaApiError && err.upgrade) {
        const release = await untilAborted(o.signal, () => o.release?.());
        if (release) {
          items = [...items.filter((e) => e.kind !== "version"), { ...release, new: !known.has(entryKey(release)) }];
          if (items.some((e) => e.new && wakingEligible(e, o.coordinatorName))) return report("items");
          await untilAborted(o.signal, () => o.sleep(boundedWait(o, pollMs)));
          continue;
        }
      }
      if (!transientFailure(err)) throw err;
      const wait = WATCH_BACKOFF_MS[Math.min(failures, WATCH_BACKOFF_MS.length - 1)] ?? pollMs;
      failures++;
      o.onRetry?.(`${(err as Error).message}; still watching, next try in ${wait / 1000} s`);
      await untilAborted(o.signal, () => o.sleep(boundedWait(o, wait)));
      continue;
    }
    failures = 0;
    if (read) {
      items = read.items.map((e) => ({ ...e, new: !known.has(entryKey(e)) }));
      const openKeys = new Set(items.map(entryKey));
      for (const key of Object.keys(shownAt))
        if (!openKeys.has(key) && !key.startsWith("version:")) delete shownAt[key];
      inFlight = read.inFlight ?? null;
      waiting = read.waiting ?? [];
      ownedWaiting = read.ownedWaiting;
      slots = read.slots;
      ownedInFlight = read.ownedInFlight;
      openJobs = read.openJobs ?? [];
      ownedOpenJobs = read.ownedOpenJobs;
      etag = read.etag;
      known = new Set([...known].filter((key) => key.startsWith("version:")).concat(items.map(entryKey)));
      for (const w of read.warnings) warnings.add(w);
      await untilAborted(o.signal, () =>
        o.onRead?.({
          items,
          inFlight,
          waiting,
          ownedWaiting,
          slots,
          openJobs,
          ...(ownedInFlight ? { ownedInFlight } : {}),
          ...(ownedOpenJobs ? { ownedOpenJobs } : {}),
        }),
      );
    }
    // Not urgent: a release comes after the questions, plans and hand-backs already open.
    const release = (await untilAborted(o.signal, () => o.release?.())) ?? null;
    items = items.filter((e) => e.kind !== "version");
    if (release) items.push({ ...release, new: !known.has(entryKey(release)) });
    for (const entry of items) {
      const key = entryKey(entry);
      // Old states retain seen keys, but have no reminder clock yet.
      if (!shownAt[key] && o.seen.includes(key)) shownAt[key] = { first: o.now().toISOString(), level: 0 };
      const shown = shownAt[key];
      if (shown && remindDue(entry, shownAt, o.now(), o.coordinatorMinutes ?? 10, o.coordinatorName)) {
        entry.reminder = true;
        entry.waitingSince = shown.first;
        shownAt[key] = { ...shown, level: shown.level + 1 };
      }
    }
    if (items.some((e) => (e.new || e.reminder) && wakingEligible(e, o.coordinatorName))) return report("items");
    if (read && inFlight !== null && !inFlight.length && !openJobs.length && !waiting.length && !items.length)
      return report("nothing");
    await untilAborted(o.signal, () =>
      o.sleep(
        boundedWait(
          o,
          inFlight !== null && !inFlight.length && !openJobs.length && !waiting.length ? idlePollMs : pollMs,
        ),
      ),
    );
  }
}

function boundedWait(o: WatchOptions, ms: number): number {
  return o.until ? Math.max(0, Math.min(ms, o.until.getTime() - o.now().getTime())) : ms;
}

export const FOLLOW_INBOX_KINDS: readonly InboxEntryKind[] = [
  "unblocked",
  "hold",
  "deploy",
  "job",
  "job-silent",
  "job-stalled",
  "queue-refused",
  "queue-stalled",
  "question",
  "plan",
  "hand-back",
  "request",
  "note",
  "decision",
  "answer-request",
  "launch-request",
  "launch-failed",
  "launch-uncertain",
  "merge-request",
  "release-request",
  "plan-changes",
  "runtime-blocked",
  "silent",
  "stopped",
  "quiet",
  "not-started",
  "version",
];
export const FOLLOW_KINDS = [...FOLLOW_INBOX_KINDS, ...FOLLOW_EVENT_KINDS, "handover"] as const;
export interface FollowLine {
  queue?: InboxEntry["queue"];
  cursor: string;
  kind: string;
  ticket: string | null;
  id: number | string | null;
  owner: string | null;
  at: string;
  body: string;
  new: boolean;
}
export interface FollowOptions extends WatchOptions {
  cursor?: string;
  /** A new watch seeds older events; an explicit resume also recovers higher IDs committed late. */
  freshStart?: boolean;
  baselinePending?: boolean;
  eventIds?: readonly number[];
  kinds?: readonly string[];
  tickets?: readonly string[];
  onPrinted?: (state: {
    seen: string[];
    cursor: string;
    eventIds: number[];
    baselinePending: boolean;
    freshStart: boolean;
  }) => Promise<void>;
  onIdle?: () => void;
}

/** Every yield is acknowledged on the next pull: persist only after the caller printed it. */
export async function* followFleet(fleet: Fleet, o: FollowOptions): AsyncGenerator<FollowLine> {
  let cursor = o.cursor ?? eventCursor(0, o.now().toISOString());
  parseEventCursor(cursor);
  const resumedAt = parseEventCursor(cursor);
  const seen = new Set(o.seen);
  let ids = [...(o.eventIds ?? [])];
  let baseline = o.baselinePending ?? !ids.length;
  const freshStart = o.freshStart ?? !o.cursor;
  const kinds = o.kinds ?? FOLLOW_INBOX_KINDS;
  const eventKinds = FOLLOW_EVENT_KINDS.filter(
    (k) => kinds.includes(k) || (k === "report" && kinds.includes("handover")),
  );
  let etag: string | null = null;
  let inFlight: string[] | null = null;
  let waiting: string[] = [];
  let ownedWaiting: string[] | undefined;
  let slots: { taken: number; max: number | null } | undefined;
  let openJobs: number[] = [];
  let first = true;
  let idle = false;
  let failures = 0;
  const query = {
    coordinator: o.coordinator,
    coordinatorName: o.coordinatorName,
    scope: o.scope,
    silentAfterMinutes: o.silentAfterMinutes,
    launchGraceMinutes: o.launchGraceMinutes,
    ciWaitMinutes: o.ciWaitMinutes,
    quietAfterMinutes: o.quietAfterMinutes,
    notStartedMinutes: o.notStartedMinutes,
    facts: o.facts,
  };
  const save = () =>
    o.onPrinted?.({
      seen: [...seen],
      cursor,
      eventIds: ids,
      baselinePending: baseline,
      freshStart: baseline && freshStart,
    });
  const accepts = (kind: string, ticket: string | null) =>
    kinds.includes(kind) && (!o.tickets || (ticket !== null && o.tickets.includes(ticket)));
  while (!o.until || o.now() < o.until) {
    try {
      const read = await untilAborted(o.signal, () => fleet.inbox({ ...query, etag }));
      if (read) {
        etag = read.etag;
        inFlight = read.inFlight ?? null;
        waiting = read.waiting ?? [];
        ownedWaiting = read.ownedWaiting;
        slots = read.slots;
        openJobs = read.openJobs ?? [];
        // Derived alarms are state: once absent, a later recurrence is new again.
        const openKeys = new Set(read.items.map(entryKey));
        let removed = false;
        for (const key of seen)
          if (!openKeys.has(key) && !key.startsWith("version:")) {
            seen.delete(key);
            removed = true;
          }
        if (removed) await save();
        await untilAborted(o.signal, () =>
          o.onRead?.({
            items: read.items,
            inFlight,
            waiting,
            ownedWaiting,
            slots,
            openJobs,
            ...(read.ownedOpenJobs ? { ownedOpenJobs: read.ownedOpenJobs } : {}),
            ...(read.ownedInFlight ? { ownedInFlight: read.ownedInFlight } : {}),
          }),
        );
        for (const warning of read.warnings) o.onRetry?.(warning);
        for (const item of read.items) {
          const key = entryKey(item);
          if (seen.has(key) || !accepts(item.kind, item.ticket)) continue;
          yield {
            cursor,
            kind: item.kind,
            ticket: item.ticket,
            id: item.id ?? key,
            owner: item.author,
            at: item.createdAt,
            body: item.body,
            ...(item.queue ? { queue: item.queue } : {}),
            new: !first,
          };
          seen.add(key);
          await save();
        }
      }
      const release = await untilAborted(o.signal, () => o.release?.());
      if (release && !seen.has(entryKey(release))) {
        yield {
          cursor,
          kind: release.kind,
          ticket: release.ticket,
          id: entryKey(release),
          owner: release.author,
          at: release.createdAt,
          body: release.body,
          new: true,
        };
        seen.add(entryKey(release));
        await save();
        return;
      }
      if (eventKinds.length) {
        const boundary = parseEventCursor(cursor);
        let pageAfter: { id: number; at: string } | undefined;
        for (;;) {
          const page = await untilAborted(o.signal, () =>
            fleet.eventsSince({
              ...boundary,
              scope: o.scope,
              coordinatorName: o.coordinatorName,
              kinds: eventKinds,
              handoverOnly: kinds.includes("handover") && !kinds.includes("report"),
              tickets: o.tickets,
              seenIds: ids,
              pageAfter,
              limit: 200,
            }),
          );
          if (!page) break;
          for (const event of page.events) {
            pageAfter = { id: event.id, at: event.at };
            if (ids.includes(event.id)) continue;
            if (
              baseline &&
              (event.at < resumedAt.afterAt || (event.at === resumedAt.afterAt && event.id <= resumedAt.afterId)) &&
              (freshStart || event.id <= resumedAt.afterId)
            ) {
              ids = [...ids, event.id].sort((a, b) => a - b).slice(-500);
              await save();
              continue;
            }
            const previous = parseEventCursor(cursor);
            const next =
              event.at > previous.afterAt || (event.at === previous.afterAt && event.id > previous.afterId)
                ? eventCursor(event.id, event.at)
                : cursor;
            const kind =
              event.kind === "report" &&
              event.phase === "ready-to-merge" &&
              kinds.includes("handover") &&
              !kinds.includes("report")
                ? "handover"
                : event.kind;
            if (!accepts(kind, event.ticket)) continue;
            yield {
              cursor: next,
              kind,
              ticket: event.ticket,
              id: event.id,
              owner: event.handle,
              at: event.at,
              body: event.message ?? event.phase ?? event.kind,
              new: true,
            };
            cursor = next;
            ids = [...ids, event.id].sort((a, b) => a - b).slice(-500);
            await save();
          }
          if (page.events.length < 200) break;
        }
        if (baseline) {
          baseline = false;
          await save();
        }
      }
      first = false;
      failures = 0;
      if (inFlight?.length === 0 && !openJobs.length && !waiting.length && !idle) {
        o.onIdle?.();
        idle = true;
      } else if (inFlight?.length || openJobs.length || waiting.length) idle = false;
      await untilAborted(o.signal, () =>
        o.sleep(
          boundedWait(
            o,
            inFlight?.length === 0 && !openJobs.length && !waiting.length
              ? (o.idlePollMs ?? WATCH_IDLE_POLL_MS)
              : (o.pollMs ?? WATCH_POLL_MS),
          ),
        ),
      );
    } catch (err) {
      if (err instanceof ArmadaApiError && err.upgrade) {
        const release = await untilAborted(o.signal, () => o.release?.());
        if (release) {
          yield {
            cursor,
            kind: release.kind,
            ticket: release.ticket,
            id: entryKey(release),
            owner: release.author,
            at: release.createdAt,
            body: release.body,
            new: true,
          };
          seen.add(entryKey(release));
          await save();
          return;
        }
      }
      if (!transientFailure(err)) throw err;
      const wait = WATCH_BACKOFF_MS[Math.min(failures++, WATCH_BACKOFF_MS.length - 1)] ?? WATCH_POLL_MS;
      o.onRetry?.(`${(err as Error).message}; still following, next try in ${wait / 1000} s`);
      await untilAborted(o.signal, () => o.sleep(boundedWait(o, wait)));
    }
  }
}

/**
 * The watch's entry for a newer Armada release: what is out, where its notes
 * are, and the steps, between rounds: workers in flight keep their version.
 */
export function releaseEntry(
  running: string,
  latest: string,
  at: Date,
  options: { minimum: string | null } = { minimum: null },
): InboxEntry {
  return {
    id: null,
    kind: "version",
    ticket: null,
    author: null,
    version: latest,
    body: [
      `Armada ${options.minimum ?? latest} required (you run ${running}). Changes: ${releaseNotesUrl(latest)}`,
      ...(options.minimum ? [`The server requires Armada ${options.minimum} or newer.`] : []),
      `Run armada upgrade (${installCommand(latest)} if upgrading by hand).`,
      "Workers in flight keep the version their brief pinned: tell them nothing unless the notes say otherwise.",
    ].join("\n"),
    createdAt: at.toISOString(),
    new: false,
  };
}

// ------------------------------------------------------------------ the re-arm line

export interface Rearm {
  /** Tickets a worker holds; null when unknown. */
  inFlight: string[] | null;
  openJobs?: number[];
  /** Open entries in the coordinator's inbox; null when the command did not read them. */
  open: number | null;
  /** The pid of the `armada watch` running for the project on this machine, or null. */
  running: number | null;
  /** The last line of the command's output. */
  line: string;
}

const workers = (n: number) => `${n} worker${n === 1 ? "" : "s"} in flight`;

/**
 * The last line of every coordinator command (`inbox`, `watch`, `merge`, `brief`):
 * whether to start watching again. `act` says the output lists items to act on first.
 */
export function rearm(o: {
  inFlight: string[] | null;
  openJobs?: number[];
  open: number | null;
  running: number | null;
  act?: boolean;
  mode?: "follow" | "watch";
  slots?: { taken: number; max: number | null };
  waiting?: number;
}): Rearm {
  const then = o.act ? "act on the items above, then " : "";
  const watch =
    o.running !== null
      ? o.mode === "follow"
        ? `armada watch is following (pid ${o.running})`
        : `armada watch is running (pid ${o.running}); starting another waits for its result`
      : null;
  const count = (o.slots?.max ? o.slots.taken : o.inFlight?.length) ?? 0;
  const workerLine = o.slots?.max ? `${count} of ${o.slots.max} workers in flight` : workers(count);
  const waitingLine = o.waiting ? ` · ${o.waiting} waiting to launch` : "";
  let line: string;
  if (o.inFlight === null)
    line = watch
      ? `Workers may be in flight — ${then}${watch}.`
      : `While a worker is in flight, ${then}keep watching: armada watch`;
  else if (count || o.waiting)
    line = `${workerLine}${o.inFlight.length ? ` (${o.inFlight.join(", ")})` : ""}${waitingLine} — ${watch ? `${then}${watch}.` : `${then}keep watching: armada watch`}`;
  else if (o.open)
    line = `No worker in flight, ${o.open} item${o.open === 1 ? "" : "s"} open — ${watch ? `${then}${watch}.` : `${then}keep watching: armada watch`}`;
  else if (o.open === null) line = "No worker in flight — nothing to watch.";
  else line = "No worker in flight and nothing open — nothing to watch.";
  if (o.openJobs?.length)
    line = `${o.openJobs.length} open job${o.openJobs.length === 1 ? "" : "s"} (${o.openJobs.join(", ")}) — ${watch ? `${then}${watch}.` : `${then}keep watching: armada watch`}${count || o.slots?.max ? ` · ${workerLine}` : ""}${waitingLine}`;
  return {
    inFlight: o.inFlight,
    ...(o.openJobs?.length ? { openJobs: o.openJobs } : {}),
    open: o.open,
    running: o.running,
    line,
  };
}

// ------------------------------------------------------------------ the stop hook

export interface CoordinatorHabit {
  rule: "foreground" | "raw-merge" | "wrapped" | "own-code";
  command: string;
  seconds?: number;
  pr?: number;
}

/** Mask shell data before matching command positions; unsupported quoting fails silent. */
function shellCode(command: string): string {
  const lines: string[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const physical = command.split("\n");
  for (let n = 0; n < physical.length; n++) {
    let line = physical[n] ?? "";
    const heredoc = heredocs[0];
    if (heredoc) {
      if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) heredocs.shift();
      continue;
    }
    let code = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "#" && (i === 0 || /[\s;&|]/.test(line[i - 1] ?? ""))) break;
      if (c === "\\") {
        if (i === line.length - 1 && n + 1 < physical.length) {
          line = line.slice(0, i) + physical[++n];
          i--;
          continue;
        }
        code += "__escaped__";
        i++;
        continue;
      }
      if (c === "<" && line[i + 1] === "<") {
        // Here strings and unsupported delimiter forms must not expose data as commands.
        if (line[i + 2] === "<") return "";
        let j = i + 2;
        const stripTabs = line[j] === "-";
        if (stripTabs) j++;
        while (/\s/.test(line[j] ?? "") && j < line.length) j++;
        let delimiter = "";
        let quoted = false;
        while (j < line.length && !/[\s;&|<>]/.test(line[j] ?? "")) {
          const char = line[j++];
          if (char === "'" || char === '"') {
            quoted = true;
            let closed = false;
            while (j < line.length) {
              const next = line[j++];
              if (next === char) {
                closed = true;
                break;
              }
              // Complex double-quoted delimiter escapes are conservatively ignored.
              if (char === '"' && next === "\\") return "";
              delimiter += next;
            }
            if (!closed) return "";
          } else if (char === "\\") {
            if (j === line.length) return "";
            delimiter += line[j++];
          } else delimiter += char;
        }
        if (!delimiter && !quoted) return "";
        heredocs.push({ delimiter, stripTabs });
        code += "<<__heredoc__";
        i = j - 1;
        continue;
      }
      if (c === "'" || c === '"') {
        let word = "";
        let closed = false;
        while (++i < line.length) {
          if (line[i] === c) {
            closed = true;
            break;
          }
          if (c === '"' && line[i] === "\\") {
            i++;
            word += line[i] ?? "";
          } else word += line[i];
        }
        if (!closed) return "";
        code += word === "/dev/null" ? word : "__quoted__";
      } else code += c;
    }
    lines.push(code);
  }
  return lines.join("\n");
}

const COMMAND_START = String.raw`(?:^|[;&|\n(])\s*(?:[A-Za-z_]\w*=[^\s;&|]+\s+)*(?:(?:env|command|exec|sudo|npx|bunx)\s+)?`;

/** Name the program/subcommand without copying arbitrary arguments or environment assignments. */
function habitCommand(command: string): string {
  const code = shellCode(command);
  const known = new RegExp(
    `${COMMAND_START}(gh\\s+pr\\s+(?:merge|create)|git\\s+commit|armada(?:\\s+(?:watch|status|inbox|launch|merge|job|digest))?|bun\\s+run(?:\\s+(?:verify|test|build|lint|typecheck))?)\\b`,
  ).exec(code);
  const program = new RegExp(`${COMMAND_START}([\\w./+-]+)`).exec(code);
  return `${redactor([])
    .text(known?.[1] ?? program?.[1] ?? "Bash")
    .slice(0, 100)} (arguments omitted)`;
}

/** Claude's transcript is not a public contract: unknown and malformed lines are ignored. */
export function coordinatorHabits(lines: string[], o: { since?: string } = {}): CoordinatorHabit[] {
  const uses = new Map<string, { command: string; background: boolean; at: number }>();
  const findings: CoordinatorHabit[] = [];
  const since = Date.parse(o.since ?? "");
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (!row || !Array.isArray(row.message?.content)) continue;
      const at = Date.parse(row.timestamp);
      for (const block of row.message.content) {
        if (!block || typeof block !== "object") continue;
        if (
          row.type === "assistant" &&
          block.type === "tool_use" &&
          block.name === "Bash" &&
          typeof block.id === "string" &&
          typeof block.input?.command === "string" &&
          (block.input.run_in_background === undefined || typeof block.input.run_in_background === "boolean")
        ) {
          uses.set(block.id, { command: block.input.command, background: block.input.run_in_background === true, at });
        } else if (row.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const use = uses.get(block.tool_use_id);
          if (!use) continue;
          uses.delete(block.tool_use_id);
          if (Number.isFinite(since) && (!Number.isFinite(at) || at < since)) continue;
          const command = use.command;
          const seconds = (at - use.at) / 1000;
          if (!use.background && seconds > 60 && Number.isFinite(seconds))
            findings.push({ rule: "foreground", command, seconds });
          const code = shellCode(command);
          const merge = new RegExp(`${COMMAND_START}gh\\s+pr\\s+merge\\b(?:\\s+(\\d+)\\b)?`).exec(code);
          if (merge) findings.push({ rule: "raw-merge", command, ...(merge[1] ? { pr: Number(merge[1]) } : {}) });
          const armada = new RegExp(`${COMMAND_START}(?:bun\\s+run\\s+)?armada\\b([^;\\n]*)`, "g");
          if (
            [...code.matchAll(armada)].some((match) =>
              /\|\s*(?:grep|tail|head)\b|(?:\d*|&)>>?\s*\/dev\/null\b|2>&1\s*\||\|\|\s*true\b/.test(match[1] ?? ""),
            )
          )
            findings.push({ rule: "wrapped", command });
          if (new RegExp(`${COMMAND_START}(?:git\\s+commit|gh\\s+pr\\s+create)\\b`).test(code))
            findings.push({ rule: "own-code", command });
        }
      }
    } catch {
      /* Fail silent on a partial line or a changed transcript shape. */
    }
  }
  return findings;
}

interface HabitDeployTarget {
  name: string;
  configPath?: string;
}

function habitReason(finding: CoordinatorHabit, deployTargets: HabitDeployTarget[]): string {
  const command = habitCommand(finding.command);
  switch (finding.rule) {
    case "foreground":
      return `Foreground command ${JSON.stringify(command)} took ${Math.ceil(finding.seconds ?? 0)} seconds. Never block the session for more than a minute: use armada job start <name> --ticket <id> for a declared long job, or run the command in the background (Bash run_in_background) and keep armada watch in the background.`;
    case "raw-merge": {
      const pr = finding.pr ?? "<n>";
      return (
        `Raw merge ${JSON.stringify(command)}: merge through armada merge. Finish this merge with armada merge --finish ${pr}.` +
        deployTargets
          .map(
            (target) =>
              ` Then run armada deploy watch --sha <merge commit of #${pr}> --target ${shellWord(target.name)}${target.configPath ? ` --config ${shellWord(target.configPath)}` : ""} in the background.`,
          )
          .join("")
      );
    }
    case "wrapped":
      return `Wrapped command ${JSON.stringify(command)}: run Armada commands bare; their last lines say whether it worked.`;
    case "own-code":
      return `Coordinator code command ${JSON.stringify(command)}: cut a ticket and launch a worker. Every fix, including armada.toml, goes through a worker pull request and armada merge.`;
  }
}

export type StopHookDecision = { block: false; why: string } | { block: true; reason: string };

/**
 * Whether a Claude Code coordinator may end its turn. It blocks only in the
 * registered coordinator session, with a checkout fallback for older sessions,
 * when a new habit reminder is due, or the last read had workers/jobs in flight
 * and no watch runs for the project. Reads nothing but what it is given: the hook
 * answers at once, without the network.
 */
export function stopHookDecision(o: {
  project: string;
  /** Directory of the armada.toml the session works in. */
  root: string;
  state: WatchState | null;
  /** Pid of the live watch of the project, or null. */
  watching: number | null;
  env: Record<string, string | undefined>;
  match?: "session" | "checkout";
  /** Already reserved once-per-session findings; the adapter owns notice persistence. */
  habits?: CoordinatorHabit[];
  deployTargets?: HabitDeployTarget[];
}): StopHookDecision {
  const off = o.env[STOP_HOOK_VARIABLE]?.trim().toLowerCase();
  if (off === "off" || off === "0" || off === "false") return { block: false, why: `${STOP_HOOK_VARIABLE}=${off}` };
  if (o.env.ARMADA_TICKET?.trim()) return { block: false, why: "this is a worker session" };
  const s = o.state;
  if (!s?.root) return { block: false, why: `armada watch never ran for ${o.project} on this machine` };
  if (o.match !== "session" && s.root !== o.root)
    return { block: false, why: `the coordinator's checkout is ${s.root}, not this one` };
  const watchDecision = (): StopHookDecision => {
    if (o.watching !== null) return { block: false, why: `armada watch is running (pid ${o.watching})` };
    if (s.stopped) return { block: false, why: `the last watch was refused: ${s.stopped}` };
    if (s.openJobs?.length)
      return {
        block: true,
        reason: `${s.openJobs.length} open job${s.openJobs.length === 1 ? "" : "s"} on ${o.project} and no armada watch is running; start armada watch in the background from ${s.root} so job alarms are heard. (${STOP_HOOK_VARIABLE}=off turns this hook off.)`,
      };
    if (s.waiting?.length)
      return {
        block: true,
        reason: `${s.waiting.length} waiting to launch on ${o.project}; start armada watch in the background to hear when they can launch.`,
      };
    if (!s.inFlight?.length) return { block: false, why: "no worker in flight at the last read" };
    return {
      block: true,
      reason: `${workers(s.inFlight.length)} on ${o.project} (${s.inFlight.join(", ")}) and no armada watch is running, so a hand-back or a question would go unnoticed. Start \`armada watch\` in the background now from ${s.root} (in Claude Code, Bash with run_in_background), then end your turn: you are woken when it returns. (${STOP_HOOK_VARIABLE}=off turns this hook off.)`,
    };
  };
  const watch = watchDecision();
  const reasons = (o.habits ?? []).map((finding) => habitReason(finding, o.deployTargets ?? []));
  if (!reasons.length) return watch;
  if (watch.block) reasons.unshift(watch.reason);
  return { block: true, reason: reasons.join("\n") };
}

export interface HookRun {
  at: string;
  project: string | null;
  why: string;
}

export type StopHookState = { state: "on" | "installed" | "off"; why: string; fix: string | null };

/** Local proof of hook delivery, separate from whether a turn needed to be held. */
export function stopHookState(o: {
  env: Record<string, string | undefined>;
  sessionId: string | null;
  hookRun: HookRun | null;
  installedIn: string | null;
}): StopHookState {
  const off = o.env[STOP_HOOK_VARIABLE]?.trim().toLowerCase();
  if (["off", "0", "false"].includes(off ?? ""))
    return { state: "off", why: "off by choice", fix: `unset ${STOP_HOOK_VARIABLE} to turn it on` };
  if (o.env.ARMADA_TICKET?.trim())
    return { state: "off", why: "this is a worker session", fix: "the stop hook only holds coordinator sessions" };
  if (!o.sessionId)
    return { state: "off", why: "no Claude Code session id", fix: "run a coordinator command in Claude Code" };
  const run = o.hookRun;
  if (run && Number.isFinite(Date.parse(run.at))) {
    if (
      run.why === "blocked" ||
      run.why
        .split("; ")
        .every((why) => why === "no worker in flight at the last read" || why.startsWith("armada watch is running"))
    )
      return { state: "on", why: `last ran ${run.at}`, fix: null };
    return {
      state: "off",
      why: run.why,
      fix: "run armada inbox or armada watch for this project in this coordinator session, then check at your next turn end",
    };
  }
  if (o.installedIn) return { state: "installed", why: o.installedIn, fix: "it confirms at your next turn end" };
  return {
    state: "off",
    why: "no Armada stop hook installed",
    fix: "add it with `armada init --merge`, or to `~/.claude/settings.json` when your session starts outside the checkout; it only holds coordinator sessions",
  };
}
