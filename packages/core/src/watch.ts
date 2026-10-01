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
import { entryKey, type Fleet, type InboxEntry } from "./live.ts";

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
export interface WatchState {
  /** The checkout (directory of armada.toml) where `armada watch` last ran: the coordinator's. */
  root: string | null;
  /** Entries the coordinator was shown (`entryKey`), by `inbox` or `watch`: they do not wake a watch again. */
  seen: string[];
  /** Tickets a worker held at the last read, the coordinator's own excluded; null when unknown. */
  inFlight: string[] | null;
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
  facts?: import("./live.ts").CoordinatorFacts;
  project: string;
  coordinator: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  /** `policy.not_started_minutes`. */
  notStartedMinutes?: number;
  /** Entries already shown to the coordinator (`WatchState.seen`). */
  seen: readonly string[];
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** After every read that answered: the entries and tickets in flight, to keep in the watch state. */
  onRead?: (read: { items: InboxEntry[]; inFlight: string[] | null }) => Promise<void>;
  /** A failure the watch waits out. */
  onRetry?: (message: string) => void;
  /**
   * A newer Armada release the coordinator was not told of yet (`releaseEntry`),
   * asked after every read: it ends the watch, after every inbox entry.
   */
  release?: () => Promise<InboxEntry | null> | InboxEntry | null;
  pollMs?: number;
  idlePollMs?: number;
}

export interface WatchReport {
  project: string;
  generatedAt: string;
  /** `items`: something the coordinator has not seen (marked `new`); `nothing`: no worker in flight, nothing open. */
  outcome: "items" | "nothing";
  /** Every open entry, oldest first. */
  items: InboxEntry[];
  /** Tickets a worker holds; null when Armada did not say. */
  inFlight: string[] | null;
  warnings: string[];
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
    silentAfterMinutes: o.silentAfterMinutes,
    ...(o.facts ? { facts: o.facts } : {}),
    ...(o.notStartedMinutes !== undefined ? { notStartedMinutes: o.notStartedMinutes } : {}),
  };
  const pollMs = o.pollMs ?? WATCH_POLL_MS;
  const idlePollMs = o.idlePollMs ?? WATCH_IDLE_POLL_MS;
  let known = new Set(o.seen);
  let etag: string | null = null;
  let items: InboxEntry[] = [];
  let inFlight: string[] | null = null;
  let failures = 0;
  const warnings = new Set<string>();
  const report = (outcome: WatchReport["outcome"]): WatchReport => ({
    project: o.project,
    generatedAt: o.now().toISOString(),
    outcome,
    items,
    inFlight,
    warnings: [...warnings],
  });
  for (;;) {
    let read: Awaited<ReturnType<Fleet["inbox"]>>;
    try {
      read = await fleet.inbox({ ...query, etag });
    } catch (err) {
      if (!transientFailure(err)) throw err;
      const wait = WATCH_BACKOFF_MS[Math.min(failures, WATCH_BACKOFF_MS.length - 1)] ?? pollMs;
      failures++;
      o.onRetry?.(`${(err as Error).message}; still watching, next try in ${wait / 1000} s`);
      await o.sleep(wait);
      continue;
    }
    failures = 0;
    if (read) {
      items = read.items.map((e) => ({ ...e, new: !known.has(entryKey(e)) }));
      inFlight = read.inFlight ?? null;
      etag = read.etag;
      known = new Set(items.map(entryKey));
      for (const w of read.warnings) warnings.add(w);
      await o.onRead?.({ items, inFlight });
    }
    // Not urgent: a release comes after the questions, plans and hand-backs already open.
    const release = (await o.release?.()) ?? null;
    if (release) items = [...items, { ...release, new: true }];
    if (items.some((e) => e.new)) return report("items");
    if (read && inFlight !== null && !inFlight.length && !items.length) return report("nothing");
    await o.sleep(inFlight !== null && !inFlight.length ? idlePollMs : pollMs);
  }
}

/**
 * The watch's entry for a newer Armada release: what is out, where its notes
 * are, and the steps, between rounds: workers in flight keep their version.
 */
export function releaseEntry(running: string, latest: string, at: Date): InboxEntry {
  return {
    id: null,
    kind: "version",
    ticket: null,
    author: null,
    version: latest,
    body: [
      `Armada ${latest} is out (you run ${running}). Changes: ${releaseNotesUrl(latest)}`,
      "Not urgent: finish what is in flight first, then, between rounds:",
      `  1. ${installCommand(latest)}`,
      "  2. armada init, then merge its pull request: armada merge <n> --no-ticket",
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
  open: number | null;
  running: number | null;
  act?: boolean;
}): Rearm {
  const then = o.act ? "act on the items above, then " : "";
  const watch = o.running !== null ? `armada watch is already running (pid ${o.running})` : null;
  let line: string;
  if (o.inFlight === null)
    line = watch
      ? `Workers may be in flight — ${then}${watch}.`
      : `While a worker is in flight, ${then}keep watching: armada watch`;
  else if (o.inFlight.length)
    line = `${workers(o.inFlight.length)} (${o.inFlight.join(", ")}) — ${watch ? `${then}${watch}.` : `${then}keep watching: armada watch`}`;
  else if (o.open)
    line = `No worker in flight, ${o.open} item${o.open === 1 ? "" : "s"} open — ${watch ? `${then}${watch}.` : `${then}keep watching: armada watch`}`;
  else if (o.open === null) line = "No worker in flight — nothing to watch.";
  else line = "No worker in flight and nothing open — nothing to watch.";
  return { inFlight: o.inFlight, open: o.open, running: o.running, line };
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
  if (!s.inFlight?.length) return { block: false, why: "no worker in flight at the last read" };
  return {
    block: true,
    reason: `${workers(s.inFlight.length)} on ${o.project} (${s.inFlight.join(", ")}) and no armada watch is running, so a hand-back or a question would go unnoticed. Start \`armada watch\` in the background now (in Claude Code, Bash with run_in_background), then end your turn: you are woken when it returns. (${STOP_HOOK_VARIABLE}=off turns this hook off.)`,
  };
}
