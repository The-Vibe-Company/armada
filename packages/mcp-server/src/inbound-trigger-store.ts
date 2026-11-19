import { decryptSecret, type Sql } from "@armada/core/server";
import { freshTriggerTimestamp, type InboundTriggerStore, type TriggerAdmission } from "./inbound-trigger-route.ts";
import type { createJobsStore } from "./jobs/store.ts";

const rateWindowMs = 60_000;
const dispatchBudgetMs = 5 * 60_000;

class ExpiredDelivery extends Error {}

export function createInboundTriggerStore(
  sql: Sql,
  jobs: Pick<ReturnType<typeof createJobsStore>, "enqueue">,
  encryptionKey: string | undefined,
  now = Date.now,
) {
  return {
    async signingKey(triggerId) {
      const {
        rows: [row],
      } = await sql.query<{ secret: string; key_revision: number }>(
        "select encode(secret_enc, 'hex') as secret, key_revision from public.triggers where id = $1 and enabled",
        [triggerId],
      );
      if (!row) return;
      const key = Buffer.from(
        await decryptSecret(Uint8Array.from(Buffer.from(row.secret, "hex")), encryptionKey),
        "base64",
      );
      if (key.length !== 32) throw new Error("Invalid stored trigger signing key.");
      return { key, revision: row.key_revision };
    },

    async admit({ triggerId, deliveryId, timestamp, revision, body }) {
      if (!sql.transaction) throw new Error("Trigger admission requires a transaction.");
      try {
        return await sql.transaction<TriggerAdmission>(async (tx) => {
          const {
            rows: [trigger],
          } = await tx.query<{ org_id: string; rate_per_minute: number }>(
            `select org_id, rate_per_minute from public.triggers
             where id = $1 and enabled and key_revision = $2 for update`,
            [triggerId, revision],
          );
          if (!trigger || !freshTriggerTimestamp(timestamp, now())) return { status: "unauthorized" };

          const {
            rows: [receipt],
          } = await tx.query<{ job_id: string }>(
            "select job_id from public.trigger_deliveries where trigger_id = $1 and delivery_id = $2",
            [triggerId, deliveryId],
          );
          if (receipt) {
            return freshTriggerTimestamp(timestamp, now())
              ? { status: "duplicate", jobId: receipt.job_id }
              : { status: "unauthorized" };
          }

          const {
            rows: [binding],
          } = await tx.query<{ received_at_ms: number }>(
            `with binding as materialized (
               select 1 from public.triggers t
               join public.launch_templates l on l.id = t.template_id and l.org_id = t.org_id
               join public.launch_template_revisions r on r.template_id = l.id and r.revision = l.current_revision
               join public.members m on m.org_id = t.org_id and m.user_id = t.launch_owner_id
               join public.agent_defaults p on p.user_id = t.launch_owner_id and p.harness = t.pool_harness
               where t.id = $1 and m.role = 'admin' and l.status = 'active'
                 and (l.scope = 'org' or l.owner_id = t.launch_owner_id)
                 and r.definition->>'harness' = p.harness
               for share of m, l, p
             )
             select extract(epoch from clock_timestamp())::float8 * 1000 as received_at_ms from binding`,
            [triggerId],
          );
          if (!binding) return { status: "unauthorized" };

          const receivedAt = binding.received_at_ms;
          const {
            rows: [limit],
          } = await tx.query<{ retry_after: number }>(
            `select greatest(1, ceil(extract(epoch from
                 (received_at + interval '1 minute' - $2::timestamptz))))::integer as retry_after
             from public.trigger_deliveries
             where trigger_id = $1 and received_at > $3
             order by received_at desc offset $4 limit 1`,
            [triggerId, new Date(receivedAt), new Date(receivedAt - rateWindowMs), trigger.rate_per_minute - 1],
          );
          if (limit) {
            await tx.query(
              "update public.triggers set rate_refusals = rate_refusals + 1 where id = $1 and rate_refusals < 2147483647",
              [triggerId],
            );
            if (!freshTriggerTimestamp(timestamp, now())) throw new ExpiredDelivery();
            return { status: "rate_limited", retryAfter: limit.retry_after };
          }

          const jobId = await jobs.enqueue(
            "trigger",
            null,
            null,
            `${triggerId}:${deliveryId}`,
            {
              triggerId,
              deliveryId,
              body,
            },
            {
              orgId: trigger.org_id,
              maxAttempts: 3,
              deadline: new Date(receivedAt + dispatchBudgetMs),
            },
            tx,
          );
          await tx.query(
            "insert into public.trigger_deliveries (trigger_id, delivery_id, job_id, received_at) values ($1,$2,$3,$4)",
            [triggerId, deliveryId, jobId, new Date(receivedAt)],
          );
          if (!freshTriggerTimestamp(timestamp, now())) throw new ExpiredDelivery();
          return { status: "queued", jobId };
        });
      } catch (error) {
        if (error instanceof ExpiredDelivery) return { status: "unauthorized" };
        throw error;
      }
    },
  } satisfies InboundTriggerStore;
}
