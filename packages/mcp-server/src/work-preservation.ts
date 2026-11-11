import {
  decryptSecret,
  encryptSecret,
  type Provider,
  ProviderError,
  preserveWork,
  SANDBOX_STATES,
  type Sql,
  workPreservationError,
} from "@armada/core/server";

function closedFailure(stage: string, reason: string, diagnostic?: ReturnType<typeof workPreservationError>): string {
  return `${stage}_${reason}${diagnostic ? `_${diagnostic.errorClass === reason ? "" : `${diagnostic.errorClass}_`}${diagnostic.providerStatus === null ? "no_status" : `http_${diagnostic.providerStatus}`}` : ""}`;
}
function failureNote(reason: string): string {
  return `unpushed work could not be preserved (${reason}). Resume the sandbox and push or copy any local work before stopping again.`;
}

function ownerReason(stage: string, reason: string, diagnostic?: ReturnType<typeof workPreservationError>): string {
  const cause =
    diagnostic?.errorClass === "provider_sandbox_not_ready"
      ? "not_ready"
      : stage.endsWith("_exec") && reason.startsWith("exec_")
        ? reason.slice(5)
        : reason;
  return `${stage}_${cause}`;
}
function unknownNote(reason: string): string {
  return `could not check for unpushed work (${reason}). If this sandbox had local work, resume it and push or copy it before stopping again.`;
}

// Fence all writes to the stop epoch observed at entry. A completed receipt wins
// over any late failure/timeout, even one whose provider request began earlier.
const NOTE_FENCE = `id=$1::uuid
  and (case when stop_requested_at is null then null else stop_generation end) is not distinct from $3::bigint
  and ($3::bigint is null or preservation_stop_generation is distinct from $3::bigint)`;
function writeNote(sql: Sql, id: string, note: string | null, stopToken: string | null) {
  return sql.query(`update public.sandboxes set preservation_note=$2 where ${NOTE_FENCE}`, [id, note, stopToken]);
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
  const progress = { stage: "observe", workAtRisk: false, checkedClean: false, stopToken: null as string | null };
  try {
    return await Promise.race([
      captureAndStore(sql, provider, id, providerId, () => expired, progress, controller.signal, source),
      new Promise<"pending" | void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          const diagnostic = { errorClass: "timeout", providerStatus: null };
          const reason = closedFailure(progress.stage, "timeout", diagnostic);
          const pending = progress.checkedClean || ["observe", "quiesce"].includes(progress.stage);
          console.warn(
            JSON.stringify({
              event: pending ? "work_preservation_deferred" : "work_preservation_failed",
              sandboxId: id,
              stage: progress.stage,
              reason,
              workRisk: progress.workAtRisk ? "confirmed" : progress.checkedClean ? "clean" : "unknown",
              ...diagnostic,
            }),
          );
          if (pending) {
            resolve("pending");
            return;
          }
          void writeNote(
            sql,
            id,
            progress.workAtRisk
              ? failureNote(`${progress.stage}_timeout`)
              : progress.checkedClean
                ? null
                : unknownNote(`${progress.stage}_timeout`),
            progress.stopToken,
          ).catch(() => {});
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
  progress: { stage: string; workAtRisk: boolean; checkedClean: boolean; stopToken: string | null },
  signal: AbortSignal,
  source: StopSource,
): Promise<"pending" | void> {
  let reason = "failed";
  let stage = "observe";
  let diagnostic: ReturnType<typeof workPreservationError> | undefined;
  let note: string | null;
  let stopLoaded = false;
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
                state: (SANDBOX_STATES as readonly string[]).includes(state) ? state : "unrecognized",
              }
            : {}),
        }),
      );
    } catch {
      /* Logging cannot change stop ordering. */
    }
  };
  try {
    const stop = (
      await sql.query<{ stop_token: string | null; complete: boolean }>(
        `select case when stop_requested_at is null then null else stop_generation::text end as stop_token,
        (stop_requested_at is not null and preservation_stop_generation is not distinct from stop_generation) as complete
       from public.sandboxes where id=$1::uuid`,
        [id],
      )
    ).rows[0];
    if (expired()) return;
    if (!stop) return "pending";
    stopLoaded = true;
    // Null is intentional for managed-child stops: their core store does not
    // create a stop generation, and their operation journal publishes stopped
    // directly (no ordinary lifecycle recapture). These one-off calls stay uncached.
    progress.stopToken = stop.stop_token;
    if (stop.complete) {
      observed("capture_reused");
      return;
    }
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
      note = `unpushed work preserved at work_recovery:${id}/${recoveryId}`;
      // Receipt and encrypted archive commit atomically. A competing successful
      // pass or a changed stop epoch cannot create/replace a recovery receipt.
      const saved = await sql.query<{ id: string }>(
        `with accepted as (
        update public.sandboxes set preservation_note=$2,preservation_stop_generation=$3::bigint
        where ${NOTE_FENCE} returning id
      ) insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc)
        select $4::uuid,id,$5::bytea from accepted returning id`,
        [id, note, progress.stopToken, recoveryId, encrypted],
      );
      if (!saved.rows.length) return "pending";
      observed("capture_committed");
      return;
    } else if (result.status === "clean") {
      progress.checkedClean = true;
      stage = progress.stage = "storage";
      reason = "failed";
      // Clean success is also durable: NULL note alone is not a receipt.
      const saved = await sql.query<{ id: string }>(
        `update public.sandboxes set preservation_note=$2::text,
        preservation_stop_generation=$3::bigint where ${NOTE_FENCE} returning id`,
        [id, null, progress.stopToken],
      );
      if (!saved.rows.length) return "pending";
      observed("capture_committed");
      return;
    } else {
      reason = result.reason;
      if (result.diagnostic) {
        stage = result.diagnostic.stage;
        diagnostic = result.diagnostic;
      }
      progress.workAtRisk = result.workAtRisk === true;
      note = progress.workAtRisk
        ? failureNote(ownerReason(stage, reason, diagnostic))
        : unknownNote(ownerReason(stage, reason, diagnostic));
      reason = closedFailure(stage, reason, diagnostic);
    }
  } catch (error) {
    if (!stopLoaded) {
      console.warn(
        JSON.stringify({
          event: "work_preservation_deferred",
          sandboxId: id,
          stage: "receipt_lookup",
          reason: "receipt_lookup_failed",
          ...workPreservationError(error),
        }),
      );
      return "pending";
    }
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
    note = progress.workAtRisk
      ? failureNote(`${stage}_failed`)
      : progress.checkedClean
        ? null
        : unknownNote(ownerReason(stage, "failed", diagnostic));
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
        workRisk: progress.workAtRisk ? "confirmed" : progress.checkedClean ? "clean" : "unknown",
        ...diagnostic,
      }),
    );
  try {
    await writeNote(sql, id, note, progress.stopToken);
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
  if (progress.checkedClean) return "pending";
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
