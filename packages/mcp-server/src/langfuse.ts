import { BodyTooLargeError } from "@armada/auth";
import { type AgentEvent, isFinalPromptStatus, reportedTurnUsage, type Sql, type TurnTokenUsage } from "@armada/core";
import { decryptSecret, encryptSecret, VaultError } from "@armada/core/server";
import { AuthUnavailable, type CallerResult } from "./caller.ts";
import { readBody } from "./control-body.ts";
import type { Route } from "./http.ts";
import type { createJobsRunner } from "./jobs/runner.ts";
import { createJobsStore, wakeSandboxJobs } from "./jobs/store.ts";
import {
  deleteLangfuseModel,
  fetchLangfuseModels,
  isKnownLangfuseArmadaModel,
  type LangfuseConfig,
  type LangfuseModelOverrideInput,
  LangfuseModelsError,
  summarizeLangfuseModels,
  syncMissingLangfuseModels,
  upsertLangfuseModel,
} from "./langfuse-models.ts";
import {
  type LangfuseSandboxContext,
  type LangfuseScorePayload,
  langfusePrLinkedScore,
  langfuseSpans,
  langfuseTurnScores,
} from "./langfuse-spans.ts";
import { PULL_REQUEST_SCAN_ELIGIBLE } from "./sandbox-lifecycle.ts";

type Config = LangfuseConfig;
type ContentMode = "metadata" | "full";
interface SettingsRow {
  enabled: boolean | null;
  content_mode: ContentMode | null;
  config_enc: Uint8Array<ArrayBuffer> | null;
}
export interface LangfuseOptions {
  logError?: (line: string) => void;
  now?: () => number;
}
class LangfuseInputError extends Error {}

const DEFAULT_HOST = "https://cloud.langfuse.com";
const REQUEST_TIMEOUT_MS = 5000;
const MODEL_SYNC_TIMEOUT_MS = 3000;
const MODEL_SYNC_TTL_MS = 10 * 60 * 1000;
const MODEL_SYNC_CACHE_MAX = 256;
const SETTINGS_BODY_MAX_BYTES = 16384;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

function errorReason(error: unknown) {
  if (error instanceof Error && error.name) return error.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return "error";
}

function resolveConfig(input: Record<string, unknown>, stored: Config | null): Config {
  if (input.host !== undefined && typeof input.host !== "string") throw new LangfuseInputError("invalid Langfuse host");
  let host: URL;
  try {
    host = new URL(String(input.host === undefined ? (stored?.host ?? DEFAULT_HOST) : input.host));
  } catch {
    throw new LangfuseInputError("invalid Langfuse host");
  }
  if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash || host.pathname !== "/")
    throw new LangfuseInputError("invalid Langfuse host");

  // A write-only key must stay bound to its configured origin.
  if (stored && host.origin !== stored.host && (input.publicKey === undefined || input.secretKey === undefined))
    throw new LangfuseInputError("changing Langfuse host requires both keys");

  const publicKey = input.publicKey === undefined ? stored?.publicKey : input.publicKey;
  const secretKey = input.secretKey === undefined ? stored?.secretKey : input.secretKey;
  const validKey = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\r\n:]/.test(value);
  if (!validKey(publicKey) || !validKey(secretKey)) throw new LangfuseInputError("invalid Langfuse keys");
  return { host: host.origin, publicKey, secretKey };
}

function authorization(config: Config): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
let prScanExpediteCount = 0;
export const prScanExpediteEpoch = () => prScanExpediteCount;

async function postLangfuseScore(
  send: typeof fetch,
  config: Config,
  score: LangfuseScorePayload,
  signal: AbortSignal,
  logError: ((line: string) => void) | undefined,
  orgId: string,
  sandboxId: string,
  requestSignal: AbortSignal = signal,
) {
  try {
    const res = await send(`${config.host}/api/public/scores`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: { "content-type": "application/json", authorization: authorization(config) },
      body: JSON.stringify(score),
    });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      logError?.(`armada: langfuse score export failed status=${res.status} orgId=${orgId} sandboxId=${sandboxId}`);
      return false;
    }
    return true;
  } catch (error) {
    if (!signal.aborted)
      logError?.(
        `armada: langfuse score export error reason=${errorReason(error)} orgId=${orgId} sandboxId=${sandboxId}`,
      );
    return false;
  }
}

