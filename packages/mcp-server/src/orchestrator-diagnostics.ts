import {
  GoldenError,
  LAUNCH_FAILURE_REASONS,
  LAUNCH_INITIALIZATION_STAGES,
  LaunchError,
  OrchestratorAuthorityDenied,
  ProviderError,
  VaultError,
} from "@armada/core/server";

import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

export type OrchestratorDiagnosticLog = (line: string) => void;
const STAGES = [
  ...LAUNCH_INITIALIZATION_STAGES,
  "create_reconciliation",
  "recovery_reservation",
  "recovery_dispatch",
  "recovery_observation",
  "recovery_validation",
  "recovery_publication",
  "authorization",
  "request_lookup",
  "identity_read",
  "backend_resolution",
  "native_prerequisites",
  "reservation",
  "revalidation",
  "launcher_preflight",
  "launcher_schema",
  "launcher_configuration",
  "credential_resolution",
  "credential_admission",
  "fork",
  "registration",
  "initialization",
  "native_hydration",
  "preparing",
  "skills",
  "epoch_revalidation",
  "epoch_transport",
  "epoch_install",
  "native_admission",
  "message",
  "steer",
  "authority_revoke",
  "native_resume",
  "resume_validation",
  "stop_dispatch",
  "native_observation",
  "generation_binding",
  "native_quiesce",
  "stop_revalidation",
  "epoch_scrub",
  "native_checkpoint",
  "stop_validation",
  "stop_receipt_publication",
  "stop_reconcile",
  "history_recovery",
  "completion",
  "failure_publication",
  "lifecycle_publication",
  "lifecycle_interruption",
] as const;
export type OrchestratorDiagnosticStage = (typeof STAGES)[number];

const REASONS = [
  "create_worker_interrupted",
  "create_authority_revoked",
  "recorded_operation_uncertain",
  "recorded_operation_failed",
  "unexpected_error",
  "publication_fence_rejected",
  "native_continuity_lost",
  "native_stop_unconfirmed",
  "stop_receipt_mismatch",
  "stop_receipt_missing",
  "lifecycle_hard_ttl",
  "lifecycle_epoch_expiry",
  "lifecycle_owner_removed",
  "lifecycle_idle",
  "skill_configuration_invalid",
  "skill_command_missing",
  "skill_install_nonzero",
  "skill_install_timeout",
  "skill_execution_detached",
  "skill_output_truncated",
  "skill_provenance_missing",
] as const;
type LiteralReason = (typeof REASONS)[number];

