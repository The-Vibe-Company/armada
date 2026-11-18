import { createHash } from "node:crypto";
import {
  type AgentEvent,
  isFinalPromptStatus,
  observedPromptOutcome,
  type Provider,
  readPromptEvents,
  reportedTurnUsage,
  type Sql,
  type TurnTokenUsage,
} from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";

interface Config {
  host: string;
  publicKey: string;
  secretKey: string;
}
const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);
const nano = (at: number) => (BigInt(Math.max(0, Math.trunc(at))) * 1000000n).toString();

/** Complete OTLP observations; content is opt-in and unknown event payloads never leave the server. */
export function langfuseSpans(sandboxId: string, events: AgentEvent[], turns: TurnTokenUsage[], full: boolean) {
  const spans = [];
  for (const end of events) {
    if (end.kind !== "prompt" || end.status === "running" || end.status === "queued" || !end.promptId) continue;
    const history = events.filter((e) => e.promptId === end.promptId);
    const start = history.find((e): e is PromptEvent => e.kind === "prompt" && e.status === "running");
    const startAt = start?.at || end.at;
    const traceId = hash(sandboxId, 32);
    const spanId = hash(`${sandboxId}/${end.promptId}`, 16);
    const attributes = (values: Record<string, unknown>) =>
      Object.entries({
        "langfuse.trace.name": "Armada sandbox",
        "langfuse.session.id": sandboxId,
        ...values,
      })
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => ({
          key,
          value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
        }));
    const messages = new Map<string, string>();
    for (const e of history)
      if (e.kind === "message" && !e.retracted && e.responseKind !== "tool_result") {
        const id = e.messageId ?? e.id;
        messages.set(id, e.textMode === "delta" ? (messages.get(id) ?? "") + e.text : e.text);
      }
    const usage = turns.filter((t) => t.promptId === end.promptId);
    const cost = usage.map((t) => t.pricing?.usd);
    spans.push({
      traceId,
      spanId,
      name: "Armada turn",
      kind: 1,
      startTimeUnixNano: nano(startAt),
      endTimeUnixNano: nano(Math.max(startAt, end.at)),
      status: { code: end.status === "finished" ? 1 : 2 },
      attributes: attributes({
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name":
          usage
            .map((t) => t.model)
            .filter(Boolean)
            .join(",") || history.flatMap((e) => (e.kind === "message" && e.model ? [e.model] : []))[0],
        "langfuse.observation.usage_details": usage.length
          ? Object.fromEntries(
              (["inputTokens", "outputTokens"] as const).flatMap((dimension, index) =>
                usage.every((t) => t[dimension] !== null)
                  ? [[index === 0 ? "input" : "output", usage.reduce((sum, t) => sum + (t[dimension] ?? 0), 0)]]
                  : [],
              ),
            )
          : undefined,
        "langfuse.observation.cost_details":
          cost.length && cost.every((c) => c != null) ? { total: cost.reduce((n, c) => n + Number(c), 0) } : undefined,
        "langfuse.observation.metadata.status": end.status,
        "langfuse.observation.metadata.timing_incomplete": start?.at && end.at > startAt ? undefined : true,
        "langfuse.observation.metadata.failure_reason": full
          ? end.reason
          : end.status === "failed"
            ? "turn_failed"
            : undefined,
        "langfuse.observation.metadata.usage": usage,
        "langfuse.observation.input": full ? start?.text || end.text || undefined : undefined,
        "langfuse.observation.output": full && messages.size ? [...messages.values()].join("\n") : undefined,
      }),
    });
    const tools = new Map<string, { first: number; last: number; tool: import("@armada/core").ToolCall }>();
    for (const e of history)
      if (e.kind === "message")
        for (const tool of e.tools) {
          const previous = tools.get(tool.id);
          tools.set(tool.id, {
            first: previous?.first ?? e.at,
            last: e.at,
            tool: {
              ...previous?.tool,
              ...tool,
              name: e.responseKind === "tool_result" && previous ? previous.tool.name : tool.name,
            },
          });
        }
    for (const [id, t] of tools)
      spans.push({
        traceId,
        spanId: hash(`${sandboxId}/${end.promptId}/${id}`, 16),
        parentSpanId: spanId,
        name: t.tool.name,
        kind: 1,
        startTimeUnixNano: nano(t.first),
        endTimeUnixNano: nano(Math.max(t.first, t.last)),
        status: { code: t.tool.result?.isError ? 2 : 1 },
        attributes: attributes({
          "langfuse.observation.type": "tool",
          "langfuse.observation.input": full ? t.tool.input : undefined,
          "langfuse.observation.output": full ? t.tool.result?.output : undefined,
        }),
      });
  }
  return spans;
}

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
type PromptEvent = Extract<AgentEvent, { kind: "prompt" }>;
interface ExportJob {
  sandbox_id: string;
  prompt_id: string;
  org_id: string;
  provider_sandbox_id: string;
  runtime_ack: string | null;
  terminal_status: PromptEvent["status"];
  observed_ms: number;
  config_enc: Uint8Array<ArrayBuffer> | null;
  content_mode: string | null;
  usage_turns: TurnTokenUsage[] | null;
}

