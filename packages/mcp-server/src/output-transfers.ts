import { createHash } from "node:crypto";
import {
  OUTPUT_CHUNK_BYTES,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_ORG_BYTES,
  OUTPUT_MAX_SANDBOX_BYTES,
  type OutputEntry,
} from "@armada/core";
import { decryptSecret, encryptSecret, OutputCollectionError, type Provider, type Sql } from "@armada/core/server";

export type ChunkedOutputReader = Required<Pick<Provider, "listOutputEntries" | "readOutputChunk">> &
  Pick<Provider, "outputReadBytes">;

const CAN_WRITE = `not application_secret_tainted
          and (status in ('ready','running','stopping') or (status='failed' and stop_requested_at is not null and stopped_at is null))
          and (outputs_published_scan is null or outputs_published_scan<$2::timestamptz)`;

type Transfer = { id: string; received: number; digest: string | null };
type Skipped = "too_large" | "sandbox_limit" | "org_limit";
type PublishedFile = { name: string; size: number; skipped?: Skipped; digest?: string; transfer_id?: string };

export async function collectOutputTransfers(
  sql: Sql,
  provider: ChunkedOutputReader,
  id: string,
  request: { sandboxId: string; signal?: AbortSignal },
  scan: string,
  key: string,
  writes?: Set<Promise<unknown>>,
): Promise<void> {
  const { signal } = request;
  if (!sql.transaction) throw Error("output_transaction_unavailable");
  const transaction = sql.transaction.bind(sql);
  // All stage/publish writes share the existing sandbox taint and publication fence.
  async function update<T>(fn: (tx: Sql, orgId: string) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const work = transaction(async (tx) => {
      const sandbox = (
        await tx.query<{ org_id: string }>(
          `select org_id from public.sandboxes where id=$1 and ${CAN_WRITE} for update`,
          [id, scan],
        )
      ).rows[0];
      if (!sandbox) throw new OutputCollectionError("output_unavailable");
      signal?.throwIfAborted();
      const result = await fn(tx, sandbox.org_id);
      signal?.throwIfAborted();
      return result;
    });
    writes?.add(work);
    try {
      return (await work) as T;
    } finally {
      writes?.delete(work);
    }
  }

  const entries = await provider.listOutputEntries(request);
  if (!entries) throw new OutputCollectionError("output_unavailable");
  const planned = await update(async (tx, orgId) => {
    await tx.query(
      `delete from public.sandbox_output_transfers t where t.sandbox_id=$1 and t.scan<$2::timestamptz
        and not exists(select 1 from public.sandbox_outputs o where o.transfer_id=t.id)
        and not exists(select 1 from jsonb_to_recordset($3::jsonb) as e(name text,revision text,size bigint)
          where (e.name,e.revision,e.size)=(t.name,t.revision,t.size))`,
      [id, scan, JSON.stringify(entries)],
    );
    let remaining = await remainingOutputOrgBytes(tx, orgId);
    let sandboxBytes = 0;
    const files: { entry: OutputEntry; transfer?: Transfer; skipped?: Skipped }[] = [];
    for (const entry of entries) {
      const { name, size, revision } = entry;
      if (size > OUTPUT_MAX_FILE_BYTES) {
        files.push({ entry, skipped: "too_large" });
        continue;
      }
      if (sandboxBytes + size > OUTPUT_MAX_SANDBOX_BYTES) {
        files.push({ entry, skipped: "sandbox_limit" });
        continue;
      }
      let transfer = (
        await tx.query<Transfer>(
          `select id,received,digest from public.sandbox_output_transfers
          where sandbox_id=$1 and name=$2 and revision=$3 and size=$4`,
          [id, name, revision, size],
        )
      ).rows[0];
      if (!transfer && size > remaining) {
        files.push({ entry, skipped: "org_limit" });
        continue;
      }
      if (transfer) {
        // A concurrent older capture must not delete a revision this capture is still using.
        await tx.query("update public.sandbox_output_transfers set scan=greatest(scan,$2::timestamptz) where id=$1", [
          transfer.id,
          scan,
        ]);
      } else {
        transfer = (
          await tx.query<Transfer>(
            `insert into public.sandbox_output_transfers(sandbox_id,name,revision,size,scan)
            values($1,$2,$3,$4,$5) returning id,received,digest`,
            [id, name, revision, size, scan],
          )
        ).rows[0]!;
        remaining -= size;
      }
      sandboxBytes += size;
      files.push({ entry, transfer });
    }
    return files;
  });

  const readBytes = provider.outputReadBytes ?? OUTPUT_CHUNK_BYTES;
  const files: PublishedFile[] = [];
  for (const { entry, transfer, skipped } of planned) {
    const { name, size } = entry;
    if (!transfer) {
      files.push({ name, size, skipped: skipped! });
      continue;
    }
    for (let offset = transfer.received; offset < size; offset += readBytes) {
      signal?.throwIfAborted();
      // Repeat the current taint fence before each provider call, including long transfers.
      if (!(await sql.query(`select 1 from public.sandboxes where id=$1 and ${CAN_WRITE}`, [id, scan])).rows.length)
        throw new OutputCollectionError("output_unavailable");
      signal?.throwIfAborted();
      const bytes = await provider.readOutputChunk({ ...request, chunk: { entry, offset, length: readBytes } });
      const length = Math.min(readBytes, size - offset);
      if (!bytes || bytes.length !== length) throw new OutputCollectionError("output_unavailable");
      const parts: { byte_offset: number; content: string }[] = [];
      for (let start = 0; start < length; start += OUTPUT_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const content = await encryptSecret(
          Buffer.from(bytes.subarray(start, start + OUTPUT_CHUNK_BYTES)).toString("base64"),
          key,
        );
        parts.push({ byte_offset: offset + start, content: Buffer.from(content).toString("hex") });
      }
      await update(async (tx) => {
        const advanced = await tx.query(
          "update public.sandbox_output_transfers set received=$2 where id=$1 and received=$3 returning id",
          [transfer.id, offset + length, offset],
        );
        if (!advanced.rows.length) {
          const alreadySaved = await tx.query(
            "select 1 from public.sandbox_output_transfers where id=$1 and received >= $2",
            [transfer.id, offset + length],
          );
          if (alreadySaved.rows.length) return;
          throw new OutputCollectionError("output_busy");
        }
        await tx.query(
          `insert into public.sandbox_output_chunks(transfer_id,byte_offset,content_enc)
            select $1, p.byte_offset, decode(p.content,'hex')
            from jsonb_to_recordset($2::jsonb) as p(byte_offset integer, content text)`,
          [transfer.id, JSON.stringify(parts)],
        );
      });
    }
    const digest = transfer.digest ?? (await hashTransfer(sql, transfer.id, size, key, signal));
    if (!transfer.digest) {
      await update(async (tx) => {
        const saved = await tx.query(
          "update public.sandbox_output_transfers set digest=$2 where id=$1 and received=size returning id",
          [transfer.id, digest],
        );
        if (!saved.rows.length) throw new OutputCollectionError("output_busy");
      });
    }
    files.push({ name, size, digest, transfer_id: transfer.id });
  }

  await update(async (tx) => {
    await tx.query(
      `with incoming as (select * from jsonb_to_recordset($2::jsonb)
         as f(name text,size bigint,digest text,transfer_id uuid,skipped text)),
       removed as (delete from public.sandbox_outputs where sandbox_id=$1 and name not in(select name from incoming))
       insert into public.sandbox_outputs(sandbox_id,name,size,digest,transfer_id,skipped)
       select $1,name,size,digest,transfer_id,skipped from incoming
       on conflict(sandbox_id,name) do update set size=excluded.size,digest=excluded.digest,
         transfer_id=excluded.transfer_id,skipped=excluded.skipped,content_enc=null,
         updated_at=case when (sandbox_outputs.digest,sandbox_outputs.skipped,sandbox_outputs.size)
           is distinct from (excluded.digest,excluded.skipped,excluded.size) then now() else sandbox_outputs.updated_at end
       where (sandbox_outputs.transfer_id,sandbox_outputs.skipped,sandbox_outputs.size)
         is distinct from (excluded.transfer_id,excluded.skipped,excluded.size)`,
      [id, JSON.stringify(files)],
    );
    await tx.query(
      `delete from public.sandbox_output_transfers t where t.sandbox_id=$1 and t.scan<=$2::timestamptz
        and not exists(select 1 from public.sandbox_outputs o where o.transfer_id=t.id)`,
      [id, scan],
    );
    await tx.query("update public.sandboxes set outputs_published_scan=$2::timestamptz where id=$1", [id, scan]);
  });
}

