import { templateLaunchResponse } from "@armada/core/contract";
import type { Sql } from "@armada/core/server";
import { scopeKey } from "@armada/provider-modal";
import { z } from "zod";
import { isFullModalDrainTombstone } from "./modal-drain-journal.ts";

const version = z.string().regex(/^\d+$/);
const binding = z.strictObject({
  workspace: z.string().min(1),
  environment: z.string().min(1),
  appId: z.string().min(1),
});
const evidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("delete-tombstone"), journalVersion: version }),
  z.strictObject({
    kind: z.literal("confirmed-absence"),
    reference: z.string().trim().min(1),
    journalVersion: version.optional(),
  }),
  z.strictObject({
    kind: z.literal("original-receipt"),
    reference: z.string().trim().min(1),
    journalVersion: version,
    receipt: templateLaunchResponse.and(
      z.object({ requestId: z.uuid(), id: z.uuid(), state: z.literal("succeeded"), provider: z.literal("modal") }),
    ),
  }),
]);
const reviewedRows = z
  .array(
    z.strictObject({
      requestId: z.uuid(),
      sandboxId: z.uuid(),
      orgId: z.uuid(),
      actorId: z.uuid(),
      receiptVersion: version,
      sandboxVersion: version.nullable(),
      binding,
      visibility: z.enum(["org", "private"]),
      evidence,
    }),
  )
  .min(1)
  .refine((rows) => new Set(rows.map((row) => row.requestId)).size === rows.length);

type ReviewedRow = z.infer<typeof reviewedRows>[number];
type Decision = ReviewedRow["evidence"]["kind"] | "deferred" | "already-terminal" | "busy";

// WARNING: Keep NOWAIT on authority locks because ingest and lifecycle transactions may acquire them in a different order.
const lockAuthority = `lock table public.sandboxes, public.modal_machines,
  public.jobs, public.provider_launch_requests, public.runtime_resumes,
  public.ordinary_launch_snapshot_intents in share mode nowait`;

const nonterminalResult = `(r.result is null or (
  r.result->>'state'='reconciling' and r.result->>'requestId'=r.id::text and r.result->>'id'=r.sandbox_id::text
))`;

