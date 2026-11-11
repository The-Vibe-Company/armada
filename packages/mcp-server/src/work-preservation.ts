import {
  decryptSecret,
  encryptSecret,
  type Provider,
  ProviderError,
  preserveWork,
  type Sql,
  workPreservationError,
} from "@armada/core/server";

function closedFailure(stage: string, reason: string, diagnostic?: ReturnType<typeof workPreservationError>): string {
  return `${stage}_${reason}${diagnostic ? `_${diagnostic.errorClass === reason ? "" : `${diagnostic.errorClass}_`}${diagnostic.providerStatus === null ? "no_status" : `http_${diagnostic.providerStatus}`}` : ""}`;
}
function failureNote(reason: string): string {
  return `unpushed work could not be preserved (${reason}). Resume the sandbox and push or copy any local work before stopping again.`;
}

type StopSource = "user_stop" | "lifecycle_stop" | "managed_child_stop" | "unspecified";
/** Mark dispatch at the caller, separately from Boat's beforeStop hook/API boundary. */
export function recordStopDispatch(sandboxId: string, providerSandboxId: string, source: StopSource): void {
  try {
    console.info(JSON.stringify({ event: "sandbox_stop_dispatch", sandboxId, providerSandboxId, source }));
  } catch {
    /* Diagnostics only. */
  }
}

/** Never return command output or SDK errors: archives may contain credentials. */
export async function preserveBeforeStop(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  source: StopSource = "unspecified",
): Promise<"pending" | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const controller = new AbortController();
  const progress = { stage: "observe", workAtRisk: false };
  try {
    return await Promise.race([
      captureAndStore(sql, provider, id, providerId, () => expired, progress, controller.signal, source),
      new Promise<"pending" | void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          const diagnostic = { errorClass: "timeout", providerStatus: null };
          const reason = closedFailure(progress.stage, "timeout", diagnostic);
          const pending = ["observe", "quiesce"].includes(progress.stage);
          console.warn(
            JSON.stringify({
              event: pending ? "work_preservation_deferred" : "work_preservation_failed",
              sandboxId: id,
              stage: progress.stage,
              reason,
              workRisk: progress.workAtRisk ? "confirmed" : "unknown",
              ...diagnostic,
            }),
          );
          if (pending) {
            resolve("pending");
            return;
          }
          void sql
            .query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [
              id,
              progress.workAtRisk ? failureNote(`${progress.stage}_timeout`) : null,
            ])
            .catch(() => {});
          resolve();
        }, 20_000);
      }),
    ]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

async function captureAndStore(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  expired: () => boolean,
  progress: { stage: string; workAtRisk: boolean },
  signal: AbortSignal,
  source: StopSource,
): Promise<"pending" | void> {
  let reason = "failed";
  let stage = "observe";
  let diagnostic: ReturnType<typeof workPreservationError> | undefined;
  let note: string | null;
  const observed = (phase: string, state?: string) => {
    try {
      console.info(
        JSON.stringify({
          event: "work_preservation_stage",
          sandboxId: id,
          providerSandboxId: providerId,
          phase,
          source,
          ...(state
            ? {
                state: ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"].includes(state)
                  ? state
                  : "unrecognized",
              }
            : {}),
        }),
      );
    } catch {
      /* Logging cannot change stop ordering. */
    }
  };
  try {
    // Exec may implicitly resume retained compute. Never activate a machine known stopped.
    const current = await provider.get(providerId);
    if (expired()) return;
    observed("observed", current.state);
    if (["stopped", "deleted"].includes(current.state) || current.physicalExitConfirmed) return;
    // Native runtimes acknowledge interrupt only after active turns settle.
    // The stop activity lease prevents new Armada turns during capture.
    stage = progress.stage = "quiesce";
    reason = "failed";
    observed("quiesce_started");
    await (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: providerId });
    if (expired()) return;
    observed("quiesce_finished");
    stage = progress.stage = "capture";
    reason = "failed";
    observed("capture_started");
    const result = await preserveWork(provider, providerId, signal, () => {
      progress.workAtRisk = true;
    });
    if (expired()) return;
    observed(`capture_${result.status}`);
    if (result.status === "preserved") {
      progress.workAtRisk = true;
      stage = progress.stage = "storage";
      reason = "failed";
      const encrypted = await encryptSecret(result.archive);
      if (expired()) return;
      const recoveryId = crypto.randomUUID();
      await sql.query(
        `insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc) values($1::uuid,$2::uuid,$3::bytea)`,
        [recoveryId, id, encrypted],
      );
      note = `unpushed work preserved at work_recovery:${id}/${recoveryId}`;
    } else if (result.status === "clean") {
      stage = progress.stage = "storage";
      reason = "failed";
      // A clean stop has no current work at risk; historical archives remain retrievable.
      await sql.query("update public.sandboxes set preservation_note=null where id=$1::uuid", [id]);
      return;
    } else {
      reason = result.reason;
      if (result.diagnostic) {
        stage = result.diagnostic.stage;
        diagnostic = result.diagnostic;
      }
      progress.workAtRisk = result.workAtRisk === true;
      note = progress.workAtRisk ? failureNote(`${stage}_${reason}`) : null;
      reason = closedFailure(stage, reason, diagnostic);
    }
  } catch (error) {
    if (
      stage === "quiesce" &&
      error instanceof ProviderError &&
      error.code === "sandbox_not_ready" &&
      error.retryable
    ) {
      // Interruption is accepted but not yet settled. Keep the stop request queued:
      // the lifecycle worker retries quiescence and capture before stopping compute.
      if (expired()) return "pending";
      return "pending";
    }
    diagnostic = workPreservationError(error);
    note = progress.workAtRisk ? failureNote(`${stage}_failed`) : null;
    reason = closedFailure(stage, reason, diagnostic);
  }
  if (expired()) return;
  if (!note?.startsWith("unpushed work preserved"))
    console.warn(
      JSON.stringify({
        event: "work_preservation_failed",
        sandboxId: id,
        stage,
        reason,
        workRisk: progress.workAtRisk ? "confirmed" : "unknown",
        ...diagnostic,
      }),
    );
  try {
    await sql.query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [id, note]);
  } catch (error) {
    if (!expired() && note?.startsWith("unpushed work preserved"))
      console.warn(
        JSON.stringify({
          event: "work_preservation_failed",
          sandboxId: id,
          stage: "receipt",
          reason: closedFailure("receipt", "storage", workPreservationError(error)),
          ...workPreservationError(error),
        }),
      );
  }
}

export async function readWorkRecovery(sql: Sql, id: string, recoveryId?: string): Promise<string | null> {
  const row = (
    await sql.query<{ archive_enc: Uint8Array<ArrayBuffer> }>(
      "select archive_enc from public.sandbox_work_recovery where sandbox_id=$1::uuid and ($2::uuid is null or id=$2::uuid) order by created_at desc limit 1",
      [id, recoveryId ?? null],
    )
  ).rows[0];
  return row ? decryptSecret(row.archive_enc) : null;
}
