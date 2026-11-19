import { createHash } from "node:crypto";
import {
  OUTPUT_CHUNK_BYTES,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_FILES,
  OUTPUT_MAX_ORG_BYTES,
  OUTPUT_MAX_READ_BYTES,
  OUTPUT_MAX_SANDBOX_BYTES,
  type SandboxPlacementProviderId,
} from "@armada/core";
import { sandboxOutputOperations } from "@armada/core/contract";
import {
  admitOutputs,
  decryptSecret,
  encryptionKey,
  encryptSecret,
  OUTPUT_DIRECTORY,
  OutputCollectionError,
  type OutputFailureReason,
  type Provider,
  type Sql,
} from "@armada/core/server";
import type { Caller, CallerResult } from "./caller.ts";
import type { Job, JobResult } from "./jobs/runner.ts";
import type { createJobsStore } from "./jobs/store.ts";
import {
  BOAT_RETAINED_OUTPUT_STOP,
  CAN_WRITE_LIVE,
  collectOutputTransfers,
  remainingOutputOrgBytes,
} from "./output-transfers.ts";

// Native and enrolled-runtime Boat/Modal sandboxes: providers read the declared directory through
// their own fixed channel (Provider.readOutputs), never caller commands or the agent runtime.
// Docker sandboxes have no provider exec; their reader is the runtime's fixed read-only operation.
// Application-secret taint is irreversible and forbids every file egress (same policy as exec and work recovery).
const ELIGIBLE = `provider in ('boat','modal','docker') and not application_secret_tainted
  and not ('collector_unsupported' = any(outputs_failure_reasons))`;

/** The only provider surface output collection uses. */
type OutputReader = Pick<
  Provider,
  | "readOutputs"
  | "probeOutputs"
  | "listOutputEntries"
  | "readOutputChunk"
  | "outputReadBytes"
  | "outputReadConcurrency"
  | "openRetainedOutputs"
>;

/** SDKs may ignore cancellation once a request reached the provider. Callers wait at most until
 * their signal aborts; the outstanding read stays tracked, bounded and fenced from persisting. */
const OUTSTANDING_MAX = 4;
const BOAT_RETAINED_CANDIDATE = `${BOAT_RETAINED_OUTPUT_STOP}
  and not exists (select 1 from public.sandbox_transitions t where t.sandbox_id=sandboxes.id
    and t.generation=sandboxes.lifecycle_generation and t.code='launch_interrupted')`;

const LIVE_CANDIDATE = `(${ELIGIBLE}) and status in ('running','ready') and stopped_at is null`;
const CAPTURE_CANDIDATE = `not application_secret_tainted and provider_sandbox_id is not null
  and ((${LIVE_CANDIDATE}) or (${BOAT_RETAINED_CANDIDATE}))`;
export const OUTPUTS_CAPTURE = "outputs_capture";

type OutputAttempt = {
  provider: SandboxPlacementProviderId;
  status: string;
  attemptCount: number;
};
/** Deadline of one background periodic sample (the shared worker loop never waits for it). */
const SAMPLE_DEADLINE_MS = 25_000;

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Claim each closed reason atomically so replicas and both capture paths share the same limit. */
export async function recordOutputFailure(
  sql: Sql,
  id: string,
  event: string,
  reason: OutputFailureReason,
  generation?: string | null,
): Promise<void> {
  const claim = await sql.query<OutputAttempt>(
    `update public.sandboxes
     set outputs_failure_reasons=array_append(outputs_failure_reasons,$2)
     where id=$1 and status<>'deleted' and not application_secret_tainted
     and ($3::bigint is null or lifecycle_generation=$3::bigint)
     and not ($2 = any(outputs_failure_reasons))
     returning provider, status, outputs_attempt_count as "attemptCount"`,
    [id, reason, generation ?? null],
  );
  const attempt = claim.rows[0];
  if (!attempt) return;
  if (reason === "output_directory_missing") {
    console.info(JSON.stringify({ event: "sandbox_output_collection_empty", sandboxId: id, reason, ...attempt }));
  } else {
    console.warn(JSON.stringify({ event, sandboxId: id, reason, ...attempt }));
  }
}

