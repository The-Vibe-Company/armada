import { BodyTooLargeError } from "@armada/auth";
import { HARNESS_KINDS, isHarness } from "@armada/core";
import {
  createTemplateService,
  EncryptionKeyError,
  encryptSecret,
  type Sql,
  toBytea,
  VaultError,
} from "@armada/core/server";
import { AuthUnavailable, type Caller, type CallerResult } from "./caller.ts";
import { readBody } from "./control-body.ts";
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
const mutationPath = /^\/api\/v1\/triggers\/([^/]+)\/(rotate|disable)$/;
const noStore = { "cache-control": "no-store" };

async function signingKey(encryptionKey: string | undefined) {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  try {
    return { secret, sealed: toBytea(await encryptSecret(secret, encryptionKey)) };
  } catch (error) {
    if (!(error instanceof EncryptionKeyError)) throw error;
    recordOperatorFailure("inbound_trigger.encryption", error);
    return fail(503, "dependency_unavailable", "Trigger signing key encryption is temporarily unavailable.");
  }
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

async function create(sql: Sql, org: string, actor: Caller, request: Request, encryptionKey: string | undefined) {
  let body: Record<string, unknown>;
  try {
    body = await readBody(request, 4096);
  } catch (error) {
    if (error instanceof BodyTooLargeError || error instanceof VaultError)
      return fail(400, "invalid_request", "Supply a JSON trigger configuration of at most 4096 bytes.");
    throw error;
  }
  const { templateId, poolHarness, ratePerMinute, concurrency } = body;
  if (
    Object.keys(body).length !== 4 ||
    typeof templateId !== "string" ||
    !UUID.test(templateId) ||
    !isHarness(poolHarness) ||
    !positiveInt(ratePerMinute) ||
    !positiveInt(concurrency)
  ) {
    return fail(
      400,
      "invalid_request",
      "Supply a template UUID, pool harness, and positive integer rate and concurrency.",
    );
  }
  if (!sql.transaction) return fail(503, "dependency_unavailable", "Trigger creation is temporarily unavailable.");
  const key = await signingKey(encryptionKey);
  if (key instanceof Response) return key;
  let triggerId: string | undefined;
  try {
    triggerId = await sql.transaction(async (tx) => {
      const binding = await createTemplateService(sql).validateBinding(tx, actor, org, templateId);
      if (binding.harness !== poolHarness) return;
      const {
        rows: [pool],
      } = await tx.query<{ id: string; version: number }>(
        `select c.id, c.version from public.agent_defaults p
         join public.credentials c on c.id = p.credential_id
         where p.user_id = $1 and p.harness = $2 and c.kind::text = any($3::text[])
           and c.status = 'active' and (c.expires_at is null or c.expires_at > clock_timestamp())
           and ((c.scope = 'user' and c.owner_id = $1) or (c.scope = 'org' and c.owner_id = $4))
         for share of p, c`,
        [actor.userId, poolHarness, HARNESS_KINDS[poolHarness], org],
      );
      if (
        !pool ||
        (binding.modelAccount && (binding.modelAccount.id !== pool.id || binding.modelAccount.version !== pool.version))
      )
        return;
      const {
        rows: [trigger],
      } = await tx.query<{ id: string }>(
        `with created as (
           insert into public.triggers (org_id, template_id, launch_owner_id, pool_harness, rate_per_minute, concurrency, secret_enc)
           values ($1, $2, $3, $4, $5, $6, $7::text::bytea) returning id
         )
         insert into public.trigger_admin_audit (org_id, trigger_id, actor_id, action)
         select $1, id, $3, 'create' from created returning trigger_id as id`,
        [org, templateId, actor.userId, poolHarness, ratePerMinute, concurrency, key.sealed],
      );
      if (!trigger) throw new Error("Trigger creation did not produce an audit event.");
      return trigger.id;
    });
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    if (error.code === "forbidden") return fail(403, "forbidden", "Organization admin access is required.");
    if (!["invalid", "not_found", "conflict"].includes(error.code)) throw error;
  }
  if (!triggerId) return fail(409, "conflict", "The template or account pool is unavailable for this trigger.");
  return Response.json({ triggerId, signingSecret: key.secret }, { status: 201, headers: noStore });
}

async function mutate(
  sql: Sql,
  org: string,
  actor: string,
  triggerId: string,
  action: "rotate" | "disable",
  encryptionKey: string | undefined,
) {
  let secret: string | null = null;
  let sealed: string | null = null;
  if (action === "rotate") {
    const key = await signingKey(encryptionKey);
    if (key instanceof Response) return key;
    ({ secret, sealed } = key);
  }

  const { rows } = await sql.query<{ id: string }>(
    `with admin as materialized (
       select 1 from public.members where org_id = $1 and user_id = $2 and role = 'admin' for share
     ), changed as (
       update public.triggers
       set secret_enc = coalesce($4::text::bytea, secret_enc),
           key_revision = key_revision + case when $4::text::bytea is null then 0 else 1 end,
           enabled = enabled and $5::text <> 'disable'
       where org_id = $1 and id = $3 and enabled and exists (select 1 from admin)
       returning id
     ), audited as (
       insert into public.trigger_admin_audit (org_id, trigger_id, actor_id, action)
       select $1, id, $2, $5 from changed
       returning trigger_id
     )
     select id from changed join audited on audited.trigger_id = changed.id`,
    [org, actor, triggerId, sealed, action],
  );
  if (!rows.length) {
    if (action === "disable") {
      const { rows: disabled } = await sql.query(
        `select 1 from public.triggers t
         join public.members m on m.org_id = t.org_id
         where t.org_id = $1 and m.user_id = $2 and m.role = 'admin' and t.id = $3 and not t.enabled`,
        [org, actor, triggerId],
      );
      if (disabled.length) return new Response(null, { status: 204, headers: noStore });
    }
    return fail(404, "not_found", "Active trigger not found.");
  }

  return secret === null
    ? new Response(null, { status: 204, headers: noStore })
    : Response.json({ signingSecret: secret }, { headers: noStore });
}

export function inboundTriggerAdminRoute(
  sql: Sql,
  authenticate: (request: Request) => Promise<CallerResult>,
  encryptionKey?: string,
) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const deliveryMatch = deliveriesPath.exec(url.pathname);
    const mutationMatch = mutationPath.exec(url.pathname);
    if (url.pathname !== basePath && !deliveryMatch && !mutationMatch) return null;

    let auth: CallerResult;
    try {
      auth = await authenticate(request);
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      recordOperatorFailure("inbound_trigger.authentication", error);
      return fail(503, "dependency_unavailable", "Authentication is temporarily unavailable.");
    }
    if (!auth.ok) return fail(401, "unauthorized", "Sign in to manage inbound triggers.");
    const org = url.searchParams.get("org")?.toLowerCase();
    if (!org || !UUID.test(org)) return fail(400, "invalid_request", "Supply the organization UUID.");
    if (!auth.caller.orgs.some((membership) => membership.orgId === org && membership.role === "admin")) {
      return fail(403, "forbidden", "Organization admin access is required.");
    }
    const creating = url.pathname === basePath && request.method === "POST";
    const method = mutationMatch || creating ? "POST" : "GET";
    if (request.method !== method) {
      const response = fail(405, "method_not_allowed", `Use ${method} for this inbound trigger operation.`);
      response.headers.set("allow", url.pathname === basePath ? "GET, POST" : method);
      return response;
    }

    if (creating) return create(sql, org, auth.caller, request, encryptionKey);

    if (mutationMatch) {
      const [, triggerId, action] = mutationMatch;
      if (!triggerId || !UUID.test(triggerId)) return fail(400, "invalid_request", "Supply the trigger UUID.");
      return mutate(sql, org, auth.caller.userId, triggerId, action === "rotate" ? "rotate" : "disable", encryptionKey);
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