const CODES = new Set([
  "not_found",
  "conflict",
  "unavailable",
  "invalid_request",
  "forbidden",
  "invalid",
  "missing_credential",
  "credential_binding_required",
  "credential_binding_unsafe",
  "no_credentials",
  "unauthorized",
  "payment_required",
  "provider_not_configured",
  "sandbox_not_ready",
  "rate_limited",
  "unsupported",
  "quota_exceeded",
  "invalid_config",
  "start_failed",
  "init_failed",
  "setup_failed",
  "snapshot_failed",
  "build_failed",
  "not_ready",
  "prompt_failed",
  "unknown",
  "no_running_turn",
  "timeout",
  "capacity",
]);
const MODAL_BOOT_CODES = new Set([
  "modal_checkpoint_identity",
  "modal_checkpoint_runner",
  "modal_checkpoint_scrub",
  "modal_checkpoint_snapshot",
  "modal_checkpoint_terminate",
  "modal_checkpoint_observation",
  "modal_checkpoint_receipt",
  "modal_recovery_binding",
  "modal_boot_binding",
  "modal_boot_runtime",
  "modal_boot_baseline",
  "modal_boot_fresh",
  "modal_boot_start",
  "modal_boot_health",
  "modal_boot_active_publication",
]);
const SQL_CODES: Readonly<Record<string, string>> = {
  "22P02": "sql_invalid_text",
  "22003": "sql_numeric_range",
  "22023": "sql_invalid_parameter",
  "42601": "sql_syntax",
  "42804": "sql_type_mismatch",
  "42883": "sql_operator_missing",
  "42P08": "sql_ambiguous_parameter",
  "42P18": "sql_indeterminate_type",
  P0001: "sql_raise_exception",
  "23502": "sql_not_null",
  "23503": "sql_foreign_key",
  "23505": "sql_unique",
  "23514": "sql_check",
  "40001": "sql_serialization",
  "40P01": "sql_deadlock",
  "42501": "sql_permission",
  "42703": "sql_column_missing",
  "42P01": "sql_relation_missing",
  "08000": "sql_connection",
  "08003": "sql_connection",
  "08006": "sql_connection",
  "53300": "sql_connections_exhausted",
  "57014": "sql_cancelled",
  "57P01": "sql_shutdown",
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTIONS = new Set(["create", "message", "steer", "stop", "resume", "recover"]);

/** Closed metadata only: no exception message, SQL text, detail, hint or causal traversal. */
function publicationFailure(error: unknown): {
  errorClass: string;
  sqlState?: string;
  table?: string;
  constraint?: string;
} {
  let errorClass = "unknown";
  let sqlState: string | undefined;
  if (error && typeof error === "object") {
    try {
      const name: unknown = Reflect.get(error, "name");
      if (
        typeof name === "string" &&
        [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "ReferenceError",
          "PostgresError",
          "DatabaseError",
          "ProviderError",
          "OrchestratorRuntimeError",
        ].includes(name)
      )
        errorClass = name;
    } catch {
      /* A hostile class getter must not hide an independently readable SQLSTATE. */
    }
    // Bun's PostgresError uses code=ERR_POSTGRES_SERVER_ERROR and errno=SQLSTATE.
    // Other drivers use code directly. Read each independently; never serialize the exception.
    for (const field of ["code", "errno"] as const) {
      try {
        const code: unknown = Reflect.get(error, field);
        if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
          sqlState = code;
          break;
        }
      } catch {
        /* A hostile getter cannot hide independently readable metadata. */
      }
    }
  }
  const identifiers: { table?: string; constraint?: string } = {};
  for (const field of ["table", "constraint"] as const) {
    try {
      const value: unknown = error && typeof error === "object" ? Reflect.get(error, field) : undefined;
      if (typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value)) identifiers[field] = value;
    } catch {
      /* A diagnostic getter cannot change publication. */
    }
  }
  return { errorClass, ...(sqlState ? { sqlState } : {}), ...identifiers };
}

/** No message, stack, details, request, provider ID, config, or causal payload is read.
 * Untrusted error codes are projected through closed allowlists, not sanitized strings. */
function baseReason(error: unknown): string {
  try {
    if (error instanceof OrchestratorAuthorityDenied) return "authority_denied";
    if (!error || typeof error !== "object") return "unexpected_error";
    // Read once: a hostile/mutable getter must not swap a whitelisted code for a secret.
    const code: unknown = Reflect.get(error, "code");
    if (typeof code !== "string") return "unexpected_error";
    const family =
      error instanceof ProviderError
        ? "provider"
        : error instanceof VaultError
          ? "credential"
          : error instanceof GoldenError
            ? "golden"
            : error instanceof LaunchError
              ? "launcher"
              : error instanceof OrchestratorRuntimeError
                ? "runtime"
                : undefined;
    if (family && CODES.has(code)) {
      if (family === "provider") {
        // Only closed provider-owned boot labels, never arbitrary SDK diagnostics.
        try {
          const boot: unknown = Reflect.get(error, "providerCode");
          if (typeof boot === "string" && MODAL_BOOT_CODES.has(boot)) {
            const failure = error instanceof ProviderError ? error.details?.modalFailure : undefined;
            const suffix =
              typeof failure === "string" &&
              [
                "process_quiescence_failed",
                "process_baseline_missing",
                "ssh_cleanup_failed",
                "managed_state_busy",
                "AuthError",
                "NotFoundError",
                "AlreadyExistsError",
                "InvalidError",
                "PermissionDeniedError",
                "ResourceExhaustedError",
                "TimeoutError",
                "SandboxTimeoutError",
                "unknown",
                "grpc",
              ].includes(failure)
                ? failure
                : "armada_refusal";
            const status = error instanceof ProviderError ? error.status : undefined;
            return `${family}_${code}_${boot}_${suffix}${typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 16 ? `_grpc_${status}` : ""}`;
          }
        } catch {
          /* Preserve the normalized code even for a hostile getter. */
        }
      }
      return `${family}_${code}`;
    }
    if (Object.hasOwn(SQL_CODES, code)) return SQL_CODES[code]!;
  } catch {
    /* Hostile getters and logger failures never become operation failures. */
  }
  return "unexpected_error";
}

