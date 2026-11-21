import {
  decryptSecret,
  encryptSecret,
  HOST_CAPABILITIES,
  type Provider,
  ProviderError,
  preserveWork,
  SANDBOX_STATES,
  type Sql,
  type WorkPreservation,
  workPreservationError,
} from "@armada/core/server";
import type { RuntimeWorkProvider } from "./runtime-provider.ts";
import {
  COMPLETE_PRESERVATION,
  lockedNativePreservationWriter,
  NOTE_FENCE,
  recordCleanWork,
  recordWorkRecovery,
  STOP_EPOCH,
  type StopFence,
  WORK_STOP_OWNER,
  writePreservationNote,
} from "./sandbox-lifecycle.ts";
import { captureFinalOutputs, recordOutputFailure } from "./sandbox-outputs.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

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

export type StopAuthority = {
  kind: "activity" | "reconcile";
  token: string;
  generation: number | undefined;
  signal?: AbortSignal | undefined;
};

const NO_EXTRA_FENCE: StopFence = [null, null, null, null, null];

/** Runtime preservation policy records acknowledged journal evidence, never a Git archive. */
export async function runtimePreservationNote(sql: Sql, id: string): Promise<string> {
  const checkpoint = (
    await sql.query<{ epoch: string; watermark: string }>(
      `select p.epoch::text,p.watermark::text from public.runtime_checkpoints p
    join public.runtime_enrolments r on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch
    where p.sandbox_id=$1 and p.watermark is not null
    and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events e where e.sandbox_id=p.sandbox_id)`,
      [id],
    )
  ).rows[0];
  return checkpoint
    ? `Armada runtime checkpoint acknowledged for epoch ${checkpoint.epoch} through event ${checkpoint.watermark}; disk retention requires confirmed host stop. No Git work archive is claimed.`
    : "Experimental runtime stop: no acknowledged runtime checkpoint; resume and Git work preservation are unavailable.";
}

type StopSource = "user_stop" | "lifecycle_stop" | "managed_child_stop" | "unspecified";
/** Mark dispatch at the caller, separately from Boat's beforeStop hook/API boundary. */
export async function stopAndObserve(
  provider: Provider,
  sandboxId: string,
  providerSandboxId: string,
  source: StopSource,
  signal: AbortSignal,
  requireRetention = false,
) {
  if (provider.id === "boat") {
    const archived = await provider.get(providerSandboxId);
    signal.throwIfAborted();
    if (archived.state === "stopped") return archived;
  }
  recordStopDispatch(sandboxId, providerSandboxId, source);
  await provider.stop({ sandboxId: providerSandboxId, ...(requireRetention ? { requireRetention } : {}) });
  signal.throwIfAborted();
  return provider.get(providerSandboxId);
}

export function recordStopDispatch(sandboxId: string, providerSandboxId: string, source: StopSource): void {
  try {
    console.info(JSON.stringify({ event: "sandbox_stop_dispatch", sandboxId, providerSandboxId, source }));
  } catch {
    /* Diagnostics only. */
  }
}

/** Never return command output or SDK errors: archives may contain credentials.
 * Every stop admission runs this before provider stop, so it also takes the final
 * declared-output snapshot while compute is still active (after quiesce). */
export async function preserveBeforeStop(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  source: StopSource = "unspecified",
  authority?: StopAuthority,
): Promise<"pending" | void> {
  const started = Date.now();
  const progress: CaptureProgress = {
    receiptWriter: sql,
    stage: "observe",
    workAtRisk: false,
    checkedClean: false,
    deferOnFailure: false,
    writingReceipt: false,
    stopToken: null,
    fence: NO_EXTRA_FENCE,
  };
  const ownsStop = async () => {
    if (progress.fence[0] === null) return true;
    try {
      const owned = await sql.query(`select id from public.sandboxes where ${STOP_EPOCH}`, [
        id,
        ...progress.fence,
        progress.stopToken,
      ]);
      return owned.rows.length > 0;
    } catch {
      return false;
    }
  };
  let outcome: "pending" | void;
  try {
    outcome = await preserveGitWork(sql, provider, id, providerId, progress, source, authority);
  } catch (error) {
    if (!authority?.signal?.aborted && (await ownsStop())) await finalOutputs(sql, provider, id, started);
    throw error;
  }
  // A pending stop retries later; its final capture runs on that pass.
  if (outcome === "pending" || authority?.signal?.aborted || !(await ownsStop())) return "pending";
  await finalOutputs(sql, provider, id, started);
  if (!(await ownsStop())) return "pending";
}

/** Git preservation and final output capture share one pre-stop budget so callers'
 * per-item deadlines (30 s lifecycle worker) still reach provider stop dispatch. */
const PRE_STOP_BUDGET_MS = 22_000;
const FINAL_OUTPUT_MAX_MS = 12_000;

