import { createHash } from "node:crypto";
import {
  admitOutputs,
  decryptSecret,
  encryptionKey,
  encryptSecret,
  outputDirectory,
  type Provider,
  type Sql,
} from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";

// Native and enrolled-runtime Boat/Modal sandboxes: providers read the declared directory through
// their own fixed channel (Provider.readOutputs), never caller commands or the agent runtime.
// Docker sandboxes have no provider exec; their reader is the runtime's fixed read-only operation.
// Application-secret taint is irreversible and forbids every file egress (same policy as exec and work recovery).
const ELIGIBLE = `provider in ('boat','modal','docker') and not application_secret_tainted`;

/** The only provider surface output collection uses. */
type OutputReader = Pick<Provider, "readOutputs">;

/** SDKs may ignore cancellation once a request reached the provider. Callers wait at most until
 * their signal aborts; the outstanding read stays tracked, bounded and fenced from persisting. */
const OUTSTANDING_MAX = 4;
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

async function collect(
  sql: Sql,
  provider: OutputReader,
  id: string,
  providerId: string,
  scan: string,
  key: string,
  signal?: AbortSignal,
  writes?: Set<Promise<unknown>>,
) {
  // A cancelled read never touches the database again (the worker's drain relies on it).
  signal?.throwIfAborted();
  // Taint can commit after the scan claim (e.g. while the provider resolves): admit the read only
  // against current taint, immediately before dispatch (the same check-then-act fence exec uses).
  // Docker additionally refuses dispatch and redacts replies under the runtime session lock.
  const admitted = await sql.query(`select 1 from public.sandboxes where id=$1 and not application_secret_tainted`, [
    id,
  ]);
  if (!admitted.rows.length) throw Error("output_collection_tainted");
  signal?.throwIfAborted();
  const read = provider.readOutputs
    ? await provider.readOutputs({ sandboxId: providerId, ...(signal ? { signal } : {}) })
    : null;
  // Not live or a failed read: keep the previous snapshot; running sandboxes retry after the fence.
  if (!read) throw Error("output_collection_unavailable");
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
    const authority = await tx.query(
      `select id from public.sandboxes where id=$1 and status<>'deleted' and not application_secret_tainted
        and (outputs_published_scan is null or outputs_published_scan<$2::timestamptz) for update`,
      [id, scan],
    );
    // A newer read (e.g. a pre-stop capture claimed after this sample) already committed: never go
    // back. An older read whose newer rival failed still publishes what live compute held.
    if (!authority.rows.length) return;
    signal?.throwIfAborted();
    await tx.query(
      `with incoming as (select * from jsonb_to_recordset($2::jsonb) as f(name text,digest text,size integer,content text)),
      removed as (delete from public.sandbox_outputs where sandbox_id=$1 and name not in(select name from incoming))
      insert into public.sandbox_outputs(sandbox_id,name,digest,size,content_enc)
      select $1,name,digest,size,decode(content,'hex') from incoming
      on conflict(sandbox_id,name) do update set digest=excluded.digest,size=excluded.size,content_enc=excluded.content_enc,updated_at=now()
      where sandbox_outputs.digest<>excluded.digest`,
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
const finalLate = new Set<Promise<void>>();

/** Settle final captures that outlived their stop deadline (tests); late ones never persist. */
export async function drainFinalOutputs(): Promise<void> {
  await Promise.allSettled(finalLate);
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
  // Earlier captures outlived their deadline and still hang in the provider SDK: skip rather than
  // pile up; the snapshot stays. Concurrent stops that are still within their deadline never count.
  if (finalLate.size >= OUTSTANDING_MAX) throw Error("output_collection_busy");
  const { signal } = options;
  // The whole capture is bounded, from the scan claim on: a claim that waits on a row lock or a
  // pool connection must not hold stop dispatch either, and a claim that returns after the
  // deadline never reaches the provider.
  const work = (async () => {
    // An expired capture must not even claim a scan.
    signal?.throwIfAborted();
    // Live compute only: an admitted stop keeps 'failed' rows failed while compute may still run.
    const row = (
      await sql.query<{ provider_sandbox_id: string; scan: string }>(
        `update public.sandboxes set outputs_checked_at=clock_timestamp()
        where id=$1 and (status in ('ready','running','stopping') or (status='failed' and stop_requested_at is not null and stopped_at is null))
        and provider_sandbox_id is not null and ${ELIGIBLE}
        returning provider_sandbox_id,outputs_checked_at::text as scan`,
        [id],
      )
    ).rows[0];
    if (!row) return;
    signal?.throwIfAborted();
    await collect(sql, provider, id, row.provider_sandbox_id, row.scan, key, signal);
  })();
  work.catch(() => {});
  // Stop dispatch waits at most until the caller's deadline, even if the provider SDK does not.
  try {
    await untilAborted(work, signal);
  } catch (error) {
    if (signal?.aborted) {
      finalLate.add(work);
      void work.catch(() => {}).finally(() => finalLate.delete(work));
    }
    throw error;
  }
}

export function createSandboxOutputs(
  sql: Sql,
  key: string | undefined,
  providerFor: (id: string) => Promise<OutputReader>,
  docker?: (id: string) => OutputReader,
) {
  /** In-flight samples with their deadline: provider SDK work may outlive cancellation. */
  const pending = new Map<Promise<boolean>, AbortSignal>();
  /** Snapshot transactions in progress (never started once a sample's deadline aborted). */
  const writes = new Set<Promise<unknown>>();
  return {
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (!key || signal.aborted || pending.size >= OUTSTANDING_MAX) return false;
      const row = (
        await sql.query<{
          id: string;
          provider: string;
          provider_sandbox_id: string;
          scan: string;
        }>(`update public.sandboxes set outputs_checked_at=clock_timestamp()
        where id=(select id from public.sandboxes where ${ELIGIBLE} and provider_sandbox_id is not null
        and status in ('running','ready') and (outputs_checked_at is null or outputs_checked_at<now()-interval '30 seconds')
        order by outputs_checked_at nulls first for update skip locked limit 1) returning id,provider::text,provider_sandbox_id,outputs_checked_at::text as scan`)
      ).rows[0];
      if (!row) return false;
      // The sample runs in the background under its own deadline (and the worker's shutdown), so
      // stop reconciliation, webhooks and other lanes never wait for a provider read. At most
      // OUTSTANDING_MAX samples are in flight; drain() settles them; a late one never persists.
      // A per-sandbox failure (no python3, provider refusal, compute stopping) is that sandbox's
      // problem: keep the previous snapshot and retry after the 30 s fence.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SAMPLE_DEADLINE_MS)]);
      const reader = row.provider === "docker" ? Promise.resolve(docker?.(row.id) ?? {}) : providerFor(row.id);
      const work = reader
        .then((provider) => collect(sql, provider, row.id, row.provider_sandbox_id, row.scan, key, deadline, writes))
        .catch(() => {
          console.warn(JSON.stringify({ event: "sandbox_output_collection_failed", sandboxId: row.id }));
        })
        .then(() => true);
      pending.set(work, deadline);
      void work.then(() => pending.delete(work));
      return true;
    },
    /** Shutdown aborts every sample's deadline first. A cancelled sample never starts another query
     * or write (`collect` checks its deadline before each), so drain waits for samples that settle
     * and for snapshot writes already in progress, never for a provider call that ignores
     * cancellation (it can only fail once the pool closes; its result is discarded). */
    async drain() {
      await Promise.allSettled([...pending].map(([work, deadline]) => untilAborted(work, deadline)));
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
            await sql.query<{ id: string; provider: string }>(
              `select s.id,s.provider::text from public.sandboxes s join public.members m on m.org_id=s.org_id
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
          const files = await sql.query(
            `select name,size,digest as sha256,updated_at as "updatedAt" from public.sandbox_outputs where sandbox_id=$1 order by name limit 32`,
            [row.id],
          );
          if (!(await authorize())) return notFound();
          return Response.json(
            { directory: outputDirectory(row.provider), files: files.rows },
            { headers: { "cache-control": "private, no-store" } },
          );
        }
        const file = (
          await sql.query<{ name: string; content_enc: Uint8Array<ArrayBuffer> }>(
            `select name,content_enc from public.sandbox_outputs where sandbox_id=$1 and name=$2`,
            [row.id, name],
          )
        ).rows[0];
        if (!file) return Response.json({ error: "not_found" }, { status: 404 });
        if (!key) return Response.json({ error: "unavailable" }, { status: 503 });
        const bytes = Buffer.from(await decryptSecret(file.content_enc, key), "base64");
        if (!(await authorize())) return notFound();
        const type = new Blob([], { type: Bun.file(file.name).type }).type || "application/octet-stream";
        return new Response(bytes, {
          headers: {
            "content-type": type,
            "content-length": String(bytes.length),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
          },
        });
      };
    },
  };
}
