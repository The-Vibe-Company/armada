import { randomUUID } from "node:crypto";
import { type OutputFile, type Provider, parseOutputFiles, type Sql } from "@armada/core/server";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { captureFinalOutputs } from "./sandbox-outputs.ts";

type Clock = Parameters<typeof createRuntimeCommands>[2];
type OutputReader = Pick<Provider, "readOutputs">;

/** Docker sandboxes have no provider exec: the machine channel is the host daemon, and the only
 * server-to-sandbox channel is the enrolled runtime. Outputs use its fixed, read-only
 * `readOutputs` operation (never caller commands), under the owner's live runtime fence. */
const READ_TIMEOUT_MS = 25_000;
/** Answered reads younger than this may still be consumed by a concurrent reader. */
const ANSWERED_GRACE_MS = 60_000;

export function createDockerOutputReader(sql: Sql, key: string, clock?: Clock) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key, clock);
  const now = clock ? () => clock.now() : () => Date.now();
  return (id: string): OutputReader => ({
    async readOutputs(request): Promise<OutputFile[] | null> {
      const row = (
        await sql.query<{ owner_id: string }>(
          `select owner_id from public.sandboxes where id=$1 and provider='docker' and not application_secret_tainted`,
          [id],
        )
      ).rows[0];
      if (!row) return null;
      const started = now();
      // Reads are fresh data, not history: drop answered reads and those of an older runtime
      // epoch. Recent answered rows belong to a concurrent read that has not consumed them yet.
      const queue = (
        await sql.query<{ busy: boolean }>(
          `with current as (select epoch from public.runtime_enrolments where sandbox_id=$1),
          removed as (delete from public.runtime_commands c where c.sandbox_id=$1 and starts_with(c.request_id,'outputs_')
            and (c.epoch is distinct from (select epoch from current)
              or (c.result_enc is not null and split_part(c.request_id,'_',2)::bigint<$2::bigint)))
          select exists(select 1 from public.runtime_commands c where c.sandbox_id=$1
            and c.epoch=(select epoch from current) and c.result_enc is null) as busy`,
          [id, String(started - ANSWERED_GRACE_MS)],
        )
      ).rows[0];
      // The runtime answers its queue in order: never wait behind an unanswered command (a long
      // exec, a prompt a stop is about to cancel) or pile reads up. The previous snapshot stays.
      if (queue?.busy) return null;
      const requestId = `outputs_${started}_${randomUUID().replaceAll("-", "")}`;
      try {
        const reply = await commands.call(
          row.owner_id,
          { version: 1, requestId, sandboxId: id, op: "readOutputs" },
          { timeoutMs: READ_TIMEOUT_MS, ...(request.signal ? { signal: request.signal } : {}) },
        );
        const result = reply.body.result as { files?: unknown } | undefined;
        if (reply.status !== 200 || reply.body.requestId !== requestId || !result) return null;
        return parseOutputFiles(result.files);
      } catch {
        // Not live (stop requested, no enrolment), refused or timed out: keep the previous snapshot.
        return null;
      } finally {
        await sql
          .query(
            `delete from public.runtime_commands where sandbox_id=$1 and request_id=$2 and result_enc is not null`,
            [id, requestId],
          )
          .catch(() => {});
      }
    },
  });
}

/** Final capture before an Armada-initiated Docker stop is enqueued: the runtime refuses commands
 * once a stop is requested, so this must precede the stop admission. Bounded; failure keeps the
 * last sample and never blocks the stop. */
export async function captureDockerStopOutputs(
  sql: Sql,
  key: string,
  id: string,
  options: { timeoutMs?: number; reader?: (id: string) => OutputReader } = {},
): Promise<void> {
  try {
    const target = (
      await sql.query(
        `select 1 from public.sandboxes s where s.id=$1 and s.provider='docker' and s.status in ('ready','running')
         and s.stop_requested_at is null and not exists(select 1 from public.docker_host_jobs j
           where j.bound_sandbox_id=s.id and j.bound_operation in ('stop','delete') and j.outcome is null)`,
        [id],
      )
    ).rows[0];
    if (!target) return;
    const reader = (options.reader ?? createDockerOutputReader(sql, key))(id);
    await captureFinalOutputs(sql, reader, id, { key, signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) });
  } catch {
    console.warn(JSON.stringify({ event: "sandbox_output_final_capture_failed", sandboxId: id }));
  }
}
