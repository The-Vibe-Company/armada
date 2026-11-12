import { AsyncLocalStorage } from "node:async_hooks";
import type { ModalPromptPhase } from "@armada/provider-modal";

/** Fixed, secret-free server phase names. Durations overlap: dispatch contains its subphases. */
export type TimingPhase =
  | ModalPromptPhase
  | "auth"
  | "dispatch"
  | "provider"
  | "stored_provider"
  | "sandbox_read"
  | "logs_target"
  | "events"
  | "state"
  | "prompt"
  | "send_credentials"
  | "send_state"
  | "send_turn_auth"
  | "send_submit";

export class RequestTiming {
  private readonly durations = new Map<TimingPhase, number>();
  async measure<T>(phase: TimingPhase, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      this.durations.set(phase, (this.durations.get(phase) ?? 0) + performance.now() - start);
    }
  }
  header(): string {
    return [...this.durations].map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`).join(", ");
  }
}

// The observer is request-local, never a property of a cached credential/provider.
const current = new AsyncLocalStorage<RequestTiming>();
export function withRequestTiming<T>(timing: RequestTiming, work: () => Promise<T>): Promise<T> {
  return current.run(timing, work);
}
export function measureProviderPhase<T>(phase: ModalPromptPhase, work: () => Promise<T>): Promise<T> {
  const timing = current.getStore();
  return timing ? timing.measure(phase, work) : work();
}