export function createLangfuse(
  sql: Sql,
  key: string,
  nativeProviderFor: (id: string) => Promise<{ provider: Pick<Provider, "id" | "events">; providerSandboxId: string }>,
  send: typeof fetch = fetch,
) {
  async function history(
    job: ExportJob,
    signal: AbortSignal,
  ): Promise<{ events: AgentEvent[]; mutablePromptTime?: boolean } | null> {
    if (job.runtime_ack === null) {
      const { provider, providerSandboxId } = await nativeProviderFor(job.sandbox_id);
      if (providerSandboxId !== job.provider_sandbox_id) return null;
      const request = { sandboxId: providerSandboxId, promptId: job.prompt_id, signal };
      const read = await readPromptEvents(provider, request);
      signal.throwIfAborted();
      return {
        events: read.events.filter((e) => e.promptId === job.prompt_id),
        mutablePromptTime: provider.id === "boat",
      };
    }
    // Bound archive memory before fetching ciphertext.
    const args = [job.sandbox_id, job.runtime_ack];
    const size = await sql.query<{ bytes: string }>(
      `select coalesce(sum(octet_length(event_enc)),0)::text as bytes
         from public.runtime_events where sandbox_id=$1 and sequence<=$2`,
      args,
    );
    if (Number(size.rows[0]?.bytes) > MAX_EXPORT_BYTES) return null;
    const archive = await sql.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
      `select event_enc from public.runtime_events where sandbox_id=$1 and sequence<=$2 order by sequence limit 2001`,
      args,
    );
    if (archive.rows.length > 2000) return null;
    const events: AgentEvent[] = [];
    for (const { event_enc } of archive.rows) {
      const event = JSON.parse(await decryptSecret(event_enc, key)) as AgentEvent;
      if (event.promptId === job.prompt_id) events.push(event);
    }
    return { events };
  }

  async function exportTurn(job: ExportJob, signal: AbortSignal): Promise<"exported" | "failed" | "dropped"> {
    if (!job.config_enc) return "dropped";
    const evidence = await history(job, signal);
    if (!evidence) return "dropped";
    const { events, mutablePromptTime } = evidence;
    const terminal = events.findLast((e): e is PromptEvent => e.kind === "prompt" && isFinalPromptStatus(e.status));
    const turnEvents = events.filter((e) => e.kind !== "prompt" || !isFinalPromptStatus(e.status));
    const outcome = job.runtime_ack === null ? observedPromptOutcome(job.terminal_status, job.prompt_id, events) : null;
    turnEvents.push({
      kind: "prompt",
      id: job.prompt_id,
      promptId: job.prompt_id,
      text: "",
      ...terminal,
      at: mutablePromptTime ? job.observed_ms : terminal?.at || job.observed_ms,
      status: outcome && outcome.state !== "running" ? outcome.state : job.terminal_status,
      ...(outcome?.state === "failed" && job.terminal_status === "finished" ? { reason: outcome.reason } : {}),
    });
    const persisted = job.usage_turns?.filter((turn) => turn.promptId === job.prompt_id) ?? [];
    const usage = persisted.some((turn) => turn.model !== null || turn.inputTokens != null || turn.outputTokens != null)
      ? persisted
      : reportedTurnUsage(events).turns;
    const spans = langfuseSpans(job.sandbox_id, turnEvents, usage, job.content_mode === "full");
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "armada-server" } }] },
          scopeSpans: [{ scope: { name: "armada" }, spans }],
        },
      ],
    });
    if (Buffer.byteLength(body) > MAX_EXPORT_BYTES) return "dropped";
    const config = JSON.parse(await decryptSecret(job.config_enc, key)) as Config;
    const response = await send(`${config.host}/api/public/otel/v1/traces`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: {
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
        authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      },
      body,
    });
    await response.body?.cancel().catch(() => {});
    return response.ok ? "exported" : "failed";
  }

  async function reconcileOne(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const lease = crypto.randomUUID();
    const job = (
      await sql.query<ExportJob>(
        `with candidate as (
          select sandbox_id,prompt_id from public.langfuse_turn_exports
          where completed_at is null and (lease_until is null or lease_until<now())
          order by observed_at for update skip locked limit 1
        ), claimed as (
          update public.langfuse_turn_exports j set lease_id=$1::uuid,lease_until=now()+interval '60 seconds'
          from candidate c where j.sandbox_id=c.sandbox_id and j.prompt_id=c.prompt_id returning j.*
        )
        select j.*,extract(epoch from j.observed_at)::double precision*1000 as observed_ms,
          c.config_enc,c.content_mode,s.usage_turns->'turns' as usage_turns
        from claimed j join public.sandboxes s on s.id=j.sandbox_id
        left join public.org_langfuse c on c.org_id=j.org_id and c.enabled and s.org_id=j.org_id`,
        [lease],
      )
    ).rows[0];
    if (!job) return false;
    const outcome = await exportTurn(job, signal).catch(() => "failed");
    signal.throwIfAborted(); // On shutdown or tick timeout, let the durable lease expire.
    await sql.query(
      `with settled as (
        update public.langfuse_turn_exports set completed_at=clock_timestamp(),lease_id=null,lease_until=null
        where sandbox_id=$1 and prompt_id=$2 and lease_id=$3::uuid returning org_id,completed_at
      ) insert into public.org_langfuse_export_stats as stats(org_id,exported,failed,dropped,last_export_at)
        select org_id,($4='exported')::int,($4='failed')::int,($4='dropped')::int,
          case when $4='exported' then completed_at end from settled
        on conflict(org_id) do update set exported=stats.exported+excluded.exported,
          failed=stats.failed+excluded.failed,dropped=stats.dropped+excluded.dropped,
          last_export_at=greatest(stats.last_export_at,excluded.last_export_at)`,
      [job.sandbox_id, job.prompt_id, lease, outcome],
    );
    return true;
  }
  function route(authenticate: (request: Request) => Promise<CallerResult>): Route {
    return async (request) => {
      const match = new URL(request.url).pathname.match(/^\/api\/v1\/orgs\/([0-9a-f-]{36})\/langfuse$/i);
      if (!match) return null;
      const headers = { "cache-control": "no-store" };
      try {
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        if (!auth.caller.orgs.some((o) => o.orgId === match[1] && o.role === "admin"))
          return Response.json({ error: "forbidden" }, { status: 403, headers });
        if (request.method === "GET") {
          const row = (
            await sql.query<{
              enabled: boolean | null;
              content_mode: string | null;
              exported: string;
              failed: string;
              dropped: string;
              last_export_at: Date | null;
            }>(
              `select c.enabled,c.content_mode,stats.exported::text,stats.failed::text,stats.dropped::text,stats.last_export_at
               from public.orgs o left join public.org_langfuse c on o.id=c.org_id
               left join public.org_langfuse_export_stats stats on o.id=stats.org_id where o.id=$1`,
              [match[1]],
            )
          ).rows[0];
          return Response.json(
            {
              enabled: row?.enabled ?? false,
              ...(row?.content_mode ? { content_mode: row.content_mode } : {}),
              counters: {
                exported: Number(row?.exported ?? 0),
                failed: Number(row?.failed ?? 0),
                dropped: Number(row?.dropped ?? 0),
              },
              lastExportAt: row?.last_export_at ?? null,
            },
            { headers },
          );
        }
        if (request.method === "DELETE") {
          await sql.query("delete from public.org_langfuse where org_id=$1", [match[1]]);
          return new Response(null, { status: 204, headers });
        }
        if (request.method !== "PUT") return new Response(null, { status: 405, headers });
        const raw = await request.text();
        if (raw.length > 16384) return Response.json({ error: "invalid_configuration" }, { status: 400, headers });
        const v = JSON.parse(raw);
        if (
          typeof v.enabled !== "boolean" ||
          !["metadata", "full"].includes(v.contentMode) ||
          typeof v.host !== "string" ||
          ![v.publicKey, v.secretKey].every(
            (k) => typeof k === "string" && k.length > 0 && k.length <= 4096 && !/[\r\n:]/.test(k),
          )
        )
          throw Error("invalid");
        const host = new URL(v.host);
        if (
          host.protocol !== "https:" ||
          host.username ||
          host.password ||
          host.search ||
          host.hash ||
          host.pathname !== "/"
        )
          throw Error("invalid");
        const encrypted = await encryptSecret(
          JSON.stringify({ host: host.origin, publicKey: v.publicKey, secretKey: v.secretKey }),
          key,
        );
        await sql.query(
          `insert into public.org_langfuse(org_id,enabled,content_mode,config_enc) values($1,$2,$3,decode($4,'hex')) on conflict(org_id) do update set enabled=excluded.enabled,content_mode=excluded.content_mode,config_enc=excluded.config_enc`,
          [match[1], v.enabled, v.contentMode, Buffer.from(encrypted).toString("hex")],
        );
        return Response.json({ enabled: v.enabled, contentMode: v.contentMode }, { headers });
      } catch {
        return Response.json({ error: "langfuse_configuration_unavailable" }, { status: 400, headers });
      }
    };
  }
  return { reconcileOne, async drain() {}, route };
}
