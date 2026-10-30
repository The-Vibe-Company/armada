import type { EventInput, FleetEvent } from "@armada/daemon/events";
import { trackerChanges } from "./changes.ts";
import { LinearReadError } from "./linear/index.ts";
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

/** Independent of HTTP/WebSocket dispatch: start returns immediately, reads never overlap.
 * Read deadlines race the provider too, so even a fetch ignoring AbortSignal cannot stall it.
 */
export class TrackerPoller {
  readonly #options: PollOptions;
  readonly #status: PollStatus;
  #previous: TrackerReading | undefined;
  #lastFull = -Infinity;
  #running = false;
  #epoch = 0;
  #cancelNext: (() => void) | undefined;
  #cancelDeadline: (() => void) | undefined;
  #active: Promise<void> | undefined;
  #providerPending = false;
  #controller: AbortController | undefined;

  constructor(options: PollOptions) {
    for (const value of [options.intervalMs ?? 30_000, options.timeoutMs ?? 30_000, options.fullReadMs ?? 1_800_000])
      if (!Number.isFinite(value) || value <= 0) throw new Error("Tracker durations must be positive finite numbers");
    this.#options = options;
    this.#status = {
      intervalMs: options.intervalMs ?? 30_000,
      reading: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextReadAt: null,
      error: null,
    };
  }

  get status(): Readonly<PollStatus> {
    return { ...this.#status };
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
      this.#status.nextReadAt = new Date(this.#options.clock.now().getTime() + this.#status.intervalMs).toISOString();
      this.#cancelNext = this.#options.clock.set(() => {
        this.#cancelNext = undefined;
        this.#status.nextReadAt = null;
        this.#tick();
      }, this.#status.intervalMs);
    });
  }

  /** Manual refresh joins the current read. Never await this from a page/protocol handler. */
  readNow(): Promise<void> {
    if (this.#active) return this.#active;
    // An expired deadline releases the caller, not the provider. Do not accumulate
    // hanging reads when a plugin ignores abort; ticks only recheck until it settles.
    if (this.#providerPending) return Promise.resolve();
    const controller = new AbortController();
    this.#controller = controller;
    const { clock, tracker, store, project } = this.#options;
    const startedAt = clock.now().toISOString();
    this.#status.reading = true;
    this.#providerPending = true;
    this.#status.lastStartedAt = startedAt;
    this.#status.error = null;
    const full = clock.now().getTime() - this.#lastFull >= (this.#options.fullReadMs ?? 1_800_000);
    let timedOut = false;
    const canceled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Tracker canceled")), { once: true });
    });
    this.#cancelDeadline = clock.set(() => {
      timedOut = true;
      controller.abort();
    }, this.#options.timeoutMs ?? 30_000);
    // Defer even synchronous plugin entry code until after readNow/start return.
    const read = Promise.resolve()
      .then(() => tracker.read({ previous: full ? undefined : this.#previous, signal: controller.signal }))
      .finally(() => {
        this.#providerPending = false;
        this.#status.reading = false;
        this.#controller = undefined;
      });
    this.#active = Promise.race([read, canceled])
      .then(async (reading) => {
        controller.signal.throwIfAborted();
        for (const event of trackerChanges(project, await store.readSince(0, project), reading)) {
          controller.signal.throwIfAborted();
          await store.append(event);
        }
        this.#previous = reading;
        if (full) this.#lastFull = Date.parse(startedAt);
        this.#status.lastCompletedAt = clock.now().toISOString();
      })
      .catch((error) => {
        // Only the adapter's own categorized errors may cross this boundary.
        this.#status.error = timedOut
          ? "Tracker read timed out"
          : error instanceof LinearReadError
            ? error.message
            : "Tracker read failed";
      })
      .finally(() => {
        this.#cancelDeadline?.();
        this.#cancelDeadline = undefined;
        this.#active = undefined;
      });
    return this.#active;
  }
}
