import { createHash } from "node:crypto";
import type { Delivery, EventInput, EventPayloads } from "@armada/protocol";
import { applyDelivery, deliveryFollowUpId } from "./delivery-state.ts";
import { fold } from "./fold.ts";
import type { EventStore } from "./store.ts";

type Queued = EventPayloads["delivery.queued"];
/** Deterministic identity makes a lost queue acknowledgement safe to replay. */
export function queueDelivery(
  input: Omit<Queued, "id"> & { project: string; at: string; actor: string },
): Extract<EventInput, { kind: "delivery.queued" }> {
  const { project, at, actor, ...payload } = input;
  const id = createHash("sha256")
    .update(JSON.stringify([project, payload.key]))
    .digest("hex");
  return { project, at, actor, kind: "delivery.queued", payload: { ...payload, id } };
}
interface Options {
  store: EventStore;
  /** Implementations must call the guard again immediately before each native write. */
  deliver(delivery: Delivery & { project: string }, beforeWrite: () => void): Promise<void>;
  now?: () => string;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}
const schedule: NonNullable<Options["schedule"]> = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
const lane = (project: string, session: string) => JSON.stringify([project, session]);

/** One durable side effect: keyed input to a pinned worker generation. */
export class Deliveries {
  readonly #options: Options;
  readonly #rows = new Map<string, Map<string, Delivery>>();
  // Terminal IDs are small tombstones; completed message bodies stay only in the log.
  readonly #completed = new Map<string, Set<string>>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  readonly #retryAt = new Map<string, number>();
  #cursor = 0;
  #closed = false;
  #queued = false;
  #cancel?: () => void;

