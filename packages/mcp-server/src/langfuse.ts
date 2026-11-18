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
import { readBody } from "./control-body.ts";
import type { Route } from "./http.ts";
import { redactCredentials } from "./log.ts";

interface Config {
  host: string;
  publicKey: string;
  secretKey: string;
}
type ContentMode = "metadata" | "full";
interface SettingsRow {
  enabled: boolean | null;
  content_mode: ContentMode | null;
  config_enc: Uint8Array<ArrayBuffer> | null;
}

const DEFAULT_HOST = "https://cloud.langfuse.com";
const REQUEST_TIMEOUT_MS = 5000;

function resolveConfig(input: Record<string, unknown>, stored: Config | null): Config {
  const host = new URL(String(input.host === undefined ? (stored?.host ?? DEFAULT_HOST) : input.host));
  if (
    (input.host !== undefined && typeof input.host !== "string") ||
    host.protocol !== "https:" ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== "/"
  )
    throw Error("invalid Langfuse host");

  // A write-only key must stay bound to its configured origin.
  if (stored && host.origin !== stored.host && (input.publicKey === undefined || input.secretKey === undefined))
    throw Error("changing Langfuse host requires both keys");

  const publicKey = input.publicKey === undefined ? stored?.publicKey : input.publicKey;
  const secretKey = input.secretKey === undefined ? stored?.secretKey : input.secretKey;
  const validKey = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n:]/.test(value);
  if (!validKey(publicKey) || !validKey(secretKey)) throw Error("invalid Langfuse keys");
  return { host: host.origin, publicKey, secretKey };
}

function authorization(config: Config): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);
/** Native histories are not redacted at storage; mask credentials in every exported string, keys included. */
const scrub = (value: unknown): unknown =>
  typeof value === "string"
    ? redactCredentials(value)
    : Array.isArray(value)
      ? value.map(scrub)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCredentials(key), scrub(item)]))
        : value;
const nano = (at: number) => (BigInt(Math.max(0, Math.trunc(at))) * 1000000n).toString();

/**
 * Complete OTLP observations; content is opt-in and unknown event payloads never leave the server.
 * `contentWithheld` marks a sandbox holding raw application secrets: then no provider-controlled
 * string (tool names, model names, run IDs) is exported either, only fixed names and numbers.
 */