function failureReason(error: unknown, signal?: AbortSignal): OutputFailureReason {
  if (error instanceof OutputCollectionError) return error.reason;
  if (signal?.aborted) return "output_timeout";
  if (collectorErrorKind(error) === "output_limit") return "output_limit";
  return "collector_failed";
}

function collectorErrorKind(error: unknown) {
  if (error instanceof OutputCollectionError)
    return error.reason === "output_limit" ? "collector_reported_limit" : "collector_reported_failure";
  if (error instanceof SyntaxError) return "syntax_error";
  if (!(error instanceof Error)) return "non_error";
  if (error.message === "invalid_output" || error.message === "output_limit") return error.message;
  return "error";
}

type OutputPhase =
  | "resolve_reader"
  | "claim_scan"
  | "admit_read"
  | "probe_collector"
  | "list_entries"
  | "read_chunk"
  | "read_snapshot"
  | "open_retained_snapshot"
  | "store_transfers"
  | "publish_snapshot"
  | "record_failure";

class OutputPhaseError extends Error {
  constructor(
    readonly phase: OutputPhase,
    readonly failure: unknown,
  ) {
    super(phase);
  }
}

async function outputPhase<T>(phase: OutputPhase, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Preserve closed collector reasons so callers can still handle missing directories and protocol skew.
    const reason = failureReason(error);
    if (error instanceof OutputPhaseError || (reason !== "collector_failed" && reason !== "output_limit")) throw error;
    throw new OutputPhaseError(phase, error);
  }
}

const diagnosticAt = new Map<string, number>();

function reportCaptureFailure(
  sql: Sql,
  id: string,
  path: "live" | "retained" | "final",
  provider: SandboxPlacementProviderId | undefined,
  error: unknown,
  signal?: AbortSignal,
  generation?: string | null,
) {
  const failure = error instanceof OutputPhaseError ? error.failure : error;
  const reason = failureReason(failure, signal);
  if (error instanceof OutputPhaseError && (reason === "collector_failed" || reason === "output_limit")) {
    // Use a closed vocabulary because exceptions may carry command output, SQL, or credentials.
    const errorKind = collectorErrorKind(failure);
    // Existing rows may already have claimed collector_failed. Bound the new diagnostic
    // independently by provider, path, phase and error kind, never by sandbox or exception text.
    const key = JSON.stringify([provider, path, error.phase, errorKind]);
    const now = performance.now();
    const previous = diagnosticAt.get(key);
    if (previous === undefined || now - previous >= 60_000) {
      diagnosticAt.set(key, now);
      console.warn(
        JSON.stringify({
          event: "sandbox_output_collector_diagnostic",
          sandboxId: id,
          provider,
          path,
          phase: error.phase,
          errorKind,
        }),
      );
    }
  }
  const event = path === "final" ? "sandbox_output_final_capture_failed" : "sandbox_output_collection_failed";
  return recordOutputFailure(sql, id, event, reason, generation).catch(() => {});
}

async function probeOutputCapability(
  sql: Sql,
  provider: OutputReader,
  id: string,
  providerId: string,
  generation: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const ready = await outputPhase("probe_collector", () =>
    provider.probeOutputs!({ sandboxId: providerId, ...(signal ? { signal } : {}) }),
  );
  if (!ready) throw new OutputCollectionError("output_unavailable");
  signal?.throwIfAborted();
  const verified = await sql.query(
    `update public.sandboxes set outputs_collector_supported=true
     where id=$1 and lifecycle_generation=$2::bigint and provider_sandbox_id=$3 and ${LIVE_CANDIDATE} returning id`,
    [id, generation, providerId],
  );
  return verified.rows.length > 0;
}

