import type { EventInput, FleetEvent } from "@armada/daemon/events";
import type { ReaderUsage } from "@armada/protocol";
import { trackerChanges } from "./changes.ts";
import { linearReaderCheckpointSchema } from "./checkpoint.ts";
import { LinearRateLimitError, LinearReadError } from "./linear/index.ts";
import type { Tracker, TrackerReading } from "./types.ts";

interface PollClock {
  now(): Date;
  /** Return a cancel function; the host supplies setTimeout/clearTimeout. */
  set(callback: () => void, delayMs: number): () => void;
}
export interface PollStatus {
  intervalMs: number;
  reading: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  nextReadAt: string | null;
  error: string | null;
  pausedUntil: string | null;
  usage?: ReaderUsage;
}
export interface PollOptions {
  project: string;
  tracker: Tracker;
  store: {
    append(event: EventInput): FleetEvent | Promise<FleetEvent>;
    readSince(seq: number, project?: string): FleetEvent[] | Promise<FleetEvent[]>;
  };
  clock: PollClock;
  intervalMs?: number;
  timeoutMs?: number;
  fullReadMs?: number;
}
const FULL_READ_MS = 6 * 60 * 60_000;

/** Independent of HTTP/WebSocket dispatch: start returns immediately, reads never overlap.
 * Read deadlines race the provider too, so even a fetch ignoring AbortSignal cannot stall it.
 * The cooldown guards readNow itself: a manual/coordinator refresh cannot bypass it.
 */
export class TrackerPoller {
  readonly #options: PollOptions;
  readonly #status: PollStatus;
  #previous: TrackerReading | undefined;
  #lastFull = -Infinity;
  #restored = false;
  #restoredQuota: string | undefined;
  #restoredSource: string | undefined;
  #lastUsage = "";
  #running = false;
  #epoch = 0;
  #cancelNext: (() => void) | undefined;
  #active: Promise<void> | undefined;
  #providerPending = false;
  #controller: AbortController | undefined;