async function finalOutputs(sql: Sql, provider: Provider, id: string, started: number): Promise<void> {
  const remaining = Math.min(FINAL_OUTPUT_MAX_MS, PRE_STOP_BUDGET_MS - (Date.now() - started));
  if (remaining < 1_000) {
    void recordOutputFailure(sql, id, "sandbox_output_final_capture_skipped", "pre_stop_budget_exhausted").catch(
      () => {},
    );
    return;
  }
  try {
    await captureFinalOutputs(sql, provider, id, { signal: AbortSignal.timeout(remaining) });
  } catch {
    // The previous snapshot stays readable; never block a stop on optional deliverables.
  }
}

async function preserveGitWork(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  progress: CaptureProgress,
  source: StopSource = "unspecified",
  authority?: StopAuthority,
): Promise<"pending" | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const controller = new AbortController();
  const signal = authority?.signal ? AbortSignal.any([controller.signal, authority.signal]) : controller.signal;
  try {
    return await Promise.race([
      captureAndStore(
        sql,
        provider,
        id,
        providerId,
        () => expired || signal.aborted,
        progress,
        signal,
        source,
        authority,
      ),
      new Promise<"pending" | void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          if (authority?.signal?.aborted) return resolve("pending");
          const diagnostic = { errorClass: "timeout", providerStatus: null };
          const reason = closedFailure(progress.stage, "timeout", diagnostic);
          const pending =
            progress.checkedClean || ["observe", "quiesce"].includes(progress.stage) || pendingOnFailure(progress);
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
          void writePreservationNote(
            progress.receiptWriter,
            id,
            progress.workAtRisk
              ? failureNote(`${progress.stage}_timeout`)
              : progress.checkedClean
                ? null
                : unknownNote(`${progress.stage}_timeout`),
            progress.stopToken,
            progress.fence,
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

function pendingOnFailure(progress: CaptureProgress) {
  return progress.deferOnFailure || (progress.fence[0] !== null && progress.writingReceipt);
}

type CaptureProgress = {
  receiptWriter: Sql;
  stage: string;
  workAtRisk: boolean;
  checkedClean: boolean;
  deferOnFailure: boolean;
  writingReceipt: boolean;
  stopToken: string | null;
  fence: StopFence;
};

async function captureAndStore(
  sql: Sql,
  provider: RuntimeWorkProvider,
  id: string,
  providerId: string,
  expired: () => boolean,
  progress: CaptureProgress,
  signal: AbortSignal,
  source: StopSource,
  authority?: StopAuthority,
): Promise<"pending" | void> {
  let reason = "failed";
  let stage = "observe";
  let diagnostic: ReturnType<typeof workPreservationError> | undefined;
  let note: string | null;
  let stopLoaded = false;
  let defer = false;
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
      await sql.query<{
        stop_token: string | null;
        complete: boolean;
        application_secret_tainted: boolean;
        boat_runtime: boolean;
        modal_runtime: boolean;
        work_stop_owned: boolean | null;
      }>(
        `select boat_runtime,application_secret_tainted,
        (provider='modal' and runtime_transport='dialout') as modal_runtime,
        (${WORK_STOP_OWNER}) as work_stop_owned, case when stop_requested_at is null then null else stop_generation::text end as stop_token,
        (${COMPLETE_PRESERVATION}) as complete
       from public.sandboxes where id=$1::uuid`,
        [id, providerId, authority?.token ?? null, authority?.generation ?? null, authority?.kind ?? null, provider.id],
      )
    ).rows[0];
    if (expired()) return;
    if (!stop) return "pending";
    stopLoaded = true;
    if (stop.modal_runtime || (!stop.boat_runtime && (authority || stop.stop_token !== null))) {
      if (!stop.work_stop_owned || !authority) return "pending";
      progress.deferOnFailure = stop.modal_runtime;
      if (!stop.modal_runtime) progress.receiptWriter = lockedNativePreservationWriter(sql, id);
      progress.fence = [providerId, authority.token, authority.generation ?? null, authority.kind, provider.id];
    }
    progress.stopToken = stop.stop_token;
    if (stop.application_secret_tainted) {
      await writePreservationNote(
        progress.receiptWriter,
        id,
        "Unpushed work was not preserved: application-secret exposure forbids archives and disk reuse; resume and recovery are unavailable.",
        stop.stop_token,
        progress.fence,
      );
      return;
    }
    if (stop.boat_runtime) {
      await writePreservationNote(sql, id, await runtimePreservationNote(sql, id), stop.stop_token, progress.fence);
      return;
    }
    if (stop.complete) {
      observed("capture_reused");
      return;
    }
    // Exec may implicitly resume retained compute. Never activate a machine known stopped.
    const current = await provider.get(providerId, { signal });
    if (expired()) return;
    observed("observed", current.state);
    if (["stopped", "deleted"].includes(current.state) || current.physicalExitConfirmed) return;
    if (stop.modal_runtime) {
      if (
        HOST_CAPABILITIES.modal.fencedStopPhases.includes(current.providerState) ||
        ["reserved", "restoring", "creating", "booting"].includes(current.providerState)
      )
        return;
    }
    const ownsCapture = async () => {
      if (progress.fence[0] === null) return true;
      try {
        const owned = await sql.query(
          `select id from public.sandboxes where ${NOTE_FENCE} and not application_secret_tainted`,
          [id, ...progress.fence, progress.stopToken],
        );
        return !expired() && owned.rows.length > 0;
      } catch {
        return false;
      }
    };
    if (!(await ownsCapture())) return "pending";
    if (!stop.modal_runtime) {
      // Native runtimes acknowledge interrupt only after active turns settle.
      stage = progress.stage = "quiesce";
      observed("quiesce_started");
      await (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: providerId });
      if (expired() || !(await ownsCapture())) return "pending";
      observed("quiesce_finished");
    }
    stage = progress.stage = stop.modal_runtime ? "quiesce" : "capture";
    observed("capture_started");
    const context = { source, captureId: crypto.randomUUID() };
    const onWorkAtRisk = () => {
      progress.workAtRisk = true;
    };
    let result: WorkPreservation;
    if (stop.modal_runtime) {
      if (!provider.captureRuntimeWork || !current.physicalGeneration || current.id !== providerId)
        throw new ProviderError({
          provider: provider.id,
          code: "sandbox_not_ready",
          message: "No bound runtime work collector for this physical generation.",
          retryable: false,
        });
      result = await provider.captureRuntimeWork({
        sandboxId: providerId,
        physicalGeneration: current.physicalGeneration,
        signal,
        context,
        onWorkAtRisk,
      });
    } else {
      result = await preserveWork(provider, providerId, signal, onWorkAtRisk, context);
    }
    if (expired()) return;
    stage = progress.stage = "capture";
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
      progress.writingReceipt = true;
      const saved = await recordWorkRecovery(
        progress.receiptWriter,
        id,
        progress.fence,
        progress.stopToken,
        note,
        recoveryId,
        encrypted,
      );
      if (!saved.rows.length) return "pending";
      observed("capture_committed");
      return;
    } else if (result.status === "clean") {
      progress.checkedClean = true;
      stage = progress.stage = "storage";
      reason = "failed";
      // Clean success is also durable: NULL note alone is not a receipt.
      const saved = await recordCleanWork(progress.receiptWriter, id, progress.fence, progress.stopToken);
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
    defer = pendingOnFailure(progress);
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
        event: defer ? "work_preservation_deferred" : "work_preservation_failed",
        sandboxId: id,
        stage,
        reason,
        workRisk: progress.workAtRisk ? "confirmed" : progress.checkedClean ? "clean" : "unknown",
        ...diagnostic,
      }),
    );
  try {
    await writePreservationNote(progress.receiptWriter, id, note, progress.stopToken, progress.fence);
  } catch (error) {
    defer ||= progress.deferOnFailure;
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
  if (progress.checkedClean || defer) return "pending";
}

