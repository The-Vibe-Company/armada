import { createHash } from "node:crypto";
import type { Sql } from "@armada/core/server";
import { lifecycleNow } from "./orchestrator-lifecycle-contract.ts";

export interface WaitEvidence {
  orchestratorId: string;
  generation: string;
  kind: "ci" | "child" | "external" | "task";
  reference: string;
  identity: string;
  at: Date;
  state: "active" | "complete" | "unknown";
}
/** Server-owned registry, not a URL fetcher. It must authorize repository/run/task ownership
 * and derive source identity/time from actual runtime/CI receipts. Unknown never means done. */
export interface WaitEvidenceSource {
  inspect(input: {
    orchestratorId: string;
    generation: string;
    kind: WaitEvidence["kind"];
    reference: string;
  }): Promise<WaitEvidence>;
}

export function createOrchestratorWaits(sql: Sql, source: WaitEvidenceSource, clock?: () => Date) {
  return {
    /** Owner API only. Delegated arbitrary wait authority is not supplied by #661 v1.
     * child waits are protected independently by persisted active-child observations. */
    async record(input: {
      key: string;
      orchestratorId: string;
      ownerId: string;
      expectedRevision: number;
      generation: string;
      kind: WaitEvidence["kind"];
      reference: string;
      reason: string;
      expiresAt?: string;
    }): Promise<{ id: string; expiresAt: string; deadline: string; released: boolean }> {
      if (
        !sql.transaction ||
        !/^[ -~]{1,128}$/.test(input.key) ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(input.reference) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        !input.reference ||
        input.reference.length > 512 ||
        (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) ||
        !input.reason.trim() ||
        input.reason.length > 512
      )
        throw new Error("Invalid wait request.");
      const digest = createHash("sha256")
        .update(
          JSON.stringify([input.expectedRevision, input.kind, input.reference, input.reason, input.expiresAt ?? null]),
        )
        .digest("hex");
      const priorResult = async (tx: Sql) => {
        const prior = (
          await tx.query<{
            request_digest: string;
            result: { id: string; expiresAt: string; deadline: string; released: boolean };
          }>(
            `select w.request_digest,w.result from public.orchestrator_lifecycle_mutations w
           join public.orchestrators o on o.id=w.orchestrator_id
           join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
           where w.orchestrator_id=$1 and w.actor_id=$2 and o.owner_id=$2 and w.action=$3 and w.target=$4 and w.idempotency_key=$5`,
            [input.orchestratorId, input.ownerId, `wait:${input.kind}`, input.reference, input.key],
          )
        ).rows[0];
        if (prior && prior.request_digest !== digest) throw new Error("Idempotency conflict.");
        return prior?.result;
      };
      const prior = await priorResult(sql);
      if (prior) return prior;
      const evidence = await source.inspect(input);
      const now = await lifecycleNow(sql, clock);
      if (
        evidence.orchestratorId !== input.orchestratorId ||
        evidence.generation !== input.generation ||
        evidence.reference !== input.reference ||
        evidence.kind !== input.kind ||
        evidence.state === "unknown" ||
        !evidence.identity ||
        evidence.identity.length > 512 ||
        !Number.isFinite(evidence.at.getTime()) ||
        evidence.at > now ||
        now.getTime() - evidence.at.getTime() > 60_000
      )
        throw new Error("Wait evidence unavailable or stale.");
      return sql.transaction(async (tx) => {
        const parent = (
          await tx.query<{ revision: string; lifecycle_generation: string }>(
            `select o.revision,s.lifecycle_generation from public.orchestrators o
           join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
           join public.sandboxes s on s.id=o.sandbox_id
           where o.id=$1 and o.owner_id=$2 and (o.state='ready' or ($3::boolean and o.state='blocked' and exists(
             select 1 from public.orchestrator_lifecycle l where l.orchestrator_id=o.id and l.reason='wait_cap_exhausted'))) and s.stop_requested_at is null
           for update of o,m,s`,
            [input.orchestratorId, input.ownerId, evidence.state === "complete"],
          )
        ).rows[0];
        const raced = await priorResult(tx);
        if (raced) return raced;
        if (
          !parent ||
          String(parent.lifecycle_generation) !== input.generation ||
          Number(parent.revision) !== input.expectedRevision
        )
          throw new Error("Stale or unavailable orchestrator.");
        if (
          (
            await tx.query(
              `select id from public.orchestrator_operations where orchestrator_id=$1 and state in ('pending','uncertain')`,
              [input.orchestratorId],
            )
          ).rows.length
        )
          throw new Error("Orchestrator owner operation is busy.");
        const prior = (
          await tx.query<{
            id: string;
            evidence: string;
            evidence_at: Date | string;
            deadline: Date | string;
            released_at: Date | string | null;
          }>(
            `select id,evidence,evidence_at,deadline,released_at from public.orchestrator_waits
           where orchestrator_id=$1 and kind=$2 and reference=$3 for update`,
            [input.orchestratorId, input.kind, input.reference],
          )
        ).rows[0];
        if (
          prior &&
          (prior.released_at ||
            (new Date(prior.deadline) <= now && evidence.state !== "complete") ||
            prior.evidence === evidence.identity ||
            new Date(prior.evidence_at) >= evidence.at)
        )
          throw new Error("Wait cannot renew without new evidence inside its original deadline.");
        const deadline = prior ? new Date(prior.deadline) : new Date(now.getTime() + 86_400_000);
        const ceiling = Math.min(evidence.at.getTime() + 900_000, deadline.getTime());
        const requested = input.expiresAt === undefined ? ceiling : Date.parse(input.expiresAt);
        if (evidence.state !== "complete" && (requested <= now.getTime() || requested > ceiling))
          throw new Error("Wait expiry is outside its evidenced bound.");
        const expires = new Date(evidence.state === "complete" ? ceiling : requested);
        const row = (
          await tx.query<{ id: string }>(
            `insert into public.orchestrator_waits
           (orchestrator_id,parent_generation,kind,reference,reason,evidence,evidence_at,expires_at,deadline,created_at,released_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict(orchestrator_id,kind,reference) do update set
             reason=excluded.reason,evidence=excluded.evidence,evidence_at=excluded.evidence_at,parent_generation=excluded.parent_generation,
             expires_at=excluded.expires_at,released_at=excluded.released_at
           returning id`,
            [
              input.orchestratorId,
              input.generation,
              input.kind,
              input.reference,
              input.reason,
              evidence.identity,
              evidence.at,
              expires,
              deadline,
              now,
              evidence.state === "complete" ? now : null,
            ],
          )
        ).rows[0];
        if (!row) throw new Error("Wait persistence unavailable.");
        await tx.query(`update public.orchestrators set revision=revision+1 where id=$1`, [input.orchestratorId]);
        await tx.query(
          `insert into public.orchestrator_lifecycle(orchestrator_id,last_activity_at,reason)
          values($1,$2,'evidenced_wait') on conflict(orchestrator_id) do update
          set last_activity_at=$2,observation_state='unknown',reason=case when orchestrator_lifecycle.reason='wait_cap_exhausted' then 'wait_cap_exhausted' else 'evidenced_wait' end,reconcile_after=$2`,
          [input.orchestratorId, now],
        );
        const result = {
          id: row.id,
          expiresAt: expires.toISOString(),
          deadline: deadline.toISOString(),
          released: evidence.state === "complete",
        };
        await tx.query(
          `insert into public.orchestrator_lifecycle_mutations
          (orchestrator_id,actor_id,action,target,idempotency_key,request_digest,result) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            input.orchestratorId,
            input.ownerId,
            `wait:${input.kind}`,
            input.reference,
            input.key,
            digest,
            JSON.stringify(result),
          ],
        );
        return result;
      });
    },
  };
}