// Only trusted LaunchError data properties are unwrapped. Never evaluate a
// causal getter, stringify an error, or walk opaque SDK/private payloads.
function reason(error: unknown): string {
  const base = baseReason(error);
  try {
    if (!(error instanceof LaunchError)) return base;
    const seen = new Set<unknown>([error]);
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof LaunchError; depth++) {
      const safe = Object.getOwnPropertyDescriptor(current, "safeReason");
      if (
        safe &&
        "value" in safe &&
        typeof safe.value === "string" &&
        (LAUNCH_FAILURE_REASONS as readonly string[]).includes(safe.value)
      )
        return `${base}_${safe.value}`;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (!cause || !("value" in cause) || seen.has(cause.value)) break;
      current = cause.value;
      seen.add(current);
      if (!(current instanceof LaunchError)) {
        const underlying = baseReason(current);
        if (underlying !== "unexpected_error") return `${base}_caused_by_${underlying}`;
      }
    }
  } catch {
    /* Diagnostics must not activate hostile descriptor/proxy failures. */
  }
  return base;
}

/** The provider transports only closed process categories and survivor classifications. */
function processFailure(error: unknown): Record<string, string | number | boolean> {
  try {
    if (!(error instanceof ProviderError)) return {};
    const details: unknown = error.details;
    const read = (field: string): unknown => {
      try {
        return details && typeof details === "object" ? Reflect.get(details, field) : undefined;
      } catch {
        // One hostile field must not suppress independently readable classifications.
        return undefined;
      }
    };
    const category = read("processCategory");
    if (
      typeof category !== "string" ||
      !["unknown", "codex", "runtime_or_mcp", "privileged_writer", "user_writer"].includes(category)
    )
      return {};
    const result: Record<string, string | number | boolean> = { processCategory: category };
    const classes = ["armada_runner", "codex", "claude", "bun", "node", "ssh", "other", "unreadable"];
    const allowed: Record<string, readonly string[]> = {
      processFailure: ["pidfd_open", "pidfd_signal", "identity_changed", "unproven"],
      processUidClass: ["root", "user", "unknown"],
      processCommClass: classes,
      processExeClass: classes,
      processRole: [
        "pid1",
        "scrub_ancestor",
        "baseline_control",
        "platform_control_child",
        "armada_launcher",
        "kernel_control",
        "armada_runner",
        "harness",
        "writer",
      ],
      processStateClass: ["running", "stopped", "blocked", "unknown"],
      processManagedState: ["managed", "outside", "unreadable"],
    };
    for (const [field, values] of Object.entries(allowed)) {
      const value = read(field);
      if (typeof value === "string" && values.includes(value)) result[field] = value;
    }
    for (const field of ["processIsAncestor", "processIsPid1"]) {
      const value = read(field);
      if (typeof value === "boolean") result[field] = value;
    }
    const count = read("processSurvivorCount");
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= 4096)
      result.processSurvivorCount = count;
    const inspection = read("processInspection");
    if (
      typeof inspection === "string" &&
      /^(self_namespace|proc_stat|proc_status|proc_comm|proc_exe|proc_cmdline|proc_cwd|proc_fds|pidfd_open|pidfd_signal|kill)_(EPERM|EACCES|ENOSYS|EOPNOTSUPP|EINVAL|ENOENT|other)$/.test(
        inspection,
      )
    )
      result.processInspection = inspection;
    return result;
  } catch {
    return {};
  }
}

