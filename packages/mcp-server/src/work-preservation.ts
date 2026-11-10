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

/** Never return command output or SDK errors: archives may contain credentials. */
export async function preserveBeforeStop(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
): Promise<"pending" | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const progress = { stage: "observe" };
  try {
    return await Promise.race([
      captureAndStore(sql, provider, id, providerId, () => expired, progress),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          const diagnostic = { errorClass: "timeout", providerStatus: null };
          const reason = closedFailure(progress.stage, "timeout", diagnostic);
          console.warn(
            JSON.stringify({
              event: "work_preservation_failed",
              sandboxId: id,
              stage: progress.stage,
              reason,
              ...diagnostic,
            }),
          );
          void sql
            .query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [id, failureNote("timeout")])
            .catch(() => {});
          resolve();
        }, 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureAndStore(
  sql: Sql,
  provider: Provider,
  id: string,
  providerId: string,
  expired: () => boolean,
  progress: { stage: string },
): Promise<"pending" | void> {
  let reason = "failed";
  let stage = "observe";
  let diagnostic: ReturnType<typeof workPreservationError> | undefined;
  let note: string;
  try {
    // Exec may implicitly resume retained compute. Never activate a machine known stopped.
    const current = await provider.get(providerId);
    if (expired()) return;
    if (["stopped", "deleted"].includes(current.state) || current.physicalExitConfirmed) return;
    // Native runtimes acknowledge interrupt only after active turns settle.
    // The stop activity lease prevents new Armada turns during capture.
    stage = progress.stage = "quiesce";
    reason = "failed";
    await (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: providerId });
    if (expired()) return;
    stage = progress.stage = "capture";
    reason = "failed";
    const result = await preserveWork(provider, providerId);
    if (expired()) return;
    if (result.status === "preserved") {
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
      // Clear stale warnings, but retain the latest recovery receipt if one exists.
      await sql.query(
        `update public.sandboxes set preservation_note=(
          select 'unpushed work preserved at work_recovery:' || sandbox_id || '/' || id
          from public.sandbox_work_recovery where sandbox_id=$1::uuid order by created_at desc limit 1
        ) where id=$1::uuid`,
        [id],
      );
      return;
    } else {
      reason = result.reason;
      if (result.diagnostic) {
        stage = result.diagnostic.stage;
        diagnostic = result.diagnostic;
      }
      note = failureNote(reason);
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
      await sql
        .query(
          "update public.sandboxes set preservation_note=null where id=$1::uuid and preservation_note like 'unpushed work could not be preserved%'",
          [id],
        )
        .catch(() => {});
      return "pending";
    }
    diagnostic = workPreservationError(error);
    note = failureNote(stage === "capture" ? "capture_failed" : `${stage}_failed`);
    reason = closedFailure(stage, reason, diagnostic);
  }
  if (expired()) return;
  if (!note.startsWith("unpushed work preserved"))
    console.warn(JSON.stringify({ event: "work_preservation_failed", sandboxId: id, stage, reason, ...diagnostic }));
  try {
    await sql.query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [id, note]);
  } catch (error) {
    if (!expired() && note.startsWith("unpushed work preserved"))
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