async function collect(
  sql: Sql,
  provider: OutputReader,
  id: string,
  providerId: string,
  scan: string,
  key: string,
  options: {
    signal?: AbortSignal | undefined;
    writes?: Set<Promise<unknown>>;
    job?: Job;
    canDispatch?: () => Promise<boolean>;
  },
) {
  const { signal, writes, job } = options;
  const admitRead = async (eligibility: string) => {
    signal?.throwIfAborted();
    if (options.canDispatch && !(await options.canDispatch())) return;
    const { rows } = await outputPhase("admit_read", () =>
      sql.query<{ outputs_collector_supported: boolean }>(
        `select outputs_collector_supported from public.sandboxes where id=$1 and ${ELIGIBLE}
          and ($2::bigint is null or (lifecycle_generation=$2::bigint and provider_sandbox_id=$3 and (${eligibility})))`,
        [id, job?.generation ?? null, providerId],
      ),
    );
    signal?.throwIfAborted();
    return rows[0];
  };
  const authorizeRead = async () => {
    if (job && !(await admitRead(CAN_WRITE_LIVE))) throw new OutputCollectionError("output_unavailable");
  };
  const admitted = await admitRead(LIVE_CANDIDATE);
  if (!admitted) return;
  // Final capture never probes first. Its bounded read is the last chance to collect a deliverable,
  // and the read's own exit status classifies an unsupported collector, so a transient or parallel
  // probe never costs that read. A recorded `collector_unsupported` was already excluded above:
  // a collector known to be unavailable adds no delay to stop.
  if (provider.probeOutputs && !admitted.outputs_collector_supported && job?.generation) {
    await authorizeRead();
    if (
      !(await outputPhase("admit_read", () =>
        probeOutputCapability(sql, provider, id, providerId, job.generation!, signal),
      ))
    )
      return;
  }
  signal?.throwIfAborted();
  if (provider.listOutputEntries && provider.readOutputChunk) {
    try {
      await outputPhase("store_transfers", () =>
        collectOutputTransfers(
          sql,
          {
            ...(provider.outputReadConcurrency !== undefined
              ? { outputReadConcurrency: provider.outputReadConcurrency }
              : {}),
            ...(provider.outputReadBytes !== undefined ? { outputReadBytes: provider.outputReadBytes } : {}),
            listOutputEntries: async (request) => {
              await authorizeRead();
              return outputPhase("list_entries", () => provider.listOutputEntries!(request));
            },
            readOutputChunk: async (request) => {
              await authorizeRead();
              return outputPhase("read_chunk", () => provider.readOutputChunk!(request));
            },
          },
          id,
          { sandboxId: providerId, ...(signal ? { signal } : {}) },
          scan,
          key,
          writes,
          undefined,
          job,
        ),
      );
      return;
    } catch (error) {
      // Runtimes enrolled before chunk support still serve their original small snapshots.
      if (!(error instanceof OutputCollectionError) || error.reason !== "output_protocol_unsupported") throw error;
    }
  }
  signal?.throwIfAborted();
  await authorizeRead();
  const read = provider.readOutputs
    ? await outputPhase("read_snapshot", () =>
        provider.readOutputs!({ sandboxId: providerId, ...(signal ? { signal } : {}) }),
      )
    : null;
  // Not live or a failed read: keep the previous snapshot; running sandboxes retry after the fence.
  if (!read) throw new OutputCollectionError("output_unavailable");
  // The caller's deadline has passed: a late read must never replace what callers saw since.
  signal?.throwIfAborted();
  const files = admitOutputs(read).map((file) => ({
    name: file.name,
    bytes: Buffer.from(file.bytes),
    digest: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  // Replace the bounded snapshot atomically. Readers retain the last successful snapshot on collection failure.
  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      digest: file.digest,
      size: file.bytes.length,
      content: Buffer.from(await encryptSecret(file.bytes.toString("base64"), key)).toString("hex"),
    })),
  );
  if (!sql.transaction) throw Error("output_transaction_unavailable");
  signal?.throwIfAborted();
  // Writes under the row lock and the publication fence (only a newer scan supersedes), and only while the caller's deadline holds: checked
  // after the lock (time spent waiting for SQL counts) and again after the write, before commit, so an
  // expired collection rolls back its files and webhook events.
  const write = sql.transaction(async (tx) => {
    signal?.throwIfAborted();
    const authority = await tx.query<{ org_id: string }>(
      `select org_id from public.sandboxes where id=$1 and status<>'deleted' and not application_secret_tainted
        and ($3::bigint is null or (lifecycle_generation=$3::bigint and provider_sandbox_id=$4))
        and (outputs_published_scan is null or outputs_published_scan<$2::timestamptz) for update`,
      [id, scan, job?.generation ?? null, providerId],
    );
    // A newer read (e.g. a pre-stop capture claimed after this sample) already committed: never go
    // back. An older read whose newer rival failed still publishes what live compute held.
    const sandbox = authority.rows[0];
    if (!sandbox) return;
    signal?.throwIfAborted();
    const remaining = await remainingOutputOrgBytes(tx, sandbox.org_id);
    const existing =
      (
        await tx.query<{ bytes: number }>(
          "select coalesce(sum(size),0)::integer as bytes from public.sandbox_outputs where sandbox_id=$1 and content_enc is not null",
          [id],
        )
      ).rows[0]?.bytes ?? 0;
    if (payload.reduce((total, file) => total + file.size, 0) > Math.max(0, remaining) + existing)
      throw new OutputCollectionError("output_limit");
    signal?.throwIfAborted();
    await tx.query(
      `with incoming as (select * from jsonb_to_recordset($2::jsonb) as f(name text,digest text,size integer,content text)),
      removed as (delete from public.sandbox_outputs where sandbox_id=$1 and name not in(select name from incoming))
      insert into public.sandbox_outputs(sandbox_id,name,digest,size,content_enc)
      select $1,name,digest,size,decode(content,'hex') from incoming
      on conflict(sandbox_id,name) do update set digest=excluded.digest,size=excluded.size,content_enc=excluded.content_enc,
        transfer_id=null,skipped=null,updated_at=now()
      where sandbox_outputs.digest is distinct from excluded.digest`,
      [id, JSON.stringify(payload)],
    );
    await tx.query(`update public.sandboxes set outputs_published_scan=$2::timestamptz where id=$1`, [id, scan]);
    signal?.throwIfAborted();
  });
  // A write already in progress is bounded by SQL and settles before the pool closes.
  if (writes) {
    const settled = write.then(
      () => {},
      () => {},
    );
    writes.add(settled);
    void settled.then(() => writes.delete(settled));
  }
  await write;
}