  constructor(options: PollOptions) {
    for (const value of [options.intervalMs ?? 30_000, options.timeoutMs ?? 30_000, options.fullReadMs ?? FULL_READ_MS])
      if (!Number.isFinite(value) || value <= 0) throw new Error("Tracker durations must be positive finite numbers");
    this.#options = options;
    this.#status = {
      intervalMs: options.intervalMs ?? 30_000,
      reading: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextReadAt: null,
      error: null,
      pausedUntil: null,
    };
  }

  get status(): Readonly<PollStatus> {
    const usage = this.#options.tracker.budget?.snapshot(this.#options.project);
    return { ...this.#status, ...(usage ? { usage, pausedUntil: usage.pausedUntil } : {}) };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#tick();
  }

  stop(): void {
    this.#epoch++;
    this.#running = false;
    this.#cancelNext?.();
    this.#cancelNext = undefined;
    this.#status.nextReadAt = null;
    this.#controller?.abort();
  }

  #tick(): void {
    const epoch = this.#epoch;
    void this.readNow().finally(() => {
      if (!this.#running || epoch !== this.#epoch) return;
      const now = this.#options.clock.now().getTime();
      const paused = this.status.pausedUntil;
      const delay = paused ? Math.max(0, Date.parse(paused) - now) : this.#status.intervalMs;
      this.#status.nextReadAt = new Date(now + delay).toISOString();
      this.#cancelNext = this.#options.clock.set(() => {
        this.#cancelNext = undefined;
        this.#status.nextReadAt = null;
        this.#tick();
      }, delay);
    });
  }

  async #restore(): Promise<void> {
    if (
      this.#restored &&
      this.#restoredQuota === this.#options.tracker.quota &&
      this.#restoredSource === this.#options.tracker.identity
    )
      return;
    const { tracker, store, project } = this.#options;
    if (this.#restoredSource !== tracker.identity) {
      this.#previous = undefined;
      this.#lastFull = -Infinity;
      this.#lastUsage = "";
    }
    if (tracker.identity)
      for (const event of await store.readSince(0, project)) {
        if (event.project !== project || event.kind !== "coordinator.checkpoint") continue;
        const parsed = linearReaderCheckpointSchema.safeParse(event.payload.checkpoint);
        if (!parsed.success) continue;
        const { cursor, usage, quota } = parsed.data;
        if (usage && quota === tracker.quota) tracker.budget?.restore(project, usage);
        if (parsed.data.source !== tracker.identity) continue;
        if (cursor) {
          if (!cursor.replace && !this.#previous) continue;
          const tickets = new Map((cursor.replace ? [] : (this.#previous?.tickets ?? [])).map((t) => [t.uuid, t]));
          const comments = new Map((cursor.replace ? [] : (this.#previous?.comments ?? [])).map((c) => [c.id, c]));
          for (const id of cursor.removedTickets) tickets.delete(id);
          for (const id of cursor.removedComments) comments.delete(id);
          for (const ticket of cursor.reading.tickets) tickets.set(ticket.uuid, ticket);
          for (const comment of cursor.reading.comments) comments.set(comment.id, comment);
          this.#previous = { ...cursor.reading, tickets: [...tickets.values()], comments: [...comments.values()] };
          this.#lastFull = Date.parse(cursor.fullReadAt);
          this.#status.lastCompletedAt = cursor.reading.startedAt;
        }
      }
    this.#restored = true;
    this.#restoredQuota = tracker.quota;
    this.#restoredSource = tracker.identity;
  }

  async #persist(reading?: TrackerReading, fullReadAt = this.#lastFull): Promise<void> {
    const { tracker, project, store, clock } = this.#options;
    if (!tracker.identity) return;
    const usage = tracker.budget?.snapshot(project);
    const serialized = JSON.stringify(usage);
    if (!reading && (serialized === this.#lastUsage || (!usage?.requests && !usage?.pausedUntil))) return;
    const replace = !this.#previous || fullReadAt !== this.#lastFull;
    const beforeTickets = new Map((replace ? [] : (this.#previous?.tickets ?? [])).map((t) => [t.uuid, t]));
    const beforeComments = new Map((replace ? [] : (this.#previous?.comments ?? [])).map((c) => [c.id, c]));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const cursor = reading
      ? {
          replace,
          fullReadAt: new Date(fullReadAt).toISOString(),
          reading: {
            ...reading,
            tickets: reading.tickets.filter((t) => !same(beforeTickets.get(t.uuid), t)),
            comments: reading.comments.filter((c) => !same(beforeComments.get(c.id), c)),
          },
          removedTickets: [...beforeTickets.keys()].filter((id) => !reading.tickets.some((t) => t.uuid === id)),
          removedComments: [...beforeComments.keys()].filter((id) => !reading.comments.some((c) => c.id === id)),
        }
      : undefined;
    await store.append({
      project,
      kind: "coordinator.checkpoint",
      actor: "Linear",
      at: clock.now().toISOString(),
      payload: {
        checkpoint: JSON.parse(
          JSON.stringify({
            format: "armada.linear-reader",
            version: 1,
            source: tracker.identity,
            quota: tracker.quota,
            ...(cursor ? { cursor } : {}),
            ...(usage ? { usage } : {}),
          }),
        ),
      },
    });
    this.#lastUsage = serialized;
  }

  /** Manual refresh joins the current read. Never await this from a page/protocol handler. */
  readNow(): Promise<void> {
    if (this.#active) return this.#active;
    // An expired deadline releases the caller, not the provider. Do not accumulate hanging reads.
    if (this.#providerPending) return Promise.resolve();
    const epoch = this.#epoch;
    this.#active = this.#read(epoch)
      .catch((error) => {
        this.#status.error = error instanceof LinearReadError ? error.message : "Tracker read failed";
      })
      .finally(() => {
        this.#active = undefined;
      });
    return this.#active;
  }

  async #read(epoch: number): Promise<void> {
    const { clock, tracker, store, project } = this.#options;
    const controller = new AbortController();
    this.#controller = controller;
    const startedAt = clock.now().toISOString();
    this.#status.reading = true;
    this.#providerPending = true;
    this.#status.lastStartedAt = startedAt;
    this.#status.error = null;
    let timedOut = false;
    const canceled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Tracker canceled")), { once: true });
    });
    const cancelDeadline = clock.set(() => {
      timedOut = true;
      controller.abort();
    }, this.#options.timeoutMs ?? 30_000);
    // Preparation, replay and persistence belong to the same deadline and single-flight
    // gate as HTTP. A late/uncooperative adapter cannot start an aborted provider read.
    const work = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        await tracker.prepare?.();
        controller.signal.throwIfAborted();
        await this.#restore();
        controller.signal.throwIfAborted();
        if (epoch !== this.#epoch) return;
        this.#status.pausedUntil = tracker.budget?.snapshot(project).pausedUntil ?? null;
        if (this.#status.pausedUntil) {
          this.#status.error = `Linear paused by its rate limit until ${this.#status.pausedUntil}`;
          await this.#persist();
          return;
        }
        const fullReadMs = this.#options.fullReadMs ?? FULL_READ_MS;
        const full =
          !this.#previous ||
          clock.now().getTime() - this.#lastFull >= fullReadMs ||
          clock.now().getTime() - Date.parse(this.#previous.startedAt) >= fullReadMs;
        const reading = await tracker.read({ previous: full ? undefined : this.#previous, signal: controller.signal });
        controller.signal.throwIfAborted();
        for (const event of trackerChanges(project, await store.readSince(0, project), reading)) {
          controller.signal.throwIfAborted();
          await store.append(event);
        }
        const fullReadAt = full ? Date.parse(startedAt) : this.#lastFull;
        controller.signal.throwIfAborted();
        await this.#persist(reading, fullReadAt);
        controller.signal.throwIfAborted();
        this.#previous = reading;
        this.#lastFull = fullReadAt;
        this.#status.lastCompletedAt = clock.now().toISOString();
      })
      .catch(async (error) => {
        // Failed/partial reads update usage and pause state, never the cursor. Keep
        // this append inside the deadline too, since a store adapter can stall.
        if (!controller.signal.aborted && epoch === this.#epoch) await this.#persist();
        throw error;
      })
      .finally(() => {
        this.#providerPending = false;
        this.#status.reading = false;
        this.#controller = undefined;
      });
    try {
      await Promise.race([work, canceled]);
    } catch (error) {
      this.#status.error = timedOut
        ? "Tracker read timed out"
        : error instanceof LinearReadError
          ? error.message
          : "Tracker read failed";
      if (error instanceof LinearRateLimitError) this.#status.pausedUntil = error.until;
    } finally {
      cancelDeadline();
    }
  }
}
