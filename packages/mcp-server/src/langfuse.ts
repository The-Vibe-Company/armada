import { createHash } from "node:crypto";
import type { AgentEvent, Sql, TurnTokenUsage } from "@armada/core";
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
    const start = history.find((e) => e.kind === "prompt" && e.status === "running");
    if (!start) continue; // Never fabricate a duration from an incomplete bounded archive.
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
      startTimeUnixNano: nano(start.at),
      endTimeUnixNano: nano(Math.max(start.at, end.at)),
      status: { code: end.status === "failed" ? 2 : 1 },
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
        "langfuse.observation.metadata.failure_reason": full
          ? end.reason
          : end.status === "failed"
            ? "turn_failed"
            : undefined,
        "langfuse.observation.metadata.usage": usage,
        "langfuse.observation.input": full && start.kind === "prompt" ? start.text : undefined,
        "langfuse.observation.output": full ? [...messages.values()].join("\n") : undefined,
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

/** One active export and 64 queued jobs per server; overload and errors are counted, never retried inline. */
export function createLangfuse(sql: Sql, key: string, send: typeof fetch = fetch) {
  const queue: { sandboxId: string; promptIds: string[]; ack: number }[] = [];
  let active = false;
  const counters = { dropped: 0, failed: 0, exported: 0 };
  async function drain() {
    if (active) return;
    active = true;
    try {
      while (queue.length) {
        const job = queue.shift()!;
        try {
          const row = (
            await sql.query<{
              config_enc: Uint8Array<ArrayBuffer>;
              content_mode: string;
              usage_turns: TurnTokenUsage[];
            }>(
              `select c.config_enc,c.content_mode,s.usage_turns->'turns' as usage_turns from public.org_langfuse c join public.sandboxes s on s.org_id=c.org_id where s.id=$1 and c.enabled`,
              [job.sandboxId],
            )
          ).rows[0];
          if (!row) continue;
          // Bound archive memory before fetching ciphertext; oversized histories are deliberately dropped.
          const size = (
            await sql.query<{ bytes: string }>(
              `select coalesce(sum(octet_length(event_enc)),0)::text as bytes from public.runtime_events where sandbox_id=$1 and sequence<=$2`,
              [job.sandboxId, job.ack],
            )
          ).rows[0];
          if (Number(size?.bytes) > 4 * 1024 * 1024) {
            counters.dropped++;
            continue;
          }
          const archive = (
            await sql.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
              `select event_enc from public.runtime_events where sandbox_id=$1 and sequence<=$2 order by sequence limit 2001`,
              [job.sandboxId, job.ack],
            )
          ).rows;
          if (archive.length > 2000) {
            counters.dropped++;
            continue;
          }
          const events: AgentEvent[] = [];
          for (const item of archive) {
            const e = JSON.parse(await decryptSecret(item.event_enc, key)) as AgentEvent;
            if (e.promptId && job.promptIds.includes(e.promptId)) events.push(e);
          }
          const spans = langfuseSpans(job.sandboxId, events, row.usage_turns ?? [], row.content_mode === "full");
          if (!spans.length) continue;
          const config = JSON.parse(await decryptSecret(row.config_enc, key)) as Config;
          const response = await send(`${config.host}/api/public/otel/v1/traces`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
            headers: {
              "content-type": "application/json",
              "x-langfuse-ingestion-version": "4",
              authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
            },
            body: JSON.stringify({
              resourceSpans: [
                {
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "armada-server" } }] },
                  scopeSpans: [{ scope: { name: "armada" }, spans }],
                },
              ],
            }),
          });
          if (!response.ok) throw Error("export_failed");
          await response.body?.cancel();
          counters.exported++;
        } catch {
          counters.failed++;
        } // No exception, response body, URL or credential is logged.
      }
    } finally {
      active = false;
    }
  }
  function enqueue(sandboxId: string, events: AgentEvent[], ack: number) {
    const promptIds = [
      ...new Set(
        events.flatMap((e) =>
          e.kind === "prompt" && e.status !== "running" && e.status !== "queued" && e.promptId ? [e.promptId] : [],
        ),
      ),
    ];
    if (!promptIds.length) return;
    if (queue.length >= 64) {
      counters.dropped++;
      return;
    }
    queue.push({ sandboxId, promptIds, ack });
    // Defers even the settings lookup until after the ingest response can proceed.
    setTimeout(() => drain(), 0);
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
            await sql.query<{ enabled: boolean; content_mode: string }>(
              "select enabled,content_mode from public.org_langfuse where org_id=$1",
              [match[1]],
            )
          ).rows[0];
          return Response.json({ ...row, enabled: row?.enabled ?? false, counters }, { headers });
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
  return { enqueue, route, counters };
}
