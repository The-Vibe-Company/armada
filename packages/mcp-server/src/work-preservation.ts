import {
  decryptSecret,
  encryptSecret,
  HOST_CAPABILITIES,
  type Provider,
  ProviderError,
  SANDBOX_STATES,
  type Sql,
  workPreservationError,
} from "@armada/core/server";
import type { RuntimeWorkProvider } from "./runtime-provider.ts";
import {
  COMPLETE_PRESERVATION,
  NOTE_FENCE,
  recordCleanWork,
  recordWorkRecovery,
  STOP_EPOCH,
  type StopFence,
  WORK_STOP_OWNER,
  writePreservationNote,
} from "./sandbox-lifecycle.ts";
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

type StopAuthority = {
  token: string;
  generation: number;
  signal: AbortSignal;
};

/** Describe journal evidence for runtime paths without physical Git capture. */
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

/** Preserve Git work under the Modal stop job claim before releasing compute. */
export async function preserveBeforeStop(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  authority: StopAuthority,
): Promise<"pending" | void> {
  const progress: CaptureProgress = {
    receiptWriter: sql,
    stage: "observe",
    workAtRisk: false,
    checkedClean: false,
    stopToken: null,
    fence: [providerId, authority.token, authority.generation],
  };
  const ownsStop = async () => {
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
  const outcome = await preserveGitWork(sql, provider, id, providerId, progress, authority.signal);
  if (outcome === "pending" || authority.signal.aborted || !(await ownsStop())) return "pending";
}

async function preserveGitWork(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  progress: CaptureProgress,
  stopSignal: AbortSignal,
): Promise<"pending" | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, stopSignal]);
  try {
    return await Promise.race([
      captureAndStore(sql, provider, id, providerId, () => expired || signal.aborted, progress, signal),
      new Promise<"pending" | void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          if (stopSignal.aborted) return resolve("pending");
          const diagnostic = { errorClass: "timeout", providerStatus: null };
          const reason = closedFailure(progress.stage, "timeout", diagnostic);
          console.warn(
            JSON.stringify({
              event: "work_preservation_deferred",
              sandboxId: id,
              stage: progress.stage,
              reason,
              workRisk: progress.workAtRisk ? "confirmed" : progress.checkedClean ? "clean" : "unknown",
              ...diagnostic,
            }),
          );
          resolve("pending");
        }, 20_000);
      }),
    ]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

type CaptureProgress = {
  receiptWriter: Sql;
  stage: string;
  workAtRisk: boolean;
  checkedClean: boolean;
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
          source: "lifecycle_stop",
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
        work_stop_owned: boolean | null;
      }>(
        `select application_secret_tainted,
        (${WORK_STOP_OWNER}) as work_stop_owned, case when stop_requested_at is null then null else stop_generation::text end as stop_token,
        (${COMPLETE_PRESERVATION}) as complete
       from public.sandboxes where id=$1::uuid`,
        [id, ...progress.fence],
      )
    ).rows[0];
    if (expired()) return;
    if (!stop?.work_stop_owned) return "pending";
    stopLoaded = true;
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
    if (stop.complete) {
      observed("capture_reused");
      return;
    }
    // Exec may implicitly resume retained compute. Never activate a machine known stopped.
    const current = await provider.get(providerId, { signal });
    if (expired()) return;
    observed("observed", current.state);
    if (["stopped", "deleted"].includes(current.state) || current.physicalExitConfirmed) return;
    if (
      HOST_CAPABILITIES.modal.fencedStopPhases.includes(current.providerState) ||
      ["reserved", "restoring", "creating", "booting"].includes(current.providerState)
    )
      return;
    const ownsCapture = async () => {
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
    const context = { source: "lifecycle_stop", captureId: crypto.randomUUID() } as const;
    stage = progress.stage = "quiesce";
    observed("capture_started");
    const onWorkAtRisk = () => {
      progress.workAtRisk = true;
    };
    const captureGeneration = current.physicalGeneration;
    if (!provider.captureRuntimeWork || !captureGeneration || current.id !== providerId)
      throw new ProviderError({
        provider: provider.id,
        code: "sandbox_not_ready",
        message: "No bound runtime work collector for this physical generation.",
        retryable: false,
      });
    const result = await provider.captureRuntimeWork({
      sandboxId: providerId,
      physicalGeneration: captureGeneration,
      signal,
      context,
      onWorkAtRisk,
    });
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
        event: "work_preservation_deferred",
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
  return "pending";
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
