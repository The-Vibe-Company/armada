import type { OutputChunkRequest } from "@armada/core";
import { randomUUID } from "node:crypto";
import { type OutputFile, type Provider, parseOutputFiles, parseOutputEntries, parseOutputChunk, type Sql } from "@armada/core/server";
import { createRuntimeCommands, expiredOutputRead } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { captureFinalOutputs, recordOutputFailure } from "./sandbox-outputs.ts";

type Clock = Parameters<typeof createRuntimeCommands>[2];
type OutputReader = Pick<Provider, "readOutputs" | "listOutputEntries" | "readOutputChunk">;

/** Docker sandboxes have no provider exec: the machine channel is the host daemon, and the only
 * server-to-sandbox channel is the enrolled runtime. Outputs use its fixed, read-only
 * `readOutputs` operation (never caller commands), under the owner's live runtime fence. */
const READ_TIMEOUT_MS = 25_000;

/** The runtime's readOutputs result as output files, or null when Armada rejects it. */
function parsed(result: unknown): OutputFile[] | null {
  if (!result) return null;
  try {
    return parseOutputFiles((result as { files?: unknown }).files);
  } catch {
    return null;
  }
}

export function createDockerOutputReader(sql: Sql, key: string, clock?: Clock) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key, clock);
  const now = clock ? () => clock.now() : () => Date.now();
  /** `expectedEpoch` fences the read to an already validated runtime authority. */
  return (id: string, expectedEpoch?: string): OutputReader => {
    async function read<T>(
      request: { signal?: AbortSignal },
      decode: (result: unknown) => T | null,
      part?: OutputChunkRequest | null,
    ): Promise<T | null> {
      const row = (
        await sql.query<{ owner_id: string }>(
          `select owner_id from public.sandboxes where id=$1 and provider='docker' and not application_secret_tainted`,
          [id],
        )
      ).rows[0];
      if (!row) return null;
      // A cancelled read (deadline or worker shutdown) never cleans up or enqueues after this.
      request.signal?.throwIfAborted();
      // The deadline is part of the request id: once it passes, the read is never dispatched and
      // never counts as pending (`expiredOutputRead`), even if this process never returns here.
      const deadline = now() + READ_TIMEOUT_MS;
      // Reads are fresh data, not history. A row is only removed once nobody can still use it: its
      // epoch ended, or its reader gave up (deadline passed) and the runtime answered a later
      // command (it acknowledges in order, and dispatch never sends a read after a later answer, so
      // the read was either acknowledged or never delivered). Removing a row the runtime may still
      // acknowledge would make that acknowledgement fail forever.
      const queue = (
        await sql.query<{ busy: boolean }>(
          `with current as (select epoch from public.runtime_enrolments where sandbox_id=$1),
          removed as (delete from public.runtime_commands c where c.sandbox_id=$1 and starts_with(c.request_id,'outputs_')
            and (c.epoch is distinct from (select epoch from current)
              or (${expiredOutputRead("c.request_id", "$2")}
                and exists(select 1 from public.runtime_commands later where later.sandbox_id=c.sandbox_id
                  and later.epoch=c.epoch and later.sequence>c.sequence and later.result_enc is not null)))),
          pending as (select starts_with(c.request_id,'outputs_') as read from public.runtime_commands c
            where c.sandbox_id=$1 and c.epoch=(select epoch from current) and c.result_enc is null
            and not ${expiredOutputRead("c.request_id", "$2")})
          select exists(select 1 from pending where not read) or (select count(*) from pending where read)>1 as busy`,
          [id, String(now())],
        )
      ).rows[0];
      // The runtime answers its queue in order: never wait behind an unanswered command (a long
      // exec, a prompt a stop is about to cancel) or pile reads up. The previous snapshot stays.
      // One in-flight read is not busy: reads are fast and read-only, so a pre-stop capture queues
      // behind a periodic sample and takes its own fresh read before the stop is admitted (after
      // admission the runtime fence refuses the sample's reply, which would otherwise be lost).
      if (queue?.busy) return null;
      const requestId = `outputs_${deadline}_${randomUUID().replaceAll("-", "")}`;
      // Parsed once: under a request the boundary's check parses this same reply.
      let files: T | null | undefined;
      try {
        const reply = await commands.call(
          row.owner_id,
          { version: 1, requestId, sandboxId: id, op: "readOutputs", ...(part !== undefined ? { part } : {}) },
          {
            timeoutMs: READ_TIMEOUT_MS,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
            // Same parse as the snapshot below, so a reply whose files Armada rejects is not `ok`.
            accept: (candidate) => {
              files = decode(candidate.body.result);
              return files !== null;
            },
          },
        );
        if (reply.status !== 200 || reply.body.requestId !== requestId) return null;
        return files === undefined ? decode(reply.body.result) : files;
      } catch {
        // Not live (stop requested, no enrolment, other epoch), refused or timed out: keep the
        // previous snapshot. A read left unanswered expires at its deadline.
        return null;
      }
    }
    const values = (result: unknown) => (result as { values?: unknown } | null)?.values;
    return {
      readOutputs: (request) => read(request, parsed),
      listOutputEntries: async (request) => {
        const result = await read(request, (result) => {
          try {
            return parseOutputEntries(values(result));
          } catch {
            return null;
          }
        }, null);
        return result;
      },
      readOutputChunk: (request) => read(request, (result) => {
        try {
          return parseOutputChunk(values(result), request.chunk);
        } catch {
          return null;
        }
      }, request.chunk),
    };
  };
}

/** Final capture before an Armada-initiated Docker stop is enqueued: the runtime refuses commands
 * once a stop is requested, so this must precede the stop admission. Bounded; failure keeps the
 * last sample and never blocks the stop. */
export async function captureDockerStopOutputs(
  sql: Sql,
  key: string,
  id: string,
  options: { timeoutMs?: number; reader?: (id: string, expectedEpoch?: string) => OutputReader; epoch?: string } = {},
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
    const reader = (options.reader ?? createDockerOutputReader(sql, key))(id, options.epoch);
    await captureFinalOutputs(sql, reader, id, { key, signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) }).catch(
      () => {},
    );
  } catch {
    void recordOutputFailure(sql, id, "sandbox_output_final_capture_failed", "collector_failed").catch(() => {});
  }
}
