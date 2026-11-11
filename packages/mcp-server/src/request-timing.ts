/** Fixed, secret-free server phase names. Durations overlap: dispatch contains its subphases. */
export type TimingPhase =
  | "auth"
  | "dispatch"
  | "tool_register"
  | "tool_connect"
  | "tool_call"
  | "tool_close"
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
