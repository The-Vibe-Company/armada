import type { Sql } from "@armada/core/server";
import { AuthUnavailable, type CallerResult } from "./caller.ts";
import { UUID } from "./control-input.ts";
import { fail } from "./control-response.ts";
import { recordOperatorFailure } from "./request-observability.ts";

interface TriggerSummary {
  id: string;
  templateId: string | null;
  poolHarness: string;
  enabled: boolean;
  ratePerMinute: number;
  concurrency: number;
  rateRefusals: number;
}

interface DeliverySummary {
  deliveryId: string;
  receivedAt: string;
  jobState: "queued" | "leased" | "done" | "failed";
}

const basePath = "/api/v1/triggers";
const deliveriesPath = /^\/api\/v1\/triggers\/([^/]+)\/deliveries$/;
const noStore = { "cache-control": "no-store" };

export function inboundTriggerAdminRoute(sql: Sql, authenticate: (request: Request) => Promise<CallerResult>) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const deliveryMatch = deliveriesPath.exec(url.pathname);
    if (url.pathname !== basePath && !deliveryMatch) return null;

    let auth: CallerResult;
    try {
      auth = await authenticate(request);
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      recordOperatorFailure("inbound_trigger.authentication", error);
      return fail(503, "dependency_unavailable", "Authentication is temporarily unavailable.");
    }
    if (!auth.ok) return fail(401, "unauthorized", "Sign in to inspect inbound triggers.");
    const org = url.searchParams.get("org")?.toLowerCase();
    if (!org || !UUID.test(org)) return fail(400, "invalid_request", "Supply the organization UUID.");
    if (!auth.caller.orgs.some((membership) => membership.orgId === org && membership.role === "admin")) {
      return fail(403, "forbidden", "Organization admin access is required.");
    }
    if (request.method !== "GET") {
      const response = fail(405, "method_not_allowed", "Use GET to inspect inbound triggers.");
      response.headers.set("allow", "GET");
      return response;
    }

    if (!deliveryMatch) {
      const { rows } = await sql.query<TriggerSummary>(
        `select t.id, case when l.scope = 'org' or l.owner_id = $2 then l.id end as "templateId",
                t.pool_harness as "poolHarness", t.enabled, t.rate_per_minute as "ratePerMinute",
                t.concurrency, t.rate_refusals as "rateRefusals"
         from public.triggers t
         join public.launch_templates l on l.id = t.template_id and l.org_id = t.org_id
         where t.org_id = $1
         order by t.id`,
        [org, auth.caller.userId],
      );
      const triggers = rows.map(
        ({ id, templateId, poolHarness, enabled, ratePerMinute, concurrency, rateRefusals }) => ({
          id,
          templateId,
          poolHarness,
          enabled,
          ratePerMinute,
          concurrency,
          rateRefusals,
        }),
      );
      return Response.json({ triggers }, { headers: noStore });
    }

    const triggerId = deliveryMatch[1];
    if (!triggerId || !UUID.test(triggerId)) return fail(400, "invalid_request", "Supply the trigger UUID.");
    const {
      rows: [trigger],
    } = await sql.query<{ deliveries: DeliverySummary[] }>(
      `select coalesce(
         (select jsonb_agg(
            jsonb_build_object('deliveryId', recent.delivery_id, 'receivedAt', recent.received_at, 'jobState', recent.state)
            order by recent.received_at desc, recent.delivery_id desc
          )
          from (
            select d.delivery_id, d.received_at, j.state
            from public.trigger_deliveries d
            join public.jobs j on j.id = d.job_id and j.org_id = t.org_id and j.kind = 'trigger'
            where d.trigger_id = t.id
            order by d.received_at desc, d.delivery_id desc
            limit 100
          ) recent), '[]'::jsonb
       ) as deliveries
       from public.triggers t
       where t.id = $1 and t.org_id = $2`,
      [triggerId, org],
    );
    if (!trigger) return fail(404, "not_found", "Trigger not found.");
    const deliveries = trigger.deliveries.map(({ deliveryId, receivedAt, jobState }) => ({
      deliveryId,
      receivedAt,
      jobState,
    }));
    return Response.json({ deliveries }, { headers: noStore });
  };
}