  constructor(options: Options) {
    this.#options = options;
    this.#unsubscribe = options.store.subscribe(() => this.#wake());
    this.#wake();
  }
  #now() {
    return (this.#options.now ?? (() => new Date().toISOString()))();
  }
  #read() {
    for (const event of this.#options.store.readSince(this.#cursor)) {
      this.#cursor = event.seq;
      if (!event.kind.startsWith("delivery.")) continue;
      const rows = this.#rows.get(event.project) ?? new Map<string, Delivery>();
      const completed = this.#completed.get(event.project) ?? new Set<string>();
      this.#rows.set(event.project, rows);
      this.#completed.set(event.project, completed);
      if (event.kind === "delivery.queued" && completed.has(event.payload.id)) continue;
      applyDelivery(rows, event);
      if (event.kind === "delivery.sent" || (event.kind === "delivery.failed" && event.payload.nextAt === null)) {
        rows.delete(event.payload.id);
        completed.add(event.payload.id);
      }
    }
  }
  #wake() {
    if (this.#queued || this.#closed) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (!this.#closed) this.#pump();
    });
  }
  #target(project: string, row: Delivery) {
    const current = fold(this.#options.store.readSince(0, project)).projects[project]?.sessions.find(
      (s) => s.ticket === row.ticket,
    );
    if (!current || current.session !== row.session || current.generation !== row.generation)
      return "Worker generation changed; delivery permanently refused";
    if (current.phase === "released" || current.phase === "merged")
      return "Worker session ended; delivery permanently refused";
    return null;
  }
  #episode(project: string, row: Delivery) {
    const events = this.#options.store.readSince(0, project);
    const id = deliveryFollowUpId(row.id);
    const opened = events.findLast((e) => e.kind === "inbox.opened" && e.payload.id === id);
    const answered = events.findLast((e) => e.kind === "inbox.answered" && e.payload.id === id);
    const baseline = answered
      ? events.findLast((e) => e.seq < answered.seq && e.kind === "delivery.failed" && e.payload.id === row.id)
      : undefined;
    return {
      failures: row.attempt - (baseline?.kind === "delivery.failed" ? baseline.payload.attempt : 0),
      paused: !!opened && (!answered || opened.seq > answered.seq),
    };
  }
  #followUp(project: string, row: Delivery, at: string, attempt: number): EventInput {
    return {
      project,
      at,
      actor: "delivery",
      kind: "inbox.opened",
      payload: {
        id: deliveryFollowUpId(row.id),
        ticket: row.ticket,
        kind: "follow-up",
        body: `Worker input not delivered to ${row.ticket} after three failures; retries paused. Fix: relaunch the worker in place`,
        followUp: {
          cause: `delivery:${row.id}`,
          tool: "worker.message",
          code: "delivery_failed",
          args: { delivery: row.id },
          session: row.session,
          generation: row.generation,
          reason: "Worker input delivery failed three times; retries paused",
          facts: `${row.ticket}: input unreachable despite any continuing heartbeat`,
          next: "worker.relaunch",
          fix: "relaunch the worker in place",
          attempts: attempt,
          lastAt: at,
        },
      },
    };
  }
  #pump() {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#read();
    const now = Date.parse(this.#now());
    let nextAt = Infinity;
    for (const [project, rows] of this.#rows) {
      const blocked = new Set<string>();
      for (const row of [...rows.values()].sort((a, b) => a.seq - b.seq)) {
        if (row.sentAt || row.nextAt === null) continue;
        const key = lane(project, row.session);
        if (blocked.has(key)) continue;
        blocked.add(key);
        if (this.#running.has(key)) continue;
        if (!this.#target(project, row)) {
          const episode = this.#episode(project, row);
          if (episode.paused) continue;
          if (episode.failures >= 3) {
            // Upgrade/restart also bounds a legacy outbox that already retried indefinitely.
            try {
              this.#options.store.append(this.#followUp(project, row, this.#now(), row.attempt));
            } catch {
              nextAt = Math.min(nextAt, now + 2000);
            }
            continue;
          }
        }
        const due = Math.max(this.#retryAt.get(key) ?? 0, this.#target(project, row) ? now : Date.parse(row.nextAt));
        if (due > now) {
          nextAt = Math.min(nextAt, due);
          continue;
        }
        const running = this.#attempt(project, structuredClone(row)).finally(() => {
          this.#running.delete(key);
          this.#wake();
        });
        this.#running.set(key, running);
      }
    }
    if (Number.isFinite(nextAt))
      this.#cancel = (this.#options.schedule ?? schedule)(
        () => this.#wake(),
        Math.min(60_000, Math.max(0, nextAt - now)),
      );
  }
  async #attempt(project: string, row: Delivery) {
    const unchanged = () => {
      if (this.#closed) throw new Error("Delivery driver stopped");
      this.#read();
      if (this.#rows.get(project)?.get(row.id)?.seq !== row.seq) throw new Error("Delivery payload superseded");
      const reason = this.#target(project, row);
      if (reason) throw new Error(reason);
    };
    let failed = false;
    try {
      unchanged();
      await this.#options.deliver({ ...row, project }, unchanged);
      unchanged();
    } catch {
      failed = true;
    }
    if (this.#closed) return;
    this.#read();
    // A running attempt never acknowledges or fails a newer payload under the same key.
    const current = this.#rows.get(project)?.get(row.id);
    if (current?.seq !== row.seq || current.sentAt) return;
    const at = this.#now();
    const changed = this.#target(project, row);
    const attempt = row.attempt + 1;
    try {
      const receipt: EventInput =
        failed || changed
          ? {
              project,
              at,
              actor: "delivery",
              kind: "delivery.failed",
              payload: {
                id: row.id,
                attempt,
                // Runtime exceptions may contain credentials; only host-owned reasons enter the log.
                error: changed ?? "Worker input delivery failed (runtime details withheld)",
                nextAt: changed
                  ? null
                  : new Date(
                      Date.parse(at) + Math.min(60_000, 2000 * 2 ** Math.min(this.#episode(project, row).failures, 5)),
                    ).toISOString(),
              },
            }
          : { project, at, actor: "delivery", kind: "delivery.sent", payload: { id: row.id, at } };
      this.#options.store.appendMany([
        receipt,
        ...(failed && !changed && this.#episode(project, row).failures + 1 >= 3
          ? [this.#followUp(project, row, at, attempt)]
          : []),
      ]);
    } catch {
      // A failed receipt write leaves a keyed input pending. Avoid spinning on a broken store.
      this.#retryAt.set(lane(project, row.session), Date.parse(at) + 2000);
    }
  }
  async close() {
    this.#closed = true;
    this.#unsubscribe();
    this.#cancel?.();
    await Promise.allSettled(this.#running.values());
  }
}