/** Per-operation state, not global mutable tracing. Keep only a safe classification
 * of the first failed substep, so a finally/cleanup step cannot hide its cause. */
export class OrchestratorDiagnostics {
  private current: OrchestratorDiagnosticStage = "authorization";
  private failure: { stage: OrchestratorDiagnosticStage; reason: string } | undefined;
  private reported = false;
  private operationId: string | undefined;
  private orchestratorId: string | undefined;
  private sandboxId: string | undefined;
  constructor(
    private readonly log: OrchestratorDiagnosticLog | undefined,
    private readonly action: string,
    private readonly component: "owner" | "managed" | "lifecycle" = "owner",
  ) {}
  bind(input: { operationId?: string; orchestratorId?: string; sandboxId?: string | null }): void {
    if (input.operationId && UUID.test(input.operationId)) this.operationId = input.operationId;
    if (input.orchestratorId && UUID.test(input.orchestratorId)) this.orchestratorId = input.orchestratorId;
    if (input.sandboxId && UUID.test(input.sandboxId)) this.sandboxId = input.sandboxId;
  }
  stage(stage: OrchestratorDiagnosticStage): void {
    if ((STAGES as readonly string[]).includes(stage)) this.current = stage;
  }
  capture(error: unknown): void {
    this.failure ??= { stage: this.current, reason: reason(error) };
  }
  captureReason(code: LiteralReason): void {
    this.failure ??= {
      stage: this.current,
      reason: (REASONS as readonly string[]).includes(code) ? code : "unexpected_error",
    };
  }
  report(
    outcome: "error" | "uncertain" | "failed" | "publication_failed",
    error?: unknown,
    code?: LiteralReason,
  ): void {
    this.reported = true;
    const safeCode = code && (REASONS as readonly string[]).includes(code) ? code : undefined;
    if (outcome !== "publication_failed") this.failure ??= { stage: this.current, reason: safeCode ?? reason(error) };
    const failure = outcome === "publication_failed" ? undefined : this.failure;
    const record = {
      event: "orchestrator_operation_failure",
      component: ["owner", "managed", "lifecycle"].includes(this.component) ? this.component : "owner",
      action: ACTIONS.has(this.action) ? this.action : "unknown",
      outcome,
      stage: failure?.stage ?? this.current,
      reason: safeCode ?? failure?.reason ?? reason(error),
      ...(outcome === "publication_failed" ? publicationFailure(error) : {}),
      ...processFailure(error),
      ...(outcome === "publication_failed" && this.failure
        ? { failureStage: this.failure.stage, failureReason: this.failure.reason }
        : {}),
      ...(this.operationId ? { operationId: this.operationId } : {}),
      ...(this.orchestratorId ? { orchestratorId: this.orchestratorId } : {}),
      ...(this.sandboxId ? { sandboxId: this.sandboxId } : {}),
    };
    try {
      void Promise.resolve(this.log?.(JSON.stringify(record))).catch(() => {});
    } catch {
      /* Best effort only. */
    }
  }
  reportIfUnreported(outcome: "uncertain" | "failed", error?: unknown, code?: LiteralReason): void {
    if (!this.reported) this.report(outcome, error, code);
  }
  reportUnhandled(error: unknown): void {
    if (!this.reported) this.report("error", error);
  }
}

/** Re-throws the exact original error; observability must not change admission,
 * cleanup, native continuity, publication or retry semantics. */
export async function diagnosticStep<T>(
  diagnostics: OrchestratorDiagnostics | undefined,
  stage: OrchestratorDiagnosticStage,
  work: () => Promise<T>,
): Promise<T> {
  diagnostics?.stage(stage);
  try {
    return await work();
  } catch (error) {
    diagnostics?.capture(error);
    throw error;
  }
}