async function inspect(tx: Sql, row: ReviewedRow, dryRun: boolean) {
  const {
    rows: [receipt],
  } = await tx.query<{
    state: string;
    current: boolean;
    result_can_settle: boolean;
    sandbox_matches: boolean;
    has_sandbox: boolean;
    sandbox_deleted: boolean;
    provider_id: string | null;
    active: boolean;
    original_manifest_matches: boolean;
  }>(
    `select r.state, r.xmin::text=$5 as current, ${nonterminalResult} as result_can_settle,
       case when s.id is null then $6::text is null else
         coalesce(s.xmin::text=$6 and s.provider='modal' and s.org_id=r.org_id and s.owner_id=r.actor_id
           and s.golden_id::text=r.manifest#>>'{golden,id}',false) end as sandbox_matches,
       s.id is not null as has_sandbox,
       s.deleted_at is not null as sandbox_deleted, s.provider_sandbox_id as provider_id,
       case when jsonb_typeof($9::jsonb)='object' then ($9::jsonb - 'skillReceipts')=r.manifest
         else false end as original_manifest_matches,
       (coalesce(s.reconcile_lease_until>clock_timestamp(),false)
        or coalesce(s.activity_until>clock_timestamp(),false)
        or (s.stop_requested_at is not null and s.deleted_at is null)
        or exists(select 1 from public.provider_launch_requests p where p.sandbox_id=r.sandbox_id
          and (p.phase not in ('succeeded','failed','cancelled') or p.lease_expires_at>clock_timestamp()))
        or exists(select 1 from public.jobs j where j.sandbox_id=r.sandbox_id
          and (j.kind='launch' or j.state in ('queued','leased')))
        or exists(select 1 from public.runtime_resumes a where a.sandbox_id=r.sandbox_id and a.phase='dispatched')
        or exists(select 1 from public.ordinary_launch_snapshot_intents i where i.sandbox_id=r.sandbox_id)
       ) as active
     from public.template_launch_requests r left join public.sandboxes s on s.id=r.sandbox_id
     where r.id=$1 and r.sandbox_id=$2 and r.org_id=$3 and r.actor_id=$4
       and r.manifest#>>'{golden,provider}'='modal'
       and r.manifest#>'{golden,modal}' @> $7::jsonb
       and r.manifest#>>'{golden,visibility}'=$8
       and r.created_at < timestamptz '2026-11-22 13:39:16+00'
     ${dryRun ? "" : "for update of r nowait"}`,
    [
      row.requestId,
      row.sandboxId,
      row.orgId,
      row.actorId,
      row.receiptVersion,
      row.sandboxVersion,
      JSON.stringify(row.binding),
      row.visibility,
      JSON.stringify(
        row.evidence.kind === "original-receipt"
          ? ((row.evidence.receipt as Record<string, unknown>).manifest ?? null)
          : null,
      ),
    ],
  );
  if (receipt?.state === "succeeded" || receipt?.state === "failed") return "already-terminal";
  if (
    !receipt?.current ||
    receipt.state !== "reconciling" ||
    !receipt.result_can_settle ||
    !receipt.sandbox_matches ||
    receipt.active
  )
    return "deferred";

  const { rows: journals } = await tx.query<{
    id: string;
    matches: boolean;
    closed: boolean;
    idle: boolean;
    version: string;
  }>(
    `select m.id, (m.scope=$3 and m.owner_id=$4 and m.record->>'golden'='false'
        and m.record#>>'{info,labels,sandbox}'=$2
        and m.record#>>'{info,labels,org}'=$1::uuid::text
        and m.record#>>'{info,labels,owner}'=$4::uuid::text) as matches,
       ((m.lease_id is null and m.lease_until is null) or
          (m.lease_id is not null and m.lease_until<=clock_timestamp())) as idle,
       (${isFullModalDrainTombstone("m.record")}) as closed, m.xmin::text as version
     from public.modal_machines m
     where m.org_id=$1 and (m.request_key=$2 or m.id=$5 or m.record#>>'{info,labels,sandbox}'=$2)`,
    [
      row.orgId,
      row.sandboxId,
      scopeKey({ orgId: row.orgId, userId: row.actorId, visibility: row.visibility, binding: row.binding }),
      row.actorId,
      receipt.provider_id,
    ],
  );
  const journal = journals[0];
  const proof = row.evidence;
  const reviewedIdleJournal =
    journals.length === 1 &&
    journal?.matches &&
    journal.idle &&
    journal.version === proof.journalVersion &&
    (receipt.provider_id === null || journal.id === receipt.provider_id);
  let result: Record<string, unknown>;
  if (proof.kind === "original-receipt") {
    const original = proof.receipt;
    if (
      original.requestId !== row.requestId ||
      original.id !== row.sandboxId ||
      !receipt.original_manifest_matches ||
      !receipt.has_sandbox ||
      !receipt.provider_id ||
      original.providerSandboxId !== receipt.provider_id ||
      !reviewedIdleJournal
    )
      return "deferred";
    result = original;
  } else {
    if (receipt.has_sandbox && !receipt.sandbox_deleted) return "deferred";
    if (proof.kind === "delete-tombstone" && (!reviewedIdleJournal || !journal?.closed)) return "deferred";
    if (proof.kind === "confirmed-absence" && (proof.journalVersion ? !reviewedIdleJournal : journals.length !== 0))
      return "deferred";
    result = {
      requestId: row.requestId,
      id: row.sandboxId,
      state: "failed",
      reason: "historical_modal_launch_closed",
      message: "The prior Modal template launch could not be confirmed and has been closed.",
    };
  }
  if (dryRun) return proof.kind;
  const changed = await tx.query(
    `update public.template_launch_requests as r
     set state=$3, reason=$4, result=jsonb_build_object('manifest',manifest) || $5::jsonb, updated_at=clock_timestamp()
     where r.id=$1 and r.xmin::text=$2 and r.state='reconciling' and ${nonterminalResult} returning r.id`,
    [row.requestId, row.receiptVersion, result.state, result.reason ?? null, JSON.stringify(result)],
  );
  return changed.rows.length === 1 ? proof.kind : "deferred";
}

export async function settleModalTemplateReceipts(sql: Sql, input: unknown, dryRun: boolean) {
  if (!sql.transaction) throw new Error("Template receipt settlement requires database transactions.");
  const rows = reviewedRows.parse(input);
  const decisions: Decision[] = [];
  for (const row of rows) {
    try {
      decisions.push(
        await sql.transaction(async (tx) => {
          if (dryRun) await tx.query("set transaction isolation level repeatable read read only");
          await tx.query("set local row_security = off");
          await tx.query("set local statement_timeout = '5s'");
          if (!dryRun) await tx.query(lockAuthority);
          return inspect(tx, row, dryRun);
        }),
      );
    } catch (error) {
      if ((error as { errno?: string }).errno !== "55P03" && (error as { code?: string }).code !== "55P03") throw error;
      decisions.push("busy");
    }
  }
  return decisions.map((decision, index) => ({ row: index + 1, decision }));
}