/** Final captures that outlived their stop deadline and still hang in the provider SDK. */
const finalLate = new Map<Promise<void>, SandboxPlacementProviderId | undefined>();

/** Settle final captures that outlived their stop deadline (tests); late ones never persist. */
export async function drainFinalOutputs(): Promise<void> {
  await Promise.allSettled(finalLate.keys());
}

/** Final capture on Armada's stop path: after quiesce, before provider stop revokes compute.
 * Stopped workspaces are never read, so this is the last snapshot a stopped sandbox exposes.
 * Once it commits, its newer scan prevents an older in-flight sample from replacing it; if it
 * fails, that older sample still publishes while it is within its own deadline. Never resumes compute. */
export async function captureFinalOutputs(
  sql: Sql,
  provider: OutputReader,
  id: string,
  options: { key?: string | undefined; signal?: AbortSignal } = {},
): Promise<void> {
  const key = options.key ?? encryptionKey();
  if (!key) return;
  const { signal } = options;
  let providerKind: SandboxPlacementProviderId | undefined;
  // The whole capture is bounded, from the scan claim on: a claim that waits on a row lock or a
  // pool connection must not hold stop dispatch either, and a claim that returns after the
  // deadline never reaches the provider.
  const work = (async () => {
    // An expired capture must not even claim a scan.
    signal?.throwIfAborted();
    // Live compute only: an admitted stop keeps 'failed' rows failed while compute may still run.
    const row = (
      await outputPhase("claim_scan", () =>
        sql.query<{ provider: SandboxPlacementProviderId; provider_sandbox_id: string; scan: string }>(
          `update public.sandboxes set outputs_checked_at=clock_timestamp(), outputs_attempt_count=outputs_attempt_count+1
        where id=$1 and stopped_at is null and (status in ('ready','running','stopping') or (status='failed' and stop_requested_at is not null))
        and provider_sandbox_id is not null and ${ELIGIBLE}
        returning provider,provider_sandbox_id,outputs_checked_at::text as scan`,
          [id],
        ),
      )
    ).rows[0];
    if (!row) return;
    signal?.throwIfAborted();
    // Only overdue captures from this provider count. Live concurrent stops all get a read.
    if ([...finalLate.values()].filter((kind) => kind === row.provider).length >= OUTSTANDING_MAX)
      throw new OutputCollectionError("output_busy");
    providerKind = row.provider;
    try {
      await outputPhase("publish_snapshot", () =>
        collect(sql, provider, id, row.provider_sandbox_id, row.scan, key, { signal }),
      );
    } catch (error) {
      if (
        error instanceof OutputCollectionError &&
        (error.reason === "collector_unsupported" || error.reason === "output_directory_missing")
      ) {
        await outputPhase("record_failure", () =>
          recordOutputFailure(sql, id, "sandbox_output_final_capture_failed", error.reason),
        );
        return;
      }
      throw error;
    }
  })();
  work.catch(() => {});
  // Stop dispatch waits at most until the caller's deadline, even if the provider SDK does not.
  try {
    await untilAborted(work, signal);
  } catch (error) {
    if (signal?.aborted) {
      finalLate.set(work, providerKind);
      void work.catch(() => {}).finally(() => finalLate.delete(work));
    }
    void reportCaptureFailure(sql, id, "final", providerKind, error, signal);
    throw error instanceof OutputPhaseError ? error.failure : error;
  }
}