async function expeditePrScan(tx: Sql, sandboxId: string) {
  const { rows } = await tx.query<{ id: string; org_id: string; generation: string }>(
    `select s.id,s.org_id,s.lifecycle_generation::text as generation ${PULL_REQUEST_SCAN_ELIGIBLE} and s.id=$1`,
    [sandboxId],
  );
  const row = rows[0];
  if (!row) return false;
  const { inserted } = await createJobsStore(tx).enqueueWithDisposition(
    "pr_scan",
    row.id,
    Number(row.generation),
    "periodic",
    null,
    { orgId: row.org_id, maxAttempts: 3 },
    tx,
  );
  if (!inserted) await wakeSandboxJobs(tx, row.id, ["pr_scan"], row.generation);
  prScanExpediteCount++;
  return true;
}

export async function upsertLangfusePrLinkedScores(
  sql: Sql,
  key: string,
  sandboxId: string,
  options: {
    send?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    logError?: ((line: string) => void) | undefined;
    timeoutMs?: number | undefined;
  } = {},
) {
  const send = options.send ?? fetch;
  const signal = options.signal ?? new AbortController().signal;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)]);
  const { rows } = await sql.query<{ prompt_id: string; org_id: string; config_enc: Uint8Array<ArrayBuffer> }>(
    `select e.prompt_id,e.org_id,c.config_enc from public.langfuse_turn_exports e
     join public.sandboxes s on s.id=e.sandbox_id and s.org_id=e.org_id
     join public.org_langfuse c on c.org_id=e.org_id and c.enabled
     join public.jobs j on j.kind='langfuse_export' and j.sandbox_id=e.sandbox_id and j.org_id=e.org_id
       and j.outcome->>'promptId'=e.prompt_id and j.state='done' and j.outcome->>'result' is distinct from 'dropped'
     where e.sandbox_id=$1 and e.completed_at is null and c.config_enc is not null
     order by e.observed_at desc limit 100`,
    [sandboxId],
  );
  if (!rows.length) return 0;
  let config: Config;
  try {
    config = JSON.parse(await decryptSecret(rows[0]!.config_enc, key)) as Config;
  } catch (error) {
    options.logError?.(
      `armada: langfuse score export error reason=${errorReason(error)} orgId=${rows[0]!.org_id} sandboxId=${sandboxId}`,
    );
    return 0;
  }
  let updated = 0;
  for (let offset = 0; offset < rows.length && !budget.aborted; offset += 8) {
    const batch = await Promise.allSettled(
      rows
        .slice(offset, offset + 8)
        .map((r) =>
          postLangfuseScore(
            send,
            config,
            langfusePrLinkedScore(sandboxId, r.prompt_id, true),
            signal,
            options.logError,
            r.org_id,
            sandboxId,
            budget,
          ),
        ),
    );
    let batchOk = 0;
    for (const r of batch) if (r.status === "fulfilled" && r.value) batchOk++;
    updated += batchOk;
    if (batchOk === 0) break;
  }
  return updated;
}
/** Claims reserve an attempt; a job aborted this many times settles as failed. */
type ExportHandler = Parameters<typeof createJobsRunner>[1][string];

const MAX_ABANDONED_ATTEMPTS = 5;
/** Native history reads that outlived their deadline and still run detached. */
type PromptEvent = Extract<AgentEvent, { kind: "prompt" }>;
interface ExportJob {
  sandbox_id: string;
  prompt_id: string;
  org_id: string;
  runtime_ack: string | null;
  terminal_status: PromptEvent["status"];
  observed_ms: number;
  config_enc: Uint8Array<ArrayBuffer> | null;
  content_mode: string | null;
  application_secrets: boolean;
  docker_request_enc: Uint8Array<ArrayBuffer> | null;
}