/** Serialize chunk reservations and legacy publication for a single organization. */
export async function remainingOutputOrgBytes(tx: Sql, orgId: string): Promise<number> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1::text, 2629))", [orgId]);
  const usage = (
    await tx.query<{ bytes: string }>(
      `select (coalesce((select sum(t.size) from public.sandbox_output_transfers t
          join public.sandboxes s on s.id=t.sandbox_id where s.org_id=$1),0)
        + coalesce((select sum(o.size) from public.sandbox_outputs o
          join public.sandboxes s on s.id=o.sandbox_id where s.org_id=$1 and o.content_enc is not null),0))::text as bytes`,
      [orgId],
    )
  ).rows[0];
  return OUTPUT_MAX_ORG_BYTES - Number(usage?.bytes ?? 0);
}

async function hashTransfer(sql: Sql, id: string, size: number, key: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const { rows } = await sql.query<{ byte_offset: number; content_enc: Uint8Array<ArrayBuffer> }>(
      `select byte_offset,content_enc from public.sandbox_output_chunks
        where transfer_id=$1 and byte_offset >= $2 order by byte_offset limit 16`,
      [id, offset],
    );
    if (!rows.length) throw new OutputCollectionError("output_unavailable");
    for (const row of rows) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(await decryptSecret(row.content_enc, key), "base64");
      if (row.byte_offset !== offset || bytes.length !== Math.min(OUTPUT_CHUNK_BYTES, size - offset))
        throw new OutputCollectionError("output_unavailable");
      hash.update(bytes);
      offset += bytes.length;
    }
  }
  return hash.digest("hex");
}