async function collectRetained(
  sql: Sql,
  provider: OutputReader,
  row: OutputAttempt & { id: string; provider_sandbox_id: string; scan: string },
  job: Job,
  key: string,
  signal: AbortSignal,
  writes: Set<Promise<unknown>>,
  canDispatch: () => Promise<boolean>,
) {
  const fence = `id=$1 and lifecycle_generation=$2::bigint
    and provider_sandbox_id=$3 and not application_secret_tainted and ${BOAT_RETAINED_OUTPUT_STOP}`;
  const args = [row.id, job.generation, row.provider_sandbox_id];
  const admitRead = async () => {
    if (!(await canDispatch())) return false;
    const admitted = await outputPhase("admit_read", () =>
      sql.query(`select 1 from public.sandboxes where ${fence}`, args),
    );
    signal.throwIfAborted();
    return admitted.rows.length > 0;
  };
  if (!(await admitRead())) return false;
  const snapshot = await outputPhase("open_retained_snapshot", async () =>
    provider.openRetainedOutputs?.({ sandboxId: row.provider_sandbox_id, signal }),
  );
  signal.throwIfAborted();
  if (snapshot === "pending") return false;
  if (snapshot === "gone") {
    if (!(await canDispatch())) return false;
    signal.throwIfAborted();
    const write = sql.query(
      `update public.sandboxes set outputs_retained_generation=$2::bigint where ${fence} returning id`,
      args,
    );
    writes.add(write);
    try {
      if ((await write).rows.length) {
        console.info(
          JSON.stringify({
            event: "sandbox_output_collection_empty",
            sandboxId: row.id,
            reason: "retained_outputs_absent",
            provider: row.provider,
            status: row.status,
            attemptCount: row.attemptCount,
          }),
        );
      }
    } finally {
      writes.delete(write);
    }
    return true;
  }
  if (!snapshot) throw new OutputCollectionError("output_unavailable");
  await collectOutputTransfers(
    sql,
    {
      outputReadBytes: OUTPUT_MAX_READ_BYTES,
      listOutputEntries: async () => snapshot.entries,
      readOutputChunk: async ({ chunk }) => {
        if (!(await admitRead())) return null;
        return outputPhase("read_chunk", async () => snapshot.readChunk(chunk));
      },
    },
    row.id,
    { sandboxId: row.provider_sandbox_id, signal },
    row.scan,
    key,
    writes,
    job.generation!,
    job,
  );
  return true;
}

