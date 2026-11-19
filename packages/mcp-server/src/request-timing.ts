import { AsyncLocalStorage } from "node:async_hooks";
import type { ModalPromptPhase } from "@armada/provider-modal";

/** Fixed, secret-free server phase names. Durations overlap: dispatch contains its subphases. */
export type TimingPhase =
  | ModalPromptPhase
  | "db_acquire"
  | "sql"
  | "total"
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
  private sqlStatements = 0;
  // Only sequence numbers and durations; keep headers bounded on query-heavy operations.
  private readonly statements = new Map<number, number>();
  private readonly durations = new Map<TimingPhase, number>();
  async measure<T>(phase: TimingPhase, work: () => Promise<T>): Promise<T> {
    const statement = phase === "sql" ? ++this.sqlStatements : undefined;
    const start = performance.now();
    try {
      return await work();
    } finally {
      const duration = performance.now() - start;
      this.durations.set(phase, (this.durations.get(phase) ?? 0) + duration);
      if (statement !== undefined && statement <= 32) this.statements.set(statement, duration);
    }
  }
  header(): string {
    const phases = [...this.durations].map(
      ([name, duration]) =>
        `${name};dur=${duration.toFixed(2)}${name === "sql" ? `;desc="${this.sqlStatements}"` : ""}`,
    );
    const statements = [...this.statements]
      .sort(([a], [b]) => a - b)
      .map(([number, duration]) => `sql_${number};dur=${duration.toFixed(2)}`);
    return [...phases, ...statements].join(", ");
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

/** Optional request-local measurement for handlers that also run without a timing observer. */
export function measureRequestPhase<T>(
  timing: RequestTiming | undefined,
  phase: TimingPhase,
  work: () => Promise<T>,
): Promise<T> {
  return timing ? timing.measure(phase, work) : work();
}

type GoldenLaunchPhase =
  | "admission"
  | "account_resolution"
  | "provider_resolution"
  | "receipt_admission"
  | "shared_launcher"
  | "template_execution"
  | "response_publication";

export type GoldenLaunchTiming = {
  checkpoint(phase: GoldenLaunchPhase): void;
  launched(sandbox: { id: string; provider: string }): void;
};

const launchSql = new AsyncLocalStorage<{ statements: number }>();

export async function observeGoldenLaunch<T>(
  surface: "rest" | "mcp" | "template_rest" | "routine",
  work: (timing: GoldenLaunchTiming) => Promise<T>,
  finalPhase: "response_publication" | "template_execution" = "response_publication",
) {
  const sql = { statements: 0 };
  const started = performance.now();
  let previous = started;
  let previousStatements = 0;
  const stages: { name: GoldenLaunchPhase; ms: number; sqlStatements: number }[] = [];
  let sandboxId: string | undefined;
  const checkpoint: GoldenLaunchTiming["checkpoint"] = (name) => {
    const now = performance.now();
    stages.push({ name, ms: now - previous, sqlStatements: sql.statements - previousStatements });
    previous = now;
    previousStatements = sql.statements;
  };
  const result = await launchSql.run(sql, () =>
    work({
      checkpoint,
      launched: (sandbox) => {
        if (sandbox.provider === "modal") sandboxId = sandbox.id;
      },
    }),
  );
  if (sandboxId) {
    checkpoint(finalPhase);
    try {
      console.info(
        JSON.stringify({
          event: "modal_golden_launch_timing",
          surface,
          sandboxId,
          totalMs: previous - started,
          sqlStatements: previousStatements,
          stages,
        }),
      );
    } catch {
      return result;
    }
  }
  return result;
}

/** Includes pool queue and database round trip, but never SQL text or parameters. */
export function measureSqlQuery<T>(work: () => Promise<T>): Promise<T> {
  const launch = launchSql.getStore();
  if (launch) launch.statements++;
  return measureRequestPhase(current.getStore(), "sql", work);
}

/** Time waiting for a reserved client, including initial connection setup when cold. */
export function measureDbAcquire<T>(work: () => Promise<T>): Promise<T> {
  return measureRequestPhase(current.getStore(), "db_acquire", work);
}