export function langfuseSpans(
  sandboxId: string,
  events: AgentEvent[],
  turns: TurnTokenUsage[],
  full: boolean,
  marks: { historyUnavailable?: boolean; contentWithheld?: string } = {},
) {
  const spans = [];
  for (const end of events) {
    // Only a known final status ends a turn: Modal native history does not
    // validate guest statuses, and an unknown one must never become a span.
    if (end.kind !== "prompt" || !isFinalPromptStatus(end.status) || !end.promptId) continue;
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
        .map(([key, raw]) => {
          const value = scrub(raw);
          return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
        });
    const messages = new Map<string, string>();
    for (const e of history)
      if (e.kind === "message" && !e.retracted && e.responseKind !== "tool_result") {
        const id = e.messageId ?? e.id;
        messages.set(id, e.textMode === "delta" ? (messages.get(id) ?? "") + e.text : e.text);
      }
    const usage = turns.filter((t) => t.promptId === end.promptId);
    const trusted = !marks.contentWithheld;
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
        "langfuse.observation.model.name": !trusted
          ? undefined
          : usage
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
        "langfuse.observation.metadata.history_unavailable": marks.historyUnavailable || undefined,
        "langfuse.observation.metadata.content_withheld": marks.contentWithheld,
        "langfuse.observation.metadata.failure_reason": full
          ? end.reason
          : end.status === "failed"
            ? "turn_failed"
            : undefined,
        "langfuse.observation.metadata.usage": trusted ? usage : undefined,
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
        name: trusted ? redactCredentials(t.tool.name) : "tool",
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
/** Claims reserve an attempt; a job aborted this many times settles as failed. */
const MAX_ATTEMPTS = 5;
/** Native history reads that outlived their deadline and still run detached. */
const MAX_OUTSTANDING_HISTORY_READS = 4;
type PromptEvent = Extract<AgentEvent, { kind: "prompt" }>;
interface ExportJob {
  sandbox_id: string;
  prompt_id: string;
  org_id: string;
  provider_sandbox_id: string;
  runtime_ack: string | null;
  terminal_status: PromptEvent["status"];
  observed_ms: number;
  attempts: number;
  waiting_for_history: boolean;
  config_enc: Uint8Array<ArrayBuffer> | null;
  content_mode: string | null;
  application_secrets: boolean;
  docker_request_enc: Uint8Array<ArrayBuffer> | null;
}

export function createLangfuse(
  sql: Sql,
  key: string,
  nativeProviderFor: (id: string) => Promise<{ provider: Pick<Provider, "id" | "events">; providerSandboxId: string }>,
  send: typeof fetch = fetch,
  // Optional history gets its own deadline inside the 30 s worker tick, leaving
  // time for the receipt-only export and durable accounting.
  historyDeadline: () => AbortSignal = () => AbortSignal.timeout(10_000),
) {
  type Evidence = { events: AgentEvent[]; nativeProvider?: string } | null;
  async function nativeHistory(job: ExportJob, signal: AbortSignal): Promise<Evidence> {
    const { provider, providerSandboxId } = await nativeProviderFor(job.sandbox_id);
    if (providerSandboxId !== job.provider_sandbox_id) return null;
    const request = { sandboxId: providerSandboxId, promptId: job.prompt_id, signal };
    const read = await readPromptEvents(provider, request);
    signal.throwIfAborted();
    return {
      events: read.events.filter((e) => e.promptId === job.prompt_id),
      nativeProvider: provider.id,
    };
  }

  // Provider resolution and provider stores can await SQL or HTTP without
  // observing the signal, so the deadline is enforced around the whole read.
  // A read that outlives it keeps running detached: at most one per job and
  // MAX_OUTSTANDING_HISTORY_READS overall, so a stalled provider can neither
  // hold the export lane nor pile up reads.
  const outstanding = new Set<string>();
  function boundedNativeHistory(job: ExportJob, signal: AbortSignal): Promise<Evidence> {
    const id = `${job.sandbox_id}/${job.prompt_id}`;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (outstanding.has(id) || outstanding.size >= MAX_OUTSTANDING_HISTORY_READS)
      return Promise.reject(Error("native history read still outstanding"));
    outstanding.add(id);
    return new Promise<Evidence>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      nativeHistory(job, signal)
        .then(resolve, reject)
        .finally(() => {
          outstanding.delete(id);
          signal.removeEventListener("abort", onAbort);
        });
    });
  }

  async function history(job: ExportJob, signal: AbortSignal): Promise<Evidence> {
    if (job.runtime_ack === null) return boundedNativeHistory(job, signal);
    // Read only this turn's window: from its first archived reference (the sparse
    // counted_prompt_id marker) to the settlement acknowledgement. Earlier turns
    // must not consume the bounds. Bound archive memory before fetching ciphertext.
    const args = [job.sandbox_id, job.runtime_ack, job.prompt_id];
    const window = `from public.runtime_events where sandbox_id=$1 and sequence<=$2 and sequence>=(
        select sequence from public.runtime_events where sandbox_id=$1 and counted_prompt_id=$3)`;
    const size = await sql.query<{ bytes: string }>(
      `select coalesce(sum(octet_length(event_enc)),0)::text as bytes ${window}`,
      args,
    );
    if (Number(size.rows[0]?.bytes) > MAX_EXPORT_BYTES) return null;
    const archive = await sql.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
      `select event_enc ${window} order by sequence limit 2001`,
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

  /** Docker keeps its secret references only in the sealed launch request; an unreadable one withholds content. */
  async function bindsApplicationSecrets(job: ExportJob): Promise<boolean> {
    if (job.application_secrets) return true;
    if (!job.docker_request_enc) return false;
    try {
      const request = JSON.parse(await decryptSecret(job.docker_request_enc, key)) as {
        request?: { secrets?: unknown };
      };
      const secrets = request.request?.secrets;
      return secrets !== undefined && secrets !== null && (!Array.isArray(secrets) || secrets.length > 0);
    } catch {
      return true;
    }
  }

  async function exportTurn(
    job: ExportJob,
    signal: AbortSignal,
  ): Promise<"exported" | "failed" | "dropped" | "pending"> {
    if (!job.config_enc) return "dropped";
    let evidence: Awaited<ReturnType<typeof history>>;
    let historyUnavailable = false;
    try {
      evidence = await history(job, AbortSignal.any([signal, historyDeadline()]));
    } catch (error) {
      signal.throwIfAborted(); // Only the worker tick or shutdown abandons the job to its lease.
      // Native history is optional evidence: the settled receipt already holds
      // the terminal status and observation time. Retry a transient read error
      // while the receipt is fresh, then export a marked observation without
      // transcript content rather than discarding the turn.
      if (job.runtime_ack !== null) throw error;
      if (job.waiting_for_history) return "pending";
      evidence = { events: [] };
      historyUnavailable = true;
    }
    if (!evidence) return "dropped";
    const { events, nativeProvider } = evidence;
    const terminal = events.findLast((e): e is PromptEvent => e.kind === "prompt" && isFinalPromptStatus(e.status));
    // The native Modal runner can answer getPrompt before its journal flush commits.
    if (nativeProvider === "modal" && !terminal && job.waiting_for_history) return "pending";
    const turnEvents = events.filter((e) => e.kind !== "prompt" || !isFinalPromptStatus(e.status));
    const outcome = job.runtime_ack === null ? observedPromptOutcome(job.terminal_status, job.prompt_id, events) : null;
    turnEvents.push({
      kind: "prompt",
      id: job.prompt_id,
      promptId: job.prompt_id,
      text: "",
      ...terminal,
      at: nativeProvider === "boat" ? job.observed_ms : terminal?.at || job.observed_ms,
      status: outcome && outcome.state !== "running" ? outcome.state : job.terminal_status,
      ...(outcome?.state === "failed" && job.terminal_status === "finished" ? { reason: outcome.reason } : {}),
    });
    const snapshot = await sql.query<{ turns: TurnTokenUsage[] | null }>(
      "select usage_turns->'turns' as turns from public.sandboxes where id=$1 and org_id=$2",
      [job.sandbox_id, job.org_id],
    );
    const sandbox = snapshot.rows[0];
    if (!sandbox) return "dropped";
    const persisted = sandbox.turns?.filter((turn) => turn.promptId === job.prompt_id) ?? [];
    const usage = persisted.some((turn) => turn.model !== null || turn.inputTokens != null || turn.outputTokens != null)
      ? persisted
      : reportedTurnUsage(events).turns;
    // Application secrets bound by a template (Boat, Modal) or a Docker launch,
    // or recorded by the sandbox's irreversible application_secret_tainted
    // marker, reach the sandbox as raw values that no pattern matches, and the export
    // cannot recover them to mask exactly, so such a sandbox exports metadata
    // only, whatever the organization mode.
    // The same raw values can surface in provider-controlled metadata (a tool
    // or model name), so the check applies in metadata mode too.
    const withheld = await bindsApplicationSecrets(job);
    const spans = langfuseSpans(job.sandbox_id, turnEvents, usage, job.content_mode === "full" && !withheld, {
      historyUnavailable,
      ...(withheld ? { contentWithheld: "application_secret_bindings" } : {}),
    });
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: {
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
        authorization: authorization(config),
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
          update public.langfuse_turn_exports j set lease_id=$1::uuid,lease_until=now()+interval '60 seconds',
            attempts=j.attempts+1
          from candidate c where j.sandbox_id=c.sandbox_id and j.prompt_id=c.prompt_id returning j.*
        )
        select j.*,extract(epoch from j.observed_at)::double precision*1000 as observed_ms,
          j.observed_at>clock_timestamp()-interval '60 seconds' as waiting_for_history,
          c.config_enc,
          -- Use the more restrictive of the mode allowed at settlement and the current one.
          case when c.org_id is null then null
            when j.allowed_content_mode='full' and c.content_mode='full' then 'full' else 'metadata' end
            as content_mode,
          s.application_secret_tainted or exists(select 1 from public.template_launch_requests r
            where r.sandbox_id=j.sandbox_id
              and coalesce(r.manifest->'definition'->'secrets','[]'::jsonb) not in ('[]'::jsonb,'null'::jsonb)
          ) as application_secrets,
          (select d.request_enc from public.docker_launch_requests d where d.sandbox_id=j.sandbox_id) as docker_request_enc
        from claimed j join public.sandboxes s on s.id=j.sandbox_id
        left join public.org_langfuse c on c.org_id=j.org_id and c.enabled and s.org_id=j.org_id`,
        [lease],
      )
    ).rows[0];
    if (!job) return false;
    const outcome = job.attempts > MAX_ATTEMPTS ? "failed" : await exportTurn(job, signal).catch(() => "failed");
    signal.throwIfAborted(); // On shutdown or tick timeout, let the durable lease expire.
    if (outcome === "pending") {
      await sql.query(
        "update public.langfuse_turn_exports set lease_id=null,lease_until=now()+interval '2 seconds',attempts=attempts-1 where sandbox_id=$1 and prompt_id=$2 and lease_id=$3::uuid",
        [job.sandbox_id, job.prompt_id, lease],
      );
      return true;
    }
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
  async function storedConfig(row?: SettingsRow): Promise<Config | null> {
    return row?.config_enc ? (JSON.parse(await decryptSecret(row.config_enc, key)) as Config) : null;
  }

  async function resolveSettingsConfig(input: Record<string, unknown>, row?: SettingsRow): Promise<Config> {
    const complete = input.host !== undefined && input.publicKey !== undefined && input.secretKey !== undefined;
    return resolveConfig(input, complete ? null : await storedConfig(row));
  }

  async function testConnection(
    config: Config,
    requestSignal: AbortSignal,
  ): Promise<"ok" | "rejected" | "unreachable"> {
    try {
      const response = await send(`${config.host}/api/public/projects`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([requestSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: { authorization: authorization(config) },
      });
      void response.body?.cancel().catch(() => {});
      if (response.ok) return "ok";
      return response.status === 401 || response.status === 403 ? "rejected" : "unreachable";
    } catch {
      return "unreachable";
    }
  }

  function route(authenticate: (request: Request) => Promise<CallerResult>): Route {
    return async (request) => {
      const match = new URL(request.url).pathname.match(/^\/api\/v1\/orgs\/([0-9a-f-]{36})\/langfuse(\/test)?$/i);
      if (!match) return null;
      const orgId = match[1]!.toLowerCase();
      const testing = Boolean(match[2]);
      const headers = { "cache-control": "no-store" };
      try {
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        const membership = auth.caller.orgs.find((o) => o.orgId === orgId);
        if (!membership || (membership.role !== "admin" && (testing || request.method !== "GET")))
          return Response.json({ error: "forbidden" }, { status: 403, headers });

        if (testing) {
          if (request.method !== "POST") return new Response(null, { status: 405, headers });
          const input = await readBody(request, 16384);
          const row = (
            await sql.query<SettingsRow>("select config_enc from public.org_langfuse where org_id=$1", [orgId])
          ).rows[0];
          const config = await resolveSettingsConfig(input, row);
          return Response.json({ status: await testConnection(config, request.signal) }, { headers });
        }

        if (request.method === "GET") {
          if (membership.role !== "admin") {
            const row = (
              await sql.query<Pick<SettingsRow, "enabled" | "content_mode">>(
                "select enabled,content_mode from public.org_langfuse where org_id=$1",
                [orgId],
              )
            ).rows[0];
            return Response.json(
              { enabled: row?.enabled ?? false, contentMode: row?.content_mode ?? "metadata" },
              { headers },
            );
          }
          const row = (
            await sql.query<
              SettingsRow & {
                exported: string | null;
                failed: string | null;
                dropped: string | null;
                last_export_at: Date | null;
              }
            >(
              `select c.enabled,c.content_mode,c.config_enc,stats.exported::text,stats.failed::text,stats.dropped::text,stats.last_export_at
               from public.orgs o left join public.org_langfuse c on o.id=c.org_id
               left join public.org_langfuse_export_stats stats on o.id=stats.org_id where o.id=$1`,
              [orgId],
            )
          ).rows[0];
          const config = await storedConfig(row);
          return Response.json(
            {
              enabled: row?.enabled ?? false,
              contentMode: row?.content_mode ?? "metadata",
              ...(row?.content_mode ? { content_mode: row.content_mode } : {}),
              host: config?.host ?? DEFAULT_HOST,
              publicKey: config?.publicKey ?? null,
              configured: config !== null,
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

        if (request.method !== "PUT" && request.method !== "DELETE")
          return new Response(null, { status: 405, headers });
        const input = request.method === "PUT" ? await readBody(request, 16384) : {};
        if (!sql.transaction) throw Error("Langfuse settings require transactions");
        return await sql.transaction(async (tx) => {
          // Lock the organization even before a configuration row exists.
          await tx.query("select id from public.orgs where id=$1 for no key update", [orgId]);
          if (request.method === "DELETE") {
            await tx.query("delete from public.org_langfuse where org_id=$1", [orgId]);
            return new Response(null, { status: 204, headers });
          }
          const row = (
            await tx.query<SettingsRow>(
              "select enabled,content_mode,config_enc from public.org_langfuse where org_id=$1",
              [orgId],
            )
          ).rows[0];
          const enabled = input.enabled === undefined ? (row?.enabled ?? false) : input.enabled;
          const contentMode = input.contentMode === undefined ? (row?.content_mode ?? "metadata") : input.contentMode;
          if (typeof enabled !== "boolean" || (contentMode !== "metadata" && contentMode !== "full"))
            throw Error("invalid Langfuse settings");
          const config = await resolveSettingsConfig(input, row);
          const encrypted = await encryptSecret(JSON.stringify(config), key);
          await tx.query(
            `insert into public.org_langfuse(org_id,enabled,content_mode,config_enc) values($1,$2,$3,decode($4,'hex'))
             on conflict(org_id) do update set enabled=excluded.enabled,content_mode=excluded.content_mode,config_enc=excluded.config_enc`,
            [orgId, enabled, contentMode, Buffer.from(encrypted).toString("hex")],
          );
          return Response.json({ enabled, contentMode }, { headers });
        });
      } catch {
        return Response.json({ error: "langfuse_configuration_unavailable" }, { status: 400, headers });
      }
    };
  }
  return { reconcileOne, async drain() {}, route };
}
