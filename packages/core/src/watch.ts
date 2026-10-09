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
import {
  entryKey,
  eventCursor,
  type Fleet,
  FOLLOW_EVENT_KINDS,
  type InboxEntry,
  type InboxEntryKind,
  parseEventCursor,
} from "./live.ts";

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
  /** Entries the coordinator was shown (`entryKey`), by `inbox` or `watch`: they do not wake a watch again. */
  seen: string[];
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
  const report = (outcome: WatchReport["outcome"]): WatchReport => ({
    project: o.project,
    generatedAt: o.now().toISOString(),
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
  });
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
          if (items.some((e) => e.new && !e.queue && (e.owner == null || e.owner === (o.coordinatorName ?? "default"))))
            return report("items");
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
    if (items.some((e) => e.new && !e.queue && (e.owner == null || e.owner === (o.coordinatorName ?? "default"))))
      return report("items");
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
        : `armada watch is already running (pid ${o.running})`
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

export type StopHookDecision = { block: false; why: string } | { block: true; reason: string };

/**
 * Whether a Claude Code coordinator may end its turn. It blocks only in the
 * checkout where `armada watch` ran (a worker, in its own workspace or
 * worktree, is never held), while the last read had workers in flight and no
 * watch runs for the project. Reads nothing but what it is given: the hook
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
}): StopHookDecision {
  const off = o.env[STOP_HOOK_VARIABLE]?.trim().toLowerCase();
  if (off === "off" || off === "0" || off === "false") return { block: false, why: `${STOP_HOOK_VARIABLE}=${off}` };
  const s = o.state;
  if (!s?.root) return { block: false, why: `armada watch never ran for ${o.project} on this machine` };
  if (s.root !== o.root) return { block: false, why: `the coordinator's checkout is ${s.root}, not this one` };
  if (o.watching !== null) return { block: false, why: `armada watch is running (pid ${o.watching})` };
  if (s.stopped) return { block: false, why: `the last watch was refused: ${s.stopped}` };
  if (s.openJobs?.length)
    return {
      block: true,
      reason: `${s.openJobs.length} open job${s.openJobs.length === 1 ? "" : "s"} on ${o.project} and no armada watch is running; start armada watch in the background so job alarms are heard. (${STOP_HOOK_VARIABLE}=off turns this hook off.)`,
    };
  if (s.waiting?.length)
    return {
      block: true,
      reason: `${s.waiting.length} waiting to launch on ${o.project}; start armada watch in the background to hear when they can launch.`,
    };
  if (!s.inFlight?.length) return { block: false, why: "no worker in flight at the last read" };
  return {
    block: true,
    reason: `${workers(s.inFlight.length)} on ${o.project} (${s.inFlight.join(", ")}) and no armada watch is running, so a hand-back or a question would go unnoticed. Start \`armada watch\` in the background now (in Claude Code, Bash with run_in_background), then end your turn: you are woken when it returns. (${STOP_HOOK_VARIABLE}=off turns this hook off.)`,
  };
}