export function createLangfuse(sql: Sql, key: string, send: typeof fetch = fetch, options: LangfuseOptions = {}) {
  const logError = options.logError;
  const now = options.now ?? (() => Date.now());
  const modelSyncCache = new Map<string, { allAt?: number; models: Map<string, number> }>();
  const syncCacheKey = (orgId: string, config: Config) => `${orgId}:${config.host}:${config.publicKey}`;
  const isFresh = (ts: number | undefined, current: number) =>
    ts !== undefined && current >= ts && current - ts < MODEL_SYNC_TTL_MS;

  function clearOrgSyncCache(orgId: string) {
    const prefix = `${orgId}:`;
    for (const cacheKey of modelSyncCache.keys()) {
      if (cacheKey.startsWith(prefix)) modelSyncCache.delete(cacheKey);
    }
  }

  function uncachedModels(orgId: string, config: Config, models: readonly string[]) {
    const current = now();
    const entry = modelSyncCache.get(syncCacheKey(orgId, config));
    if (!entry) return [...models];
    if (isFresh(entry.allAt, current)) return [];
    return models.filter((model) => !isFresh(entry.models.get(model.trim().toLowerCase()), current));
  }

  function recordModelSync(orgId: string, config: Config, models?: readonly string[]) {
    const current = now();
    const cacheKey = syncCacheKey(orgId, config);
    const prev = modelSyncCache.get(cacheKey);
    modelSyncCache.delete(cacheKey);
    const next = prev ? { ...prev, models: new Map(prev.models) } : { models: new Map<string, number>() };
    if (!models) next.allAt = current;
    else for (const model of models) next.models.set(model.trim().toLowerCase(), current);
    modelSyncCache.set(cacheKey, next);
    while (modelSyncCache.size > MODEL_SYNC_CACHE_MAX) {
      const oldest = modelSyncCache.keys().next().value;
      if (oldest === undefined) break;
      modelSyncCache.delete(oldest);
    }
  }

  async function bestEffortModelSync(
    orgId: string,
    config: Config,
    signal: AbortSignal,
    onlyModels?: readonly string[],
    sandboxId?: string,
  ) {
    try {
      const result = await syncMissingLangfuseModels(
        send,
        config,
        AbortSignal.any([signal, AbortSignal.timeout(MODEL_SYNC_TIMEOUT_MS)]),
        onlyModels ? { onlyModels } : undefined,
      );
      if (result.failed.length === 0) recordModelSync(orgId, config, onlyModels);
    } catch (error) {
      if (!signal.aborted) {
        const scope = sandboxId ? `orgId=${orgId} sandboxId=${sandboxId}` : `orgId=${orgId}`;
        logError?.(`armada: langfuse model sync error reason=${errorReason(error)} ${scope}`);
      }
    }
  }
  async function history(job: ExportJob): Promise<AgentEvent[] | null> {
    if (job.runtime_ack === null) return [];
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
    return events;
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
    canDispatch: () => Promise<boolean>,
  ): Promise<"exported" | "failed" | "retry" | "dropped"> {
    if (!job.config_enc) return "dropped";
    const events = await history(job);
    if (!events) return "dropped";
    const terminal = events.findLast((e): e is PromptEvent => e.kind === "prompt" && isFinalPromptStatus(e.status));
    const turnEvents = events.filter((e) => e.kind !== "prompt" || !isFinalPromptStatus(e.status));
    turnEvents.push({
      kind: "prompt",
      id: job.prompt_id,
      promptId: job.prompt_id,
      text: "",
      ...terminal,
      at: terminal?.at || job.observed_ms,
      status: job.terminal_status,
    });
    const snapshot = await sql.query<LangfuseSandboxContext & { turns: TurnTokenUsage[] | null }>(
      `select s.usage_turns->'turns' as turns, s.org_id as "orgId", s.owner_id as "ownerId",
        s.provider::text, s.harness::text, s.reasoning_effort as "reasoningEffort",
        s.repository_dir as "repositoryDir", s.external_ref as "externalRef",
        s.resource_project as "resourceProject", s.pull_requests as "pullRequests",
        s.task_outcome as "taskOutcome", s.pull_request_reports as "pullRequestReports",
        s.pull_request_source as "pullRequestSource", s.pull_request_scan as "pullRequestScan",
        g.name as "goldenName",
        coalesce((select tm.requested_model from public.sandbox_turn_models tm
          where tm.sandbox_id=s.id and tm.prompt_id=$3), s.model) as "requestedModel",
        (select lt.name from public.template_launch_requests tlr
          join public.launch_templates lt on lt.id=tlr.template_id
          where tlr.sandbox_id=s.id order by tlr.created_at desc limit 1) as "templateName"
      from public.sandboxes s left join public.goldens g on g.id=s.golden_id
      where s.id=$1 and s.org_id=$2`,
      [job.sandbox_id, job.org_id, job.prompt_id],
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
    const marks = {
      historyUnavailable: job.runtime_ack === null,
      ...(withheld ? { contentWithheld: "application_secret_bindings" } : {}),
    };
    const spans = langfuseSpans(
      job.sandbox_id,
      turnEvents,
      usage,
      job.content_mode === "full" && !withheld,
      marks,
      sandbox,
    );
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
    if (!(await canDispatch())) return "dropped";
    signal.throwIfAborted();
    if (!withheld) {
      const seen = new Set<string>();
      const unpriced: string[] = [];
      for (const row of usage) {
        const usd = row.pricing?.usd;
        if ((usd !== null && usd !== undefined) || !row.model || !isKnownLangfuseArmadaModel(row.model)) continue;
        const trimmed = row.model.trim();
        const lower = trimmed.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        unpriced.push(trimmed);
      }
      const pending = unpriced.length ? uncachedModels(job.org_id, config, unpriced) : [];
      if (pending.length) {
        await bestEffortModelSync(job.org_id, config, signal, pending, job.sandbox_id);
        signal.throwIfAborted();
      }
    }
    let response: Response;
    try {
      response = await send(`${config.host}/api/public/otel/v1/traces`, {
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
    } catch (error) {
      if (signal.aborted) throw error;
      logError?.(
        `armada: langfuse trace export error reason=${errorReason(error)} orgId=${job.org_id} sandboxId=${job.sandbox_id}`,
      );
      return "retry";
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      logError?.(
        `armada: langfuse trace export failed status=${response.status} orgId=${job.org_id} sandboxId=${job.sandbox_id}`,
      );
      return response.status === 429 || response.status >= 500 ? "retry" : "failed";
    }
    const scores = langfuseTurnScores(job.sandbox_id, turnEvents, sandbox, marks);
    await Promise.allSettled(
      scores.map((score) => postLangfuseScore(send, config, score, signal, logError, job.org_id, job.sandbox_id)),
    );
    if (scores.some((score) => score.name === "pr_linked" && score.value === 0) && !signal.aborted) {
      const linked = (
        await sql.query<{ linked: boolean }>(
          "select jsonb_array_length(coalesce(pull_requests,'[]'::jsonb))>0 as linked from public.sandboxes where id=$1 and org_id=$2",
          [job.sandbox_id, job.org_id],
        )
      ).rows[0]?.linked;
      if (linked)
        await postLangfuseScore(
          send,
          config,
          langfusePrLinkedScore(job.sandbox_id, job.prompt_id, true),
          signal,
          logError,
          job.org_id,
          job.sandbox_id,
        );
    }
    return "exported";
  }

  const exportJob: ExportHandler = {
    concurrency: 1,
    async run(claim, { signal: leaseSignal, canDispatch }) {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(30_000)]);
      const { promptId, historyRetries = 0 } = claim.outcome as { promptId: string; historyRetries?: number };
      const job = (
        await sql.query<ExportJob>(
          `select j.sandbox_id,j.prompt_id,j.org_id,j.runtime_ack,j.terminal_status,
          extract(epoch from j.observed_at)::double precision*1000 as observed_ms,
          c.config_enc,
          -- Use the more restrictive of the mode allowed at settlement and the current one.
          case when c.org_id is null then null
            when j.allowed_content_mode='full' and c.content_mode='full' then 'full' else 'metadata' end
            as content_mode,
          s.application_secret_tainted or exists(select 1 from public.template_launch_requests r
            where r.sandbox_id=j.sandbox_id
              and coalesce(r.manifest->'definition'->'secrets','[]'::jsonb) not in ('[]'::jsonb,'null'::jsonb)
          ) as application_secrets,
          (select d.request_enc from public.docker_launch_manifests d where d.sandbox_id=j.sandbox_id) as docker_request_enc
        from public.langfuse_turn_exports j join public.sandboxes s on s.id=j.sandbox_id
        left join public.org_langfuse c on c.org_id=j.org_id and c.enabled
        where j.sandbox_id=$1 and j.prompt_id=$2 and s.org_id=j.org_id`,
          [claim.sandbox_id, promptId],
        )
      ).rows[0];
      if (!job) return { status: "done" };

      const effectiveAttempts = claim.attempts - historyRetries;
      const outcome =
        effectiveAttempts > MAX_ABANDONED_ATTEMPTS || claim.attempts > claim.max_attempts
          ? "failed"
          : await exportTurn(job, signal, canDispatch).catch((error: unknown) => {
              if (signal.aborted) throw error;
              logError?.(
                `armada: langfuse trace export error reason=${errorReason(error)} orgId=${job.org_id} sandboxId=${job.sandbox_id}`,
              );
              return "failed" as const;
            });
      signal.throwIfAborted();
      if (outcome === "retry" && effectiveAttempts < MAX_ABANDONED_ATTEMPTS && claim.attempts < claim.max_attempts) {
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, effectiveAttempts - 1));
        return { status: "retry", after: new Date(now() + delay) };
      }
      const finalOutcome = outcome === "retry" ? "failed" : outcome;
      return {
        ...(finalOutcome === "failed"
          ? { status: "fail", reason: "langfuse_export_failed" }
          : { status: "done", outcome: { ...(claim.outcome as Record<string, unknown>), result: finalOutcome } }),
        async commit(tx) {
          await tx.query(
            `insert into public.org_langfuse_export_stats as stats(org_id,exported,failed,dropped,last_export_at)
              values ($1,($2='exported')::int,($2='failed')::int,($2='dropped')::int,
                case when $2='exported' then clock_timestamp() end)
              on conflict(org_id) do update set exported=stats.exported+excluded.exported,
                failed=stats.failed+excluded.failed,dropped=stats.dropped+excluded.dropped,
                last_export_at=greatest(stats.last_export_at,excluded.last_export_at)`,
            [job.org_id, finalOutcome],
          );
          if (finalOutcome === "exported") await expeditePrScan(tx, job.sandbox_id);
        },
      };
    },
  };
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

  async function handleModelsRoute(
    request: Request,
    orgId: string,
    syncing: boolean,
    rawModelId: string | undefined,
    headers: Record<string, string>,
  ) {
    let allowed: readonly string[] = ["GET", "PUT"];
    if (syncing) allowed = ["POST"];
    else if (rawModelId !== undefined) allowed = ["DELETE"];
    if (!allowed.includes(request.method)) return new Response(null, { status: 405, headers });

    const row = (await sql.query<SettingsRow>("select config_enc from public.org_langfuse where org_id=$1", [orgId]))
      .rows[0];
    const config = await storedConfig(row);
    if (!config) return Response.json({ error: "langfuse_not_configured" }, { status: 400, headers });

    if (syncing) {
      const { created, skipped, failed, summary } = await syncMissingLangfuseModels(send, config, request.signal);
      clearOrgSyncCache(orgId);
      return Response.json({ created, skipped, failed, ...summary }, { headers });
    }
    if (rawModelId !== undefined) {
      let modelId: string;
      try {
        modelId = decodeURIComponent(rawModelId);
      } catch {
        throw new LangfuseModelsError("invalid_input", "Invalid modelId");
      }
      await deleteLangfuseModel(send, config, modelId, request.signal);
      clearOrgSyncCache(orgId);
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "GET") {
      return Response.json(summarizeLangfuseModels(await fetchLangfuseModels(send, config, request.signal)), {
        headers,
      });
    }
    let input: Record<string, unknown>;
    try {
      input = await readBody(request, SETTINGS_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof VaultError) throw new LangfuseModelsError("invalid_input", "Invalid model pricing");
      throw error;
    }
    const model = await upsertLangfuseModel(
      send,
      config,
      input as unknown as LangfuseModelOverrideInput,
      request.signal,
    );
    clearOrgSyncCache(orgId);
    const summary = summarizeLangfuseModels(await fetchLangfuseModels(send, config, request.signal));
    return Response.json({ model, ...summary }, { headers });
  }

  function route(authenticate: (request: Request) => Promise<CallerResult>): Route {
    return async (request) => {
      const match = new URL(request.url).pathname.match(
        /^\/api\/v1\/orgs\/([0-9a-f-]{36})\/langfuse(?:(\/test)|(\/models)(?:(\/sync)|\/([^/]+))?)?$/i,
      );
      if (!match) return null;
      const orgId = match[1]!.toLowerCase();
      const testing = Boolean(match[2]);
      const modelsRoute = Boolean(match[3]);
      const syncing = Boolean(match[4]);
      const rawModelId = match[5];
      const headers = { "cache-control": "no-store" };
      try {
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        const membership = auth.caller.orgs.find((o) => o.orgId === orgId);
        if (!membership || (membership.role !== "admin" && (testing || modelsRoute || request.method !== "GET")))
          return Response.json({ error: "forbidden" }, { status: 403, headers });

        if (modelsRoute) return await handleModelsRoute(request, orgId, syncing, rawModelId, headers);

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
        const saved = await sql.transaction(async (tx) => {
          // Lock the organization even before a configuration row exists.
          await tx.query("select id from public.orgs where id=$1 for no key update", [orgId]);
          if (request.method === "DELETE") {
            await tx.query("delete from public.org_langfuse where org_id=$1", [orgId]);
            return null;
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
            throw new LangfuseInputError("invalid Langfuse settings");
          const config = await resolveSettingsConfig(input, row);
          const encrypted = await encryptSecret(JSON.stringify(config), key);
          await tx.query(
            `insert into public.org_langfuse(org_id,enabled,content_mode,config_enc) values($1,$2,$3,decode($4,'hex'))
             on conflict(org_id) do update set enabled=excluded.enabled,content_mode=excluded.content_mode,config_enc=excluded.config_enc`,
            [orgId, enabled, contentMode, Buffer.from(encrypted).toString("hex")],
          );
          return { enabled, contentMode, config };
        });
        clearOrgSyncCache(orgId);
        if (!saved) return new Response(null, { status: 204, headers });
        if (saved.enabled) await bestEffortModelSync(orgId, saved.config, request.signal);
        return Response.json({ enabled: saved.enabled, contentMode: saved.contentMode }, { headers });
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return Response.json({ error: "request_too_large" }, { status: 413, headers });
        }
        if (error instanceof LangfuseModelsError) {
          if (error.code === "invalid_input")
            return Response.json({ error: "invalid_model_pricing" }, { status: 400, headers });
          return Response.json(
            { error: error.code === "rejected" ? "langfuse_rejected" : "langfuse_unreachable" },
            { status: 502, headers },
          );
        }
        if (error instanceof LangfuseInputError || error instanceof VaultError) {
          return Response.json({ error: "langfuse_configuration_unavailable" }, { status: 400, headers });
        }
        if (error instanceof AuthUnavailable) {
          return Response.json({ error: "service_unavailable" }, { status: 503, headers });
        }
        logError?.(`armada: langfuse settings error reason=${errorReason(error)} orgId=${orgId}`);
        return Response.json({ error: "service_unavailable" }, { status: 503, headers });
      }
    };
  }
  return { exportJob, route };
}