export function createSandboxOutputs(
  sql: Sql,
  key: string | undefined,
  providerFor: (id: string) => Promise<OutputReader>,
  docker?: (id: string) => OutputReader,
) {
  const pending = new Map<Promise<boolean>, { provider: SandboxPlacementProviderId; retained: boolean }>();
  const writes = new Set<Promise<unknown>>();
  async function readSnapshot(
    caller: Caller,
    id: string,
    downloadName: string | undefined,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    const read = sandboxOutputOperations.readSandboxOutput;
    // Owner or org admin, current membership: checked on entry and again after the snapshot
    // is read (and decrypted), so access revoked meanwhile never receives metadata or bytes.
    const authorize = async () =>
      (
        await sql.query<{ id: string; outputs_failure_reasons: string[] }>(
          `select s.id,s.outputs_failure_reasons from public.sandboxes s join public.members m on m.org_id=s.org_id
      where s.id=$1 and s.status<>'deleted' and not s.application_secret_tainted and m.user_id=$2 and s.org_id=any($3::uuid[])
      and (s.owner_id=$2 or m.role='admin') and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
          [id, caller.userId, caller.orgs.map((o) => o.orgId)],
        )
      ).rows[0];
    const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
    const row = await authorize();
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    if (downloadName === undefined) {
      const files = await sql.query<{
        name: string;
        size: number;
        sha256: string | null;
        updatedAt: string;
        skipped?: string | null;
      }>(
        `select name,size::double precision as size,digest as sha256,updated_at as "updatedAt",skipped
          from public.sandbox_outputs where sandbox_id=$1 order by name limit ${OUTPUT_MAX_FILES}`,
        [row.id],
      );
      const current = await authorize();
      if (!current) return notFound();
      return Response.json(
        {
          directory: OUTPUT_DIRECTORY,
          limits: {
            maxFiles: OUTPUT_MAX_FILES,
            maxFileBytes: OUTPUT_MAX_FILE_BYTES,
            maxSandboxBytes: OUTPUT_MAX_SANDBOX_BYTES,
            maxOrgBytes: OUTPUT_MAX_ORG_BYTES,
          },
          files: files.rows.map(({ skipped, ...file }) => (skipped ? { ...file, skipped } : file)),
          ...(current.outputs_failure_reasons.includes("collector_unsupported")
            ? { unavailable: "collector_unsupported" }
            : {}),
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    const nameResult = read.input.path.name.safeParse(downloadName);
    if (!nameResult.success) return Response.json({ error: "invalid_name" }, { status: 400 });
    const name = nameResult.data;
    const file = (
      await sql.query<{
        name: string;
        size: number;
        transfer_id: string | null;
        digest: string;
        content_enc: Uint8Array<ArrayBuffer> | null;
      }>(
        `select name,content_enc,size::integer,transfer_id,digest from public.sandbox_outputs
          where sandbox_id=$1 and name=$2 and skipped is null`,
        [row.id, name],
      )
    ).rows[0];
    if (!file) return notFound();
    if (!key) return Response.json({ error: "unavailable" }, { status: 503 });
    const bytes = file.content_enc ? Buffer.from(await decryptSecret(file.content_enc, key), "base64") : null;
    if (!(await authorize())) return notFound();
    const size = bytes?.length ?? file.size;
    const etag = JSON.stringify(file.digest);
    const ifRange = headers.get("if-range");
    const requestedRange = !ifRange || ifRange === etag ? headers.get("range") : null;
    const range = requestedRange ? outputRange(requestedRange, size) : { start: 0, end: size };
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "cache-control": "private, no-store" },
      });
    const { start, end } = range;
    let offset = start;
    const stream =
      file.transfer_id && end > start
        ? new ReadableStream<Uint8Array>(
            {
              // Pull at most one encrypted chunk at a time, with backpressure from the HTTP consumer.
              async pull(controller) {
                signal.throwIfAborted();
                const base = offset - (offset % OUTPUT_CHUNK_BYTES);
                const chunk = (
                  await sql.query<{ content_enc: Uint8Array<ArrayBuffer> }>(
                    `select c.content_enc from public.sandbox_output_chunks c
            join public.sandbox_outputs o on o.transfer_id=c.transfer_id
            where c.transfer_id=$1 and c.byte_offset=$2 and o.sandbox_id=$3 and o.name=$4`,
                    [file.transfer_id, base, row.id, name],
                  )
                ).rows[0];
                if (!chunk) throw Error("output_snapshot_changed");
                const buffer = Buffer.from(await decryptSecret(chunk.content_enc, key), "base64");
                if (!(await authorize())) throw Error("output_unavailable");
                signal.throwIfAborted();
                if (buffer.length !== Math.min(size - base, OUTPUT_CHUNK_BYTES)) throw Error("invalid_output_chunk");
                const next = Math.min(end, base + buffer.length);
                controller.enqueue(buffer.subarray(offset - base, next - base));
                offset = next;
                if (offset === end) controller.close();
              },
            },
            { highWaterMark: 0 },
          )
        : null;
    const type = new Blob([], { type: Bun.file(file.name).type }).type || read.outputMediaType;
    return new Response(bytes?.subarray(start, end) ?? stream, {
      status: requestedRange ? 206 : 200,
      headers: {
        "content-type": type,
        "accept-ranges": "bytes",
        etag,
        ...(requestedRange ? { "content-range": `bytes ${start}-${end - 1}/${size}` } : {}),
        "content-length": String(end - start),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  }

  return {
    readSnapshot,
    async enqueueCaptures(jobs: Pick<ReturnType<typeof createJobsStore>, "enqueue">, signal: AbortSignal) {
      if (!key || signal.aborted) return;
      const { rows } = await sql.query<{ id: string; org_id: string; generation: string }>(
        `select id, org_id, lifecycle_generation::text as generation from public.sandboxes
         where ${CAPTURE_CANDIDATE} and not exists (
           select 1 from public.jobs j where j.idem_key =
             replace(json_build_array('internal',sandboxes.org_id,$1::text,sandboxes.id,sandboxes.lifecycle_generation,'periodic')::text, ', ', ',')
         ) order by created_at, id limit 1`,
        [OUTPUTS_CAPTURE],
      );
      for (const row of rows) {
        if (signal.aborted) return;
        await jobs.enqueue(OUTPUTS_CAPTURE, row.id, Number(row.generation), "periodic", null, {
          orgId: row.org_id,
          // This recurring job uses run_after for cadence; attempts span the full generation.
          maxAttempts: 2_147_483_646,
        });
      }
    },
    captureJob: {
      concurrency: OUTSTANDING_MAX,
      async run(job: Job, context: { signal: AbortSignal; canDispatch(): Promise<boolean> }): Promise<JobResult> {
        if (!key || !job.sandbox_id || !job.generation) return { status: "done" };
        if (!(await context.canDispatch())) return { status: "fail", reason: "outputs_capture_dispatch_unavailable" };
        const id = job.sandbox_id;
        const startedAt = Date.now();
        const row = (
          await sql.query<OutputAttempt & { id: string; provider_sandbox_id: string; scan: string; retained: boolean }>(
            `update public.sandboxes set outputs_attempt_count=outputs_attempt_count+1
             where id=$1 and lifecycle_generation=$2::bigint and ${CAPTURE_CANDIDATE}
             returning id,provider::text,status,outputs_attempt_count as "attemptCount",provider_sandbox_id,
               clock_timestamp()::text as scan, (${BOAT_RETAINED_OUTPUT_STOP}) as retained`,
            [id, job.generation],
          )
        ).rows[0];
        // A Boat sandbox can become eligible for retained capture after the current stop completes.
        const retry = (ms: number): JobResult => ({ status: "retry", after: new Date(startedAt + ms) });
        if (!row) {
          const waiting = await sql.query(
            `select 1 from public.sandboxes where id=$1 and lifecycle_generation=$2::bigint
             and ((${CAPTURE_CANDIDATE}) or (
               status in ('starting','ready','running','stopping','failed') and stopped_at is null
               and not application_secret_tainted and (provider='boat' or not ('collector_unsupported'=any(outputs_failure_reasons)))
             ))`,
            [id, job.generation],
          );
          return waiting.rows.length ? retry(30_000) : { status: "done" };
        }
        const outstanding = [...pending.values()];
        if (row.retained && outstanding.some(({ retained }) => retained)) return retry(120_000);
        if (outstanding.filter(({ provider }) => provider === row.provider).length >= OUTSTANDING_MAX)
          return retry(30_000);
        const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(SAMPLE_DEADLINE_MS)]);
        const work = (async () => {
          const provider = await outputPhase("resolve_reader", async () =>
            row.provider === "docker" ? (docker?.(id) ?? {}) : providerFor(id),
          );
          if (row.retained) {
            return outputPhase("store_transfers", () =>
              collectRetained(sql, provider, row, job, key, deadline, writes, context.canDispatch),
            );
          } else {
            await outputPhase("publish_snapshot", () =>
              collect(sql, provider, id, row.provider_sandbox_id, row.scan, key, {
                signal: deadline,
                writes,
                job,
                canDispatch: context.canDispatch,
              }),
            );
          }
          return false;
        })();
        pending.set(work, { provider: row.provider, retained: row.retained });
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        try {
          if (await untilAborted(work, deadline)) return { status: "done" };
        } catch (error) {
          if (!context.signal.aborted)
            await reportCaptureFailure(
              sql,
              id,
              row.retained ? "retained" : "live",
              row.provider,
              error,
              deadline,
              job.generation,
            );
        }
        return retry(row.retained ? 120_000 : 30_000);
      },
    },
    async drain() {
      await Promise.allSettled([...writes]);
    },
    route(authenticate: (request: Request) => Promise<CallerResult>) {
      const list = sandboxOutputOperations.listSandboxOutputs;
      const read = sandboxOutputOperations.readSandboxOutput;
      const pattern = (path: string) => new URLPattern({ pathname: path.replaceAll(/\{(\w+)\}/g, ":$1") });
      const listPath = pattern(list.route.path);
      const readPath = pattern(read.route.path);
      return async (request: Request) => {
        const url = new URL(request.url);
        const download = readPath.exec(url);
        const match = download ?? listPath.exec(url);
        if (!match) return null;
        const operation = download ? read : list;
        const id = operation.input.path.id.safeParse(match.pathname.groups.id);
        if (!id.success) return null;
        if (request.method !== operation.route.method)
          return Response.json({ error: `Use ${operation.route.method}` }, { status: 405 });
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
        let name: string | undefined;
        if (download) {
          try {
            name = decodeURIComponent(download.pathname.groups.name ?? "");
          } catch {
            name = "";
          }
        }
        return readSnapshot(auth.caller, id.data, name, request.headers, request.signal);
      };
    },
  };
}

function outputRange(header: string, size: number) {
  const parsed = sandboxOutputOperations.readSandboxOutput.input.headers.Range.safeParse(header);
  if (!parsed.success || !size) return null;
  const [start, end] = parsed.data.slice("bytes=".length).split("-");
  const first = Number(start);
  const last = Number(end);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!start) return last > 0 ? { start: Math.max(0, size - last), end: size } : null;
  if (first >= size || (end && last < first)) return null;
  return { start: first, end: end ? Math.min(size, last + 1) : size };
}
