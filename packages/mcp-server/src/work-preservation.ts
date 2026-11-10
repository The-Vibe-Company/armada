import { decryptSecret, encryptSecret, type Provider, preserveWork, type Sql } from "@armada/core/server";

/** Never return command output or SDK errors: archives may contain credentials. */
export async function preserveBeforeStop(sql: Sql, provider: Provider, id: string, providerId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      captureAndStore(sql, provider, id, providerId),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureAndStore(sql: Sql, provider: Provider, id: string, providerId: string): Promise<void> {
  let note = "unpushed work could not be preserved (storage unavailable)";
  try {
    const result = await preserveWork(provider, providerId);
    if (result.status === "preserved") {
      const encrypted = await encryptSecret(result.archive);
      const recoveryId = crypto.randomUUID();
      await sql.query(
        `insert into public.sandbox_work_recovery(id,sandbox_id,archive_enc) values($1::uuid,$2::uuid,$3::bytea)`,
        [recoveryId, id, encrypted],
      );
      note = `unpushed work preserved at work_recovery:${id}/${recoveryId}`;
    } else if (result.status === "clean") {
      // A subsequent clean stop must not hide an earlier recovery archive.
      return;
    } else note = `unpushed work could not be preserved (${result.reason})`;
  } catch {
    /* Closed storage failure, stop must still proceed. */
  }
  await sql.query("update public.sandboxes set preservation_note=$2 where id=$1::uuid", [id, note]);
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
