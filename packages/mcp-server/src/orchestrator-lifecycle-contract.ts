import type { Harness, Sql } from "@armada/core/server";

/** Structural projection of actual #661 OrchestratorAuthority.admit. Never a user Caller. */
export interface ChildAuthority {
  admit<T>(
    token: string,
    request: {
      method: string;
      childId?: string;
      goldenId?: string;
      harness?: Harness;
      credentialId?: string;
      credentialVersion?: number;
    },
    reserve: (
      sql: Sql,
      principal: {
        kind: "orchestrator";
        orchestratorId: string;
        ownerId: string;
        orgId: string;
        role: "admin" | "member";
      },
    ) => Promise<T>,
  ): Promise<T>;
}

export interface OrchestratorMachine {
  orchestratorId: string;
  sandboxId: string;
  providerSandboxId: string;
  /** SQL activity CAS, NEVER the native provider generation or broker epoch binding. */
  generation: string;
  /** Captured from trusted Provider.get; absent until the initial observation. */
  physicalGeneration?: string | null;
}
export interface RuntimeObservation extends OrchestratorMachine {
  physicalGeneration: string | null;
  state: "active" | "quiescent" | "unknown";
  /** Trusted runtime event/checkpoint identity, never a log heartbeat or arbitrary URL. */
  evidence: string;
}

/** #662 must implement against its actual native runtime, not capability flags.
 * Stop must close admissions, revoke and compare-scrub before checkpoint/provider I/O.
 * Result publication remains generation/lease fenced by this lifecycle worker. */
export interface LifecycleStopReceipt extends OrchestratorMachine {
  physicalGeneration: string | null;
  operationId: string;
  state: "stopped" | "uncertain" | "interrupted";
  continuity: "native" | "unverified" | "lost";
}
export interface OrchestratorLifecycleRuntime {
  observe(machine: OrchestratorMachine, signal?: AbortSignal): Promise<RuntimeObservation>;
  stop(
    machine: OrchestratorMachine,
    reason: "idle" | "hard_ttl" | "epoch_expiry" | "owner_removed",
    operationId: string,
    signal?: AbortSignal,
  ): Promise<LifecycleStopReceipt>;
  /** Read-only reconciliation of the same operation; MUST NOT replay stop or allocate. */
  reconcileStop(machine: OrchestratorMachine, operationId: string, signal?: AbortSignal): Promise<LifecycleStopReceipt>;
}

export function sameMachine(a: OrchestratorMachine, b: OrchestratorMachine): boolean {
  return (
    a.orchestratorId === b.orchestratorId &&
    a.sandboxId === b.sandboxId &&
    a.providerSandboxId === b.providerSandboxId &&
    a.generation === b.generation &&
    (a.physicalGeneration === undefined || a.physicalGeneration === b.physicalGeneration)
  );
}

/** Database time by default; injection is trusted server composition only, never an API field. */
export async function lifecycleNow(sql: Sql, clock?: () => Date): Promise<Date> {
  if (clock) {
    const now = clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid lifecycle clock.");
    return now;
  }
  const row = (await sql.query<{ now: Date | string }>("select clock_timestamp() as now")).rows[0];
  if (!row) throw new Error("Lifecycle clock unavailable.");
  return new Date(row.now);
}

/** Safe owned service errors: public routes emit only code, never arbitrary provider/error text. */
export class OrchestratorLifecycleError extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "not_found" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