export async function purgeWorkRecovery(sql: Sql, id: string) {
  await sql.query("delete from public.sandbox_work_recovery where sandbox_id=$1", [id]);
}

export async function readWorkRecovery(
  sql: Sql,
  scope: [string[], string],
  id: string,
  recoveryId?: string,
): Promise<string | null | undefined> {
  const row = (
    await sql.query<{ archive_enc: Uint8Array<ArrayBuffer> | null }>(
      `with visible as (
         select s.id, s.org_id, s.owner_id, s.application_secret_tainted,
           (s.status='deleted' and s.provider in ('boat','modal')
           and not s.boat_runtime and s.runtime_transport is distinct from 'dialout') as detached
         from public.sandboxes s join public.goldens g on g.id=s.golden_id
         where s.id=$3::uuid and ${SANDBOX_VISIBLE}
       )
       select recovery.archive_enc
       from visible s
       left join lateral (
         select r.archive_enc, r.created_at, r.id
         from public.sandbox_work_recovery r
         where not s.detached and not s.application_secret_tainted
           and r.sandbox_id=s.id and ($4::uuid is null or r.id=$4)
         union all
         select r.archive_enc, r.created_at, r.archive_id
         from public.native_drain_recovery r
         where s.detached and not s.application_secret_tainted
           and r.sandbox_id=s.id and r.org_id=s.org_id and r.owner_id=s.owner_id
           and ($4::uuid is null or r.archive_id=$4)
         order by created_at desc, id desc limit 1
       ) recovery on true`,
      [...scope, id, recoveryId ?? null],
    )
  ).rows[0];
  if (!row) return undefined;
  return row.archive_enc ? decryptSecret(row.archive_enc) : null;
}
