import { decryptSecret, encryptSecret, type Provider, preserveWork, type Sql } from "@armada/core/server";

function failureNote(reason: string): string {
  return `unpushed work could not be preserved (${reason}). Resume the sandbox and push or copy any local work before stopping again.`;
}

/** Never return command output or SDK errors: archives may contain credentials. */
export async function preserveBeforeStop(sql: Sql, provider: Provider, id: string, providerId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      captureAndStore(sql, provider, id, providerId, () => expired),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          console.warn(
            JSON.stringify({ event: "work_preservation_failed", sandboxId: id, stage: "deadline", reason: "timeout" }),
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
): Promise<void> {
  let reason = "observe_failed";
  let stage = "observe";
  let note: string;
  try {
    // Exec may implicitly resume retained compute. Never activate a machine known stopped.
    const current = await provider.get(providerId);
    if (expired()) return;
    if (["stopped", "deleted"].includes(current.state) || current.physicalExitConfirmed) return;
    // Native runtimes acknowledge interrupt only after active turns settle.
    // The stop activity lease prevents new Armada turns during capture.
    stage = "quiesce";
    reason = "quiesce_failed";
    await (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: providerId });
    if (expired()) return;
    stage = "capture";
    reason = "capture_failed";
    const result = await preserveWork(provider, providerId);
    if (expired()) return;
    if (result.status === "preserved") {
      stage = "storage";
      reason = "storage";
      const encrypted = await encryptSecret(result.archive);
      if (expired()) return;
      const recoveryId = crypto.randomUUID();
      await sql.query(
        `insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc) values($1::uuid,$2::uuid,$3::bytea)`,
        [recoveryId, id, encrypted],
      );
      note = `unpushed work preserved at work_recovery:${id}/${recoveryId}`;
    } else if (result.status === "clean") {
      stage = "storage";
      reason = "storage";
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
      note = failureNote(reason);
    }
  } catch {
    note = failureNote(reason);
  }
  if (expired()) return;
  if (!note.startsWith("unpushed work preserved"))
    console.warn(JSON.stringify({ event: "work_preservation_failed", sandboxId: id, stage, reason }));
  try {
    await sql.query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [id, note]);
  } catch {
    if (!expired() && note.startsWith("unpushed work preserved"))
      console.warn(
        JSON.stringify({ event: "work_preservation_failed", sandboxId: id, stage: "receipt", reason: "storage" }),
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
