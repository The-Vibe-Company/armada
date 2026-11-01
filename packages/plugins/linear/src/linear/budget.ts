import type { ReaderUsage } from "@armada/protocol";
import { LinearRateLimitError } from "./errors.ts";

const HOUR = 3_600_000;
const hourAt = (now: number) => new Date(Math.floor(now / HOUR) * HOUR).toISOString();

/** One activated provider shares a cooldown across projects, since credentials can share a user quota.
 * Only numeric, named budget headers cross into logs or durable state, never response bodies.
 */
export class LinearBudget {
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #usage = new Map<string, ReaderUsage>();
  #pausedUntil = 0;

  constructor(now: () => Date, log: (line: string) => void = () => {}) {
    this.#now = now;
    this.#log = log;
  }

  snapshot(project: string): ReaderUsage {
    const now = this.#now().getTime();
    const hour = hourAt(now);
    let usage = this.#usage.get(project);
    if (usage?.hour !== hour) {
      usage = { hour, requests: 0, pausedUntil: null };
      this.#usage.set(project, usage);
    }
    return {
      ...usage,
      ...(usage.rateLimit ? { rateLimit: { ...usage.rateLimit } } : {}),
      pausedUntil: this.#pausedUntil > now ? new Date(this.#pausedUntil).toISOString() : null,
    };
  }

  restore(project: string, usage: ReaderUsage): void {
    const now = this.#now().getTime();
    const until = usage.pausedUntil ? Date.parse(usage.pausedUntil) : 0;
    if (until > now) this.#pausedUntil = Math.max(this.#pausedUntil, Math.min(until, now + HOUR));
    if (usage.hour === hourAt(now) && usage.requests > this.snapshot(project).requests)
      this.#usage.set(project, { ...usage });
  }

  /** Guard every page too: another project can exhaust the shared quota during this read. */
  beforeRequest(project: string): void {
    const usage = this.snapshot(project);
    if (usage.pausedUntil) throw new LinearRateLimitError(usage.pausedUntil);
    this.#usage.set(project, { ...usage, requests: usage.requests + 1 });
  }

  response(project: string, headers?: Headers): void {
    const usage = this.snapshot(project);
    const numeric = (raw: string | null) => {
      if (!raw?.trim() || raw.length > 32) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const rateLimit: Record<string, number> = {};
    for (const [name, raw] of headers ?? []) {
      if (!/^x-ratelimit-[a-z0-9-]{1,80}$/.test(name)) continue;
      const value = numeric(raw);
      if (value !== undefined) rateLimit[name] = value;
    }
    const complexity = numeric(headers?.get("x-complexity") ?? null);
    const next = {
      ...usage,
      ...(complexity !== undefined ? { complexity } : {}),
      ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    };
    this.#usage.set(project, next);
    this.#log(
      `armadad: Linear: ${next.requests} requests this hour (${next.hour}); ${JSON.stringify({
        ...(complexity !== undefined ? { complexity } : {}),
        ...rateLimit,
      })}`,
    );
  }

  pause(headers: Headers): LinearRateLimitError {
    const now = this.#now().getTime();
    const raw = headers.get("retry-after");
    let delay: number | undefined;
    if (raw !== null) {
      if (/^\s*\d+(?:\.\d+)?\s*$/.test(raw)) delay = Number(raw) * 1000;
      else {
        const date = Date.parse(raw);
        if (Number.isFinite(date)) delay = Math.max(0, date - now);
      }
    }
    if (delay === undefined) {
      const resets = [...headers].flatMap(([name, value]) => {
        if (!/^x-ratelimit-.*-reset$/.test(name)) return [];
        const at = Number(value);
        return Number.isFinite(at) && at > now ? [at - now] : [];
      });
      delay = resets.length ? Math.max(...resets) : HOUR;
    }
    // A zero/past or invalid announcement must not produce a tight retry loop.
    this.#pausedUntil = Math.max(this.#pausedUntil, now + Math.max(1000, Math.min(HOUR, delay)));
    return new LinearRateLimitError(new Date(this.#pausedUntil).toISOString());
  }
}
