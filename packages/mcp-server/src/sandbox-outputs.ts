import { createHash } from "node:crypto";
import {
  admitOutputs,
  decryptSecret,
  encryptionKey,
  encryptSecret,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_FILES,
  type Provider,
  type Sql,
} from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";

// Native and enrolled-runtime Boat/Modal sandboxes: providers read the declared directory through
// their own fixed channel (Provider.readOutputs), never caller commands or the agent runtime.
// Application-secret taint is irreversible and forbids every file egress (same policy as exec and work recovery).
const ELIGIBLE = `provider in ('boat','modal') and not application_secret_tainted`;

/** SDKs may ignore cancellation once a request reached the provider. Callers wait at most until
 * their signal aborts; the outstanding read stays tracked, bounded and fenced from persisting. */
const OUTSTANDING_MAX = 4;

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
  provider: Provider,
  id: string,
  providerId: string,
  scan: string,
  key: string,
  signal?: AbortSignal,
  stopped = false,
) {
  const read = provider.readOutputs
    ? await provider.readOutputs({ sandboxId: providerId, ...(signal ? { signal } : {}) })
    : "retained_unreadable";
  if (read === "retained_unreadable") {
    // The backend can never read this stop's retained disk without compute (Modal recovery image):
    // keep the snapshot captured before it; no polling until the next stop.
    if (stopped)
      await sql.query(
        `update public.sandboxes set outputs_retained_at=now() where id=$1 and outputs_checked_at::text=$2`,
        [id, scan],
      );
    throw Error("output_collection_unsupported");
  }
  // Unavailable now (incomplete snapshot tree, transient failure): keep the previous snapshot and
  // retry after the scan fence. Only a successful retained read completes collection for a stop.
  if (!read) throw Error("output_collection_unavailable");
  // The caller's deadline has passed: a late read must never replace what callers saw since.
  signal?.throwIfAborted();
  const complete = read.complete !== false;
  const files = admitOutputs(read.files).map((file) => ({
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
  await sql.transaction(async (tx) => {
    const authority = await tx.query(
      `select id from public.sandboxes where id=$1 and status<>'deleted' and not application_secret_tainted
        and outputs_checked_at::text=$2 for update`,
      [id, scan],
    );
    if (!authority.rows.length) return;
    // Previously captured files a partial read (truncated listing) does not list are kept: unseen is
    // not deleted. Listed, verified files always win; unseen ones stay only while the merged
    // snapshot fits the same count and byte bounds (in name order).
    const kept: string[] = [];
    if (!complete) {
      let count = payload.length;
      let total = payload.reduce((sum, file) => sum + file.size, 0);
      const listed = new Set(payload.map((file) => file.name));
      const previous = await tx.query<{ name: string; size: number }>(
        `select name,size from public.sandbox_outputs where sandbox_id=$1 order by name`,
        [id],
      );
      for (const row of previous.rows) {
        if (listed.has(row.name) || count >= OUTPUT_MAX_FILES || total + row.size > OUTPUT_MAX_BYTES) continue;
        count++;
        total += row.size;
        kept.push(row.name);
      }
    }
    await tx.query(
      `with incoming as (select * from jsonb_to_recordset($2::jsonb) as f(name text,digest text,size integer,content text)),
      removed as (delete from public.sandbox_outputs where sandbox_id=$1 and name not in(select name from incoming) and name<>all($3::text[]))
      insert into public.sandbox_outputs(sandbox_id,name,digest,size,content_enc)
      select $1,name,digest,size,decode(content,'hex') from incoming
      on conflict(sandbox_id,name) do update set digest=excluded.digest,size=excluded.size,content_enc=excluded.content_enc,updated_at=now()
      where sandbox_outputs.digest<>excluded.digest`,
      [id, JSON.stringify(payload), kept],
    );
    // A retained-disk read is final for this stop: the workspace cannot change until compute resumes.
    if (read.retained) await tx.query(`update public.sandboxes set outputs_retained_at=now() where id=$1`, [id]);
  });
}

const finalPending = new Set<Promise<void>>();

/** Settle final captures that outlived their stop deadline (tests); late ones never persist. */
export async function drainFinalOutputs(): Promise<void> {
  await Promise.allSettled(finalPending);
}

/** Final capture on Armada's stop path: after quiesce, before provider stop revokes compute.
 * Needed where the stopped workspace cannot be read without compute (Modal recovery images);
 * Boat retained disks are also re-read after stop by the worker. Taking a new scan fence
 * prevents an older in-flight sample from replacing this snapshot. Never resumes compute. */
export async function captureFinalOutputs(
  sql: Sql,
  provider: Provider,
  id: string,
  options: { key?: string | undefined; signal?: AbortSignal } = {},
): Promise<void> {
  const key = options.key ?? encryptionKey();
  if (!key) return;
  // Earlier captures still hang in the provider SDK: skip rather than pile up; the snapshot stays.
  if (finalPending.size >= OUTSTANDING_MAX) throw Error("output_collection_busy");
  const row = (
    await sql.query<{ provider_sandbox_id: string; scan: string }>(
      `update public.sandboxes set outputs_checked_at=clock_timestamp()
      where id=$1 and status in ('ready','running','stopping') and provider_sandbox_id is not null and ${ELIGIBLE}
      returning provider_sandbox_id,outputs_checked_at::text as scan`,
      [id],
    )
  ).rows[0];
  if (!row) return;
  const work = collect(sql, provider, id, row.provider_sandbox_id, row.scan, key, options.signal);
  finalPending.add(work);
  void work.then(
    () => finalPending.delete(work),
    () => finalPending.delete(work),
  );
  // Stop dispatch waits at most until the caller's deadline, even if the provider SDK does not.
  await untilAborted(work, options.signal);
}

export function createSandboxOutputs(
  sql: Sql,
  key: string | undefined,
  providerFor: (id: string) => Promise<Provider>,
) {
  const pending = new Set<Promise<boolean>>();
  return {
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (!key || signal.aborted || pending.size >= OUTSTANDING_MAX) return false;
      const row = (
        await sql.query<{
          id: string;
          provider_sandbox_id: string;
          scan: string;
          stopped: boolean;
        }>(`update public.sandboxes set outputs_checked_at=now()
        where id=(select id from public.sandboxes where ${ELIGIBLE} and provider_sandbox_id is not null
        and (status in ('running','ready')
          -- Any stop (Armada, TTL, provider-initiated or reconciled later): read the retained disk once.
          or (status='stopped' and stopped_at>now()-interval '1 day'
            and (outputs_retained_at is null or outputs_retained_at<stopped_at)))
        and (outputs_checked_at is null or outputs_checked_at<now()-interval '30 seconds'
          or (status='stopped' and outputs_checked_at<stopped_at))
        order by outputs_checked_at nulls first for update skip locked limit 1) returning id,provider_sandbox_id,outputs_checked_at::text as scan,status='stopped' as stopped`)
      ).rows[0];
      if (!row) return false;
      // A per-sandbox failure (no python3, provider refusal, unreadable retained disk) is that sandbox's
      // problem: keep the previous snapshot, retry after the 30 s fence, and never stall
      // the shared worker loop.
      const work = providerFor(row.id)
        .then((provider) => collect(sql, provider, row.id, row.provider_sandbox_id, row.scan, key, signal, row.stopped))
        .catch(() => {
          console.warn(JSON.stringify({ event: "sandbox_output_collection_failed", sandboxId: row.id }));
        })
        .then(() => true);
      pending.add(work);
      void work.then(() => pending.delete(work));
      // The lane yields at the worker deadline so stop reconciliation and webhooks proceed;
      // the read stays tracked (drain, OUTSTANDING_MAX) and cannot persist after the deadline.
      return untilAborted(work, signal).catch(() => true);
    },
    async drain() {
      await Promise.allSettled(pending);
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
        const row = (
          await sql.query<{ id: string }>(
            `select s.id from public.sandboxes s join public.members m on m.org_id=s.org_id
          where s.id=$1 and s.status<>'deleted' and not s.application_secret_tainted and m.user_id=$2 and s.org_id=any($3::uuid[])
          and (s.owner_id=$2 or m.role='admin') and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
            [match[1], caller.userId, caller.orgs.map((o) => o.orgId)],
          )
        ).rows[0];
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
          return Response.json(
            { directory: OUTPUT_DIRECTORY, files: files.rows },
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
