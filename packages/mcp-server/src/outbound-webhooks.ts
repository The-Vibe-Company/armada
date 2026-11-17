import { createHmac, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";
import { queuedPromptAliases } from "./queued-prompt-ids.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Versioned signature binds the timestamp and durable delivery id to the exact bytes. */
export function webhookSignature(secret: string, timestamp: string, id: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${id}.${body}`).digest("hex")}`;
}

/** Conservative IPv4-only public egress. DNS is resolved anew and pinned on every attempt. */
export function publicWebhookAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 2 && c === 0))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function endpointUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid_url");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
    throw new Error("invalid_url");
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * Pin a validated address while honouring both Node lookup contracts: `net` asks for
 * `all: true` (address records) when it may race families, and a single address otherwise.
 */
export function pinnedLookup(address: string) {
  return (_host: string, options: { all?: boolean | undefined } | number | undefined, callback: LookupCallback) => {
    if (typeof options === "object" && options?.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

/** Sends to one already-validated address; the URL host stays the TLS server name and Host header. */
export function postPinned(
  url: URL,
  address: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", headers, signal, lookup: pinnedLookup(address) }, (response) => {
      // No receiver body is retained or logged. Redirects are never followed.
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function deliver(url: URL, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  let addresses: string[];
  try {
    addresses = await resolver.resolve4(url.hostname);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((address) => !publicWebhookAddress(address)))
    throw new Error("invalid_address");
  const address = addresses[0];
  if (!address) throw new Error("invalid_address");
  return postPinned(url, address, body, headers, signal);
}

export function createOutboundWebhooks(sql: Sql, key: string | undefined, dashboardUrl: string) {
  async function publicPayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof payload.promptId !== "string") return payload;
    const receipts = await sql.query<{
      request_id: string;
      native_prompt_id: string | null;
      result_enc: Uint8Array<ArrayBuffer> | null;
    }>(
      `select request_id,native_prompt_id,result_enc from public.account_turn_queue
       where sandbox_id=$1 and (native_prompt_id is not null or result_enc is not null) order by sequence`,
      [payload.sandboxId],
    );
    const aliases = await queuedPromptAliases(receipts.rows, key);
    for (const receipt of receipts.rows) {
      if (receipt.native_prompt_id) aliases.set(receipt.native_prompt_id, receipt.request_id);
    }
    return { ...payload, promptId: aliases.get(payload.promptId) ?? payload.promptId };
  }
  return {
    route(authenticate: (request: Request) => Promise<CallerResult>): Route {
      return async (request) => {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path !== "/api/v1/webhooks" && !path.startsWith("/api/v1/webhooks/")) return null;
        try {
          const auth = await authenticate(request);
          if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
          const org = url.searchParams.get("org");
          if (!org || !UUID.test(org)) return Response.json({ error: "org UUID required" }, { status: 400 });
          if (!auth.caller.orgs.some((m) => m.orgId === org && m.role === "admin"))
            return Response.json({ error: "forbidden" }, { status: 403 });
          if (path === "/api/v1/webhooks/deliveries" && request.method === "GET") {
            const endpoint = url.searchParams.get("endpointId");
            if (endpoint && !UUID.test(endpoint))
              return Response.json({ error: "invalid endpointId" }, { status: 400 });
            const rows = await sql.query<{ payload: Record<string, unknown> }>(
              `select d.id,d.endpoint_id,d.payload,d.attempts,d.next_attempt_at,d.delivered_at,d.last_status,d.created_at
              from public.outbound_webhook_deliveries d join public.outbound_webhook_endpoints e on e.id=d.endpoint_id
              where e.org_id=$1 and ($2::uuid is null or e.id=$2::uuid) order by d.created_at desc,d.id desc limit 100`,
              [org, endpoint],
            );
            return Response.json({
              deliveries: await Promise.all(
                rows.rows.map(async (row) => ({ ...row, payload: await publicPayload(row.payload) })),
              ),
            });
          }
          if (path === "/api/v1/webhooks" && request.method === "GET") {
            const rows = await sql.query(
              `select id,url,enabled,created_at from public.outbound_webhook_endpoints where org_id=$1 order by created_at desc limit 100`,
              [org],
            );
            return Response.json({ endpoints: rows.rows });
          }
          if (path === "/api/v1/webhooks" && request.method === "POST") {
            const raw = await request.text();
            if (raw.length > 4096) return Response.json({ error: "body too large" }, { status: 413 });
            let target: URL;
            try {
              target = endpointUrl((JSON.parse(raw) as { url?: unknown }).url);
            } catch {
              return Response.json({ error: "A public HTTPS URL on port 443 is required" }, { status: 400 });
            }
            const secret = randomBytes(32).toString("hex");
            const encrypted = await encryptSecret(secret, key);
            const rows = await sql.query(
              `insert into public.outbound_webhook_endpoints(org_id,url,secret_enc) values($1,$2,$3) returning id,url,enabled,created_at`,
              [org, target.href, encrypted],
            );
            return Response.json(
              { endpoint: rows.rows[0], secret },
              { status: 201, headers: { "Cache-Control": "no-store" } },
            );
          }
          const id = path.slice("/api/v1/webhooks/".length);
          if (request.method === "DELETE" && UUID.test(id)) {
            // Keep delivery history while cancelling future sends.
            await sql.query(`update public.outbound_webhook_endpoints set enabled=false where id=$1 and org_id=$2`, [
              id,
              org,
            ]);
            return new Response(null, { status: 204 });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        } catch {
          return Response.json({ error: "webhooks_unavailable" }, { status: 503 });
        }
      };
    },
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      const rows = await sql.query<{
        id: string;
        url: string;
        secret_enc: Uint8Array<ArrayBuffer>;
        payload: Record<string, unknown>;
        attempts: number;
      }>(`
        with candidate as (
          select d.id from public.outbound_webhook_deliveries d join public.outbound_webhook_endpoints e on e.id=d.endpoint_id
          where e.enabled and d.delivered_at is null and d.attempts<5 and d.next_attempt_at<=now()
          and (d.lease_until is null or d.lease_until<now())
          and not exists(select 1 from public.account_turn_queue q
            where q.sandbox_id::text=d.payload->>'sandboxId'
              and q.native_prompt_id is null and q.result_enc is null
              and (q.state='dispatching' or exists(select 1 from public.runtime_commands c
                where c.sandbox_id=q.sandbox_id and c.result_enc is null
                  and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))))
          order by d.next_attempt_at,d.id
          for update of d skip locked limit 1
        ), claimed as (
          update public.outbound_webhook_deliveries d set attempts=attempts+1,lease_until=now()+interval '60 seconds'
          from candidate c where d.id=c.id returning d.*
        ) select c.id,c.payload,c.attempts,e.url,e.secret_enc from claimed c join public.outbound_webhook_endpoints e on e.id=c.endpoint_id`);
      const row = rows.rows[0];
      if (!row) return false;
      let status: number | null = null;
      try {
        const secret = await decryptSecret(row.secret_enc, key);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = await publicPayload(row.payload);
        const body = JSON.stringify({
          ...payload,
          links: { sandbox: `${dashboardUrl.replace(/\/$/, "")}/sandboxes/${row.payload.sandboxId}` },
        });
        status = await deliver(
          endpointUrl(row.url),
          body,
          {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            "Armada-Webhook-Id": row.id,
            "Armada-Webhook-Timestamp": timestamp,
            "Armada-Webhook-Signature": webhookSignature(secret, timestamp, row.id, body),
          },
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        );
      } catch {
        /* Store only status codes; exception text can contain endpoint credentials. */
      }
      const success = status !== null && status >= 200 && status < 300;
      await sql.query(
        `update public.outbound_webhook_deliveries set last_status=$3,delivered_at=case when $4 then now() else null end,
        lease_until=null,next_attempt_at=now()+($5 * interval '1 second') where id=$1 and attempts=$2`,
        [row.id, row.attempts, status, success, Math.min(3600, 30 * 2 ** (row.attempts - 1))],
      );
      return true;
    },
    async drain() {},
  };
}
