import { createHash } from "node:crypto";
import {
  OUTPUT_CHUNK_BYTES,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_FILES,
  OUTPUT_MAX_ORG_BYTES,
  OUTPUT_MAX_READ_BYTES,
  OUTPUT_MAX_SANDBOX_BYTES,
  type SandboxPlacementProviderId,
  validOutputName,
} from "@armada/core";
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
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";
import { BOAT_RETAINED_OUTPUT_STOP, collectOutputTransfers, remainingOutputOrgBytes } from "./output-transfers.ts";

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
): Promise<void> {
  const claim = await sql.query<OutputAttempt>(
    `update public.sandboxes
     set outputs_failure_reasons=array_append(outputs_failure_reasons,$2)
     where id=$1 and status<>'deleted' and not application_secret_tainted
     and not ($2 = any(outputs_failure_reasons))
     returning provider, status, outputs_attempt_count as "attemptCount"`,
    [id, reason],
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
  return "collector_failed";
}

/** Claim the first capability probe across the sample and final paths. A crashed claim
 * can be retried after the sampling interval, which is longer than either probe's deadline. */
async function probeOutputCapability(
  sql: Sql,
  provider: OutputReader,
  id: string,
  providerId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const claim = (
    await sql.query<{ probe: string }>(
      `update public.sandboxes set outputs_probe_at=clock_timestamp()
       where id=$1 and ${ELIGIBLE} and not outputs_collector_supported
       and (outputs_probe_at is null or outputs_probe_at<now()-interval '30 seconds')
       returning outputs_probe_at::text as probe`,
      [id],
    )
  ).rows[0];
  if (!claim) return false;
  signal?.throwIfAborted();
  const ready = await provider.probeOutputs!({ sandboxId: providerId, ...(signal ? { signal } : {}) }).catch(
    (error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    },
  );
  if (!ready) throw new OutputCollectionError("output_unavailable");
  signal?.throwIfAborted();
  const verified = await sql.query(
    `update public.sandboxes set outputs_collector_supported=true
     where id=$1 and outputs_probe_at=$2::timestamptz and ${ELIGIBLE} returning id`,
    [id, claim.probe],
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
  options: { signal?: AbortSignal | undefined; writes?: Set<Promise<unknown>>; final?: boolean },
) {
  const { signal, writes } = options;
  // A cancelled read never writes again (the worker's drain relies on it); readers stop at their next check.
  signal?.throwIfAborted();
  // Taint can commit after the scan claim (e.g. while the provider resolves): admit the read only
  // against current taint, immediately before dispatch (the same check-then-act fence exec uses).
  // Docker additionally refuses dispatch and redacts replies under the runtime session lock.
  const admitted = (
    await sql.query<{ outputs_collector_supported: boolean }>(
      `select outputs_collector_supported from public.sandboxes where id=$1 and ${ELIGIBLE}`,
      [id],
    )
  ).rows[0];
  if (!admitted) return;
  // Final capture never probes first. Its bounded read is the last chance to collect a deliverable,
  // and the read's own exit status classifies an unsupported collector, so a transient or parallel
  // probe never costs that read. A recorded `collector_unsupported` was already excluded above:
  // a collector known to be unavailable adds no delay to stop.
  if (provider.probeOutputs && !admitted.outputs_collector_supported && !options.final) {
    if (!(await probeOutputCapability(sql, provider, id, providerId, signal))) return;
  }
  signal?.throwIfAborted();
  if (provider.listOutputEntries && provider.readOutputChunk) {
    try {
      await collectOutputTransfers(
        sql,
        {
          ...(provider.outputReadConcurrency !== undefined
            ? { outputReadConcurrency: provider.outputReadConcurrency }
            : {}),
          ...(provider.outputReadBytes !== undefined ? { outputReadBytes: provider.outputReadBytes } : {}),
          listOutputEntries: provider.listOutputEntries.bind(provider),
          readOutputChunk: provider.readOutputChunk.bind(provider),
        },
        id,
        { sandboxId: providerId, ...(signal ? { signal } : {}) },
        scan,
        key,
        writes,
      );
      return;
    } catch (error) {
      // Runtimes enrolled before chunk support still serve their original small snapshots.
      if (!(error instanceof OutputCollectionError) || error.reason !== "output_protocol_unsupported") throw error;
    }
  }
  signal?.throwIfAborted();
  const read = provider.readOutputs
    ? await provider.readOutputs({ sandboxId: providerId, ...(signal ? { signal } : {}) })
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
        and (outputs_published_scan is null or outputs_published_scan<$2::timestamptz) for update`,
      [id, scan],
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
      await sql.query<{ provider: SandboxPlacementProviderId; provider_sandbox_id: string; scan: string }>(
        `update public.sandboxes set outputs_checked_at=clock_timestamp(), outputs_attempt_count=outputs_attempt_count+1
        where id=$1 and stopped_at is null and (status in ('ready','running','stopping') or (status='failed' and stop_requested_at is not null))
        and provider_sandbox_id is not null and ${ELIGIBLE}
        returning provider,provider_sandbox_id,outputs_checked_at::text as scan`,
        [id],
      )
    ).rows[0];
    if (!row) return;
    signal?.throwIfAborted();
    // Only overdue captures from this provider count. Live concurrent stops all get a read.
    if ([...finalLate.values()].filter((kind) => kind === row.provider).length >= OUTSTANDING_MAX)
      throw new OutputCollectionError("output_busy");
    providerKind = row.provider;
    try {
      await collect(sql, provider, id, row.provider_sandbox_id, row.scan, key, { signal, final: true });
    } catch (error) {
      if (
        error instanceof OutputCollectionError &&
        (error.reason === "collector_unsupported" || error.reason === "output_directory_missing")
      ) {
        await recordOutputFailure(sql, id, "sandbox_output_final_capture_failed", error.reason);
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
    void recordOutputFailure(sql, id, "sandbox_output_final_capture_failed", failureReason(error, signal)).catch(
      () => {},
    );
    throw error;
  }
}

async function collectRetained(
  sql: Sql,
  provider: OutputReader,
  row: OutputAttempt & { id: string; provider_sandbox_id: string; scan: string },
  generation: string,
  key: string,
  signal: AbortSignal,
  writes: Set<Promise<unknown>>,
) {
  const fence = `id=$1 and outputs_checked_at=$2::timestamptz and lifecycle_generation=$3::bigint
    and provider_sandbox_id=$4 and not application_secret_tainted and ${BOAT_RETAINED_OUTPUT_STOP}`;
  const args = [row.id, row.scan, generation, row.provider_sandbox_id];
  if (!(await sql.query(`select 1 from public.sandboxes where ${fence}`, args)).rows.length) return;
  signal.throwIfAborted();
  const snapshot = await provider.openRetainedOutputs?.({ sandboxId: row.provider_sandbox_id, signal });
  signal.throwIfAborted();
  if (snapshot === "pending") return;
  if (snapshot === "gone") {
    const write = sql.query(
      `update public.sandboxes set outputs_retained_generation=$3::bigint where ${fence} returning id`,
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
    return;
  }
  if (!snapshot) throw new OutputCollectionError("output_unavailable");
  await collectOutputTransfers(
    sql,
    {
      outputReadBytes: OUTPUT_MAX_READ_BYTES,
      listOutputEntries: async () => snapshot.entries,
      readOutputChunk: async ({ chunk }) => snapshot.readChunk(chunk),
    },
    row.id,
    { sandboxId: row.provider_sandbox_id, signal },
    row.scan,
    key,
    writes,
    generation,
  );
}

export function createSandboxOutputs(
  sql: Sql,
  key: string | undefined,
  providerFor: (id: string) => Promise<OutputReader>,
  docker?: (id: string) => OutputReader,
) {
  /** In-flight samples with their deadline: provider SDK work may outlive cancellation. */
  const pending = new Map<
    Promise<boolean>,
    { deadline: AbortSignal; provider: SandboxPlacementProviderId; retained: boolean }
  >();
  /** Snapshot transactions in progress (never started once a sample's deadline aborted). */
  const writes = new Set<Promise<unknown>>();
  return {
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (!key || signal.aborted) return false;
      // Keep the shared limit for live work. Uncancellable calls retain capacity only
      // in their own provider's budget after their deadline, so another provider can proceed.
      const outstanding = [...pending.values()];
      if (outstanding.filter(({ deadline }) => !deadline.aborted).length >= OUTSTANDING_MAX) return false;
      const saturated = [...new Set(outstanding.map(({ provider }) => provider))].filter(
        (kind) => outstanding.filter(({ provider }) => provider === kind).length >= OUTSTANDING_MAX,
      );
      const row = (
        await sql.query<
          OutputAttempt & {
            id: string;
            provider_sandbox_id: string;
            scan: string;
            retained_generation: string | null;
          }
        >(
          `update public.sandboxes set outputs_checked_at=clock_timestamp(), outputs_attempt_count=outputs_attempt_count+1
        where id=(select id from public.sandboxes where not application_secret_tainted and provider_sandbox_id is not null
        and provider::text <> all($1::text[]) and (
          (${ELIGIBLE} and status in ('running','ready') and stopped_at is null
            and (outputs_checked_at is null or outputs_checked_at<now()-interval '30 seconds'))
          or ($2::boolean and ${BOAT_RETAINED_CANDIDATE} and (outputs_checked_at is null or outputs_checked_at<now()-interval '2 minutes'))
        )
        order by outputs_checked_at nulls first for update skip locked limit 1)
        returning id,provider::text,status,outputs_attempt_count as "attemptCount",provider_sandbox_id,outputs_checked_at::text as scan,
          case when ${BOAT_RETAINED_OUTPUT_STOP} then lifecycle_generation::text end as retained_generation`,
          [saturated, !outstanding.some(({ retained }) => retained)],
        )
      ).rows[0];
      if (!row) return false;
      // The sample runs in the background under its own deadline (and the worker's shutdown), so
      // stop reconciliation, webhooks and other lanes never wait for a provider read. At most
      // OUTSTANDING_MAX live samples share the worker, and a late one never persists.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SAMPLE_DEADLINE_MS)]);
      if (deadline.aborted) return false;
      const reader = row.provider === "docker" ? Promise.resolve(docker?.(row.id) ?? {}) : providerFor(row.id);
      const work = reader
        .then((provider) =>
          row.retained_generation != null
            ? collectRetained(sql, provider, row, row.retained_generation, key, deadline, writes)
            : collect(sql, provider, row.id, row.provider_sandbox_id, row.scan, key, { signal: deadline, writes }),
        )
        .catch((error: unknown) =>
          recordOutputFailure(sql, row.id, "sandbox_output_collection_failed", failureReason(error, deadline)).catch(
            () => {},
          ),
        )
        .then(() => true);
      pending.set(work, { deadline, provider: row.provider, retained: row.retained_generation != null });
      void work.then(() => pending.delete(work));
      return true;
    },
    /** Shutdown aborts every sample's deadline first. A cancelled sample never starts a write
     * (`collect` and the Docker reader check its deadline before each), so drain waits for samples that settle
     * and for snapshot writes already in progress, never for a provider call that ignores
     * cancellation (a read still in flight can only fail once the pool closes; its result is discarded). */
    async drain() {
      await Promise.allSettled([...pending].map(([work, { deadline }]) => untilAborted(work, deadline)));
      await Promise.allSettled([...writes]);
    },
    route(authenticate: (request: Request) => Promise<CallerResult>): Route {
      return async (request) => {
        const url = new URL(request.url);
        const match =
          /^\/api\/v1\/sandboxes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/outputs(?:\/([^/]+))?$/.exec(
            url.pathname,
          );
        if (!match) return null;
        if (request.method !== "GET") return Response.json({ error: "Use GET" }, { status: 405 });
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
        const caller = auth.caller;
        // Owner or org admin, current membership: checked on entry and again after the snapshot
        // is read (and decrypted), so access revoked meanwhile never receives metadata or bytes.
        const authorize = async () =>
          (
            await sql.query<{ id: string; outputs_failure_reasons: string[] }>(
              `select s.id,s.outputs_failure_reasons from public.sandboxes s join public.members m on m.org_id=s.org_id
          where s.id=$1 and s.status<>'deleted' and not s.application_secret_tainted and m.user_id=$2 and s.org_id=any($3::uuid[])
          and (s.owner_id=$2 or m.role='admin') and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
              [match[1], caller.userId, caller.orgs.map((o) => o.orgId)],
            )
          ).rows[0];
        const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
        const row = await authorize();
        if (!row) return Response.json({ error: "not_found" }, { status: 404 });
        let name: string | null;
        try {
          name = match[2] ? decodeURIComponent(match[2]) : null;
        } catch {
          return Response.json({ error: "invalid_name" }, { status: 400 });
        }
        if (!name) {
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
        if (!validOutputName(name)) return Response.json({ error: "invalid_name" }, { status: 400 });
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
        const ifRange = request.headers.get("if-range");
        const requestedRange = !ifRange || ifRange === etag ? request.headers.get("range") : null;
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
                    request.signal.throwIfAborted();
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
                    request.signal.throwIfAborted();
                    if (buffer.length !== Math.min(size - base, OUTPUT_CHUNK_BYTES))
                      throw Error("invalid_output_chunk");
                    const next = Math.min(end, base + buffer.length);
                    controller.enqueue(buffer.subarray(offset - base, next - base));
                    offset = next;
                    if (offset === end) controller.close();
                  },
                },
                { highWaterMark: 0 },
              )
            : null;
        const type = new Blob([], { type: Bun.file(file.name).type }).type || "application/octet-stream";
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
      };
    },
  };
}

function outputRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size } : null;
  if (first >= size || (match[2] && last < first)) return null;
  return { start: first, end: match[2] ? Math.min(size, last + 1) : size };
}
