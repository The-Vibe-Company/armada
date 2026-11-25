import { createHash } from "node:crypto";
import {
  type AgentEvent,
  isFinalPromptStatus,
  type ResourceProject,
  type SandboxPullRequest,
  type TaskOutcome,
  type ToolCall,
  type TurnTokenUsage,
  VERSION,
} from "@armada/core";
import { redactCredentials } from "./log.ts";

export interface LangfuseSandboxContext {
  orgId?: string | null | undefined;
  ownerId?: string | null | undefined;
  provider?: string | null | undefined;
  harness?: string | null | undefined;
  requestedModel?: string | null | undefined;
  reasoningEffort?: string | null | undefined;
  repositoryDir?: string | null | undefined;
  externalRef?: string | null | undefined;
  goldenName?: string | null | undefined;
  templateName?: string | null | undefined;
  resourceProject?: ResourceProject | null | undefined;
  pullRequests?: SandboxPullRequest[] | null | undefined;
  taskOutcome?: TaskOutcome | null | undefined;
  pullRequestReports?:
    | Record<string, { state?: string; prNumber?: number; prUrl?: string; headSha?: string }>
    | null
    | undefined;
  pullRequestSource?: { repositories?: { url: string; dir?: string; branch?: string }[] } | null | undefined;
  pullRequestScan?:
    | {
        pushes?: Record<string, [string, string[]][]>;
        discovered?: { repository: string; number: number }[];
        heads?: Record<string, Record<string, Record<string, string>>>;
      }
    | null
    | undefined;
}
export interface LangfuseScorePayload {
  id: string;
  traceId: string;
  name: "turn_success" | "tool_error_rate" | "ttft_ms" | "pr_linked";
  value: number;
  dataType: "BOOLEAN" | "NUMERIC";
}

type PromptEvent = Extract<AgentEvent, { kind: "prompt" }>;
type Scrubber = (value: unknown) => unknown;
type PrInfo = { prUrl?: string; prNumber?: number; prRepo?: string; prState?: "open" | "merged" | "closed" };
type Resolved = PrInfo &
  Partial<
    Record<
      | "branch"
      | "headSha"
      | "repo"
      | "templateName"
      | "goldenName"
      | "externalRef"
      | "provider"
      | "harness"
      | "ownerId"
      | "orgId"
      | "requestedModel"
      | "reasoningEffort",
      string
    >
  >;

const ROOT_MAX = 64 * 1024;
const TOOL_MAX = 32 * 1024;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/i;
const PR_SCAN =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi;
const SHA = /^[a-f0-9]{7,40}$/i;
const PR_STATES = new Set(["open", "merged", "closed"]);
const DIMS = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["cachedTokens", "cache_read_input_tokens"],
  ["cacheWriteTokens", "cache_creation_input_tokens"],
  ["reasoningTokens", "reasoning"],
] as const;

const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
const nano = (at: number) => (BigInt(Math.max(0, Math.trunc(at))) * 1000000n).toString();
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const scrub: Scrubber = (v) => {
  if (typeof v === "string") return redactCredentials(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactCredentials(k), scrub(x)]));
  return v;
};
const realModel = (m: string | null | undefined) => {
  const s = typeof m === "string" ? m.trim() : "";
  return s && s.toLowerCase() !== "default" ? s : undefined;
};
const validRepo = (r: string | undefined) => {
  const [a, b] = r && REPO_NAME.test(r) ? r.split("/") : [];
  return a && b && a !== "." && a !== ".." && b !== "." && b !== ".." ? r : undefined;
};
const parseRepo = (u: string | null | undefined) =>
  typeof u === "string" ? validRepo(REPO_URL.exec(u.trim())?.[1]) : undefined;
const makePr = (repo: string | undefined, raw: unknown) => {
  const prRepo = validRepo(repo);
  const prNumber = typeof raw === "number" ? raw : Number(raw);
  return prRepo && Number.isSafeInteger(prNumber) && prNumber > 0
    ? { prRepo, prNumber, prUrl: `https://github.com/${prRepo}/pull/${prNumber}` }
    : undefined;
};
const parsePr = (u: string | undefined) => {
  const m = typeof u === "string" ? PR_URL.exec(u.trim()) : null;
  return m ? makePr(m[1], Number(m[2])) : undefined;
};

function boundedScrub(raw: unknown, maxBytes: number) {
  if (raw === undefined) return undefined;
  const s = scrub(raw);
  const text = typeof s === "string" ? s : JSON.stringify(s);
  if (text === undefined) return undefined;
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  const cut = buf.subarray(0, end).toString("utf8");
  return { text: cut.endsWith("\ufffd") ? cut.slice(0, -1) : cut, truncated: true };
}

function scanEventsPr(events: readonly AgentEvent[]) {
  let found: { prRepo: string; prNumber: number; prUrl: string } | undefined;
  const check = (raw: unknown) => {
    const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? JSON.stringify(raw) : "";
    for (const m of text ? text.matchAll(PR_SCAN) : []) found = makePr(m[1], Number(m[2])) ?? found;
  };
  for (const e of events) {
    if (e.kind === "prompt") check(e.text);
    else if (e.kind === "message" && !e.retracted) {
      check(e.text);
      for (const t of e.tools) {
        check(t.input);
        check(t.result?.output);
      }
    }
  }
  return found;
}

export function resolveLangfuseContext(
  ctx: LangfuseSandboxContext = {},
  events: readonly AgentEvent[] = [],
  opts: { promptId?: string; contentWithheld?: boolean } = {},
) {
  const trusted = !opts.contentWithheld;
  const repos = ctx.pullRequestSource?.repositories ?? [];
  const src = repos.length === 1 ? repos[0] : (repos.find((r) => r.dir && r.dir === ctx.repositoryDir) ?? repos[0]);
  const baseRepo = parseRepo(src?.url) ?? parseRepo(ctx.resourceProject?.url);
  const outReady = ctx.taskOutcome?.state === "ready" ? ctx.taskOutcome : undefined;
  const confirmed = (ctx.pullRequests ?? []).filter(
    (p) => validRepo(p.repository) && Number.isSafeInteger(p.number) && p.number > 0,
  );
  let pr: PrInfo = {};
  let branch: string | undefined;
  let headSha: string | undefined;

  if (confirmed.length) {
    const outPr = trusted ? parsePr(outReady?.prUrl) : undefined;
    const outNum = trusted ? (outPr?.prNumber ?? outReady?.prNumber) : undefined;
    const byOut = outNum
      ? confirmed.find(
          (p) => p.number === outNum && (!outPr || p.repository.toLowerCase() === outPr.prRepo.toLowerCase()),
        )
      : undefined;
    const picked =
      byOut ?? [...confirmed].sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0))[0]!;
    pr = {
      ...makePr(picked.repository, picked.number),
      ...(PR_STATES.has(picked.state) ? { prState: picked.state } : {}),
    };
    if (trusted && picked.headBranch) branch = picked.headBranch;
  } else if (trusted) {
    const reports = Object.entries(ctx.pullRequestReports ?? {});
    const isPromptKey = (k: string) => Boolean(opts.promptId) && k.slice(k.indexOf(":") + 1) === opts.promptId;
    const cands = [
      ...reports.filter(([k]) => isPromptKey(k)).map(([, v]) => v),
      ...(outReady ? [outReady] : []),
      ...[...reports]
        .reverse()
        .filter(([k]) => !isPromptKey(k))
        .map(([, v]) => v),
    ];
    for (const c of cands) {
      if (c.prUrl !== undefined) {
        const p = parsePr(c.prUrl);
        if (!p) continue;
        pr = p;
      } else if (typeof c.prNumber === "number" && Number.isSafeInteger(c.prNumber) && c.prNumber > 0) {
        pr = makePr(baseRepo, c.prNumber) ?? { prNumber: c.prNumber };
      } else {
        continue;
      }
      if (c.headSha && SHA.test(c.headSha)) headSha = c.headSha;
      break;
    }
    if (!pr.prUrl && !pr.prNumber) {
      const disc = [...(ctx.pullRequestScan?.discovered ?? [])]
        .reverse()
        .map((d) => makePr(d.repository, d.number))
        .find(Boolean);
      pr = disc ?? scanEventsPr(opts.promptId ? events.filter((e) => e.promptId === opts.promptId) : events) ?? {};
    }
  }

  const repo = pr.prRepo ?? baseRepo;
  if (trusted) {
    const key = repo?.toLowerCase();
    const pushes = key ? ctx.pullRequestScan?.pushes?.[key] : Object.values(ctx.pullRequestScan?.pushes ?? {})[0];
    branch = branch ?? pushes?.[0]?.[0] ?? src?.branch ?? ctx.resourceProject?.branch ?? undefined;
    const dirs = key ? ctx.pullRequestScan?.heads?.[key] : undefined;
    const dirMap = dirs ? (ctx.repositoryDir && dirs[ctx.repositoryDir]) || Object.values(dirs)[0] : undefined;
    const sha =
      (branch ? (dirMap?.[branch] ?? pushes?.find(([ref]) => ref === branch)?.[1]?.[0]) : undefined) ??
      outReady?.headSha;
    if (!headSha && sha && SHA.test(sha)) headSha = sha;
  }

  const fields: Record<string, unknown> = {
    ...pr,
    branch,
    headSha,
    repo,
    templateName: ctx.templateName || undefined,
    goldenName: ctx.goldenName || undefined,
    externalRef: ctx.externalRef || undefined,
    provider: ctx.provider || undefined,
    harness: ctx.harness || undefined,
    ownerId: ctx.ownerId || undefined,
    orgId: ctx.orgId || undefined,
    requestedModel: trusted ? realModel(ctx.requestedModel) : undefined,
    reasoningEffort: trusted ? ctx.reasoningEffort || undefined : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Resolved;
}

function collectTurn(
  sandboxId: string,
  end: PromptEvent,
  events: readonly AgentEvent[],
  ctx: LangfuseSandboxContext,
  withheld?: string,
) {
  const promptId = end.promptId!;
  const history = events.filter((e) => e.promptId === promptId);
  const start = history.find((e): e is PromptEvent => e.kind === "prompt" && e.status === "running");
  const startAt = start?.at || end.at;
  const messages = new Map<string, string>();
  const tools = new Map<string, { first: number; last: number; tool: ToolCall }>();
  let firstAt: number | undefined;
  let msgModel: string | undefined;
  for (const e of history) {
    if (e.kind !== "message") continue;
    if (!e.retracted && e.responseKind !== "tool_result") {
      const id = e.messageId ?? e.id;
      messages.set(id, e.textMode === "delta" ? (messages.get(id) ?? "") + e.text : e.text);
      if (e.at > 0 && (firstAt === undefined || e.at < firstAt)) firstAt = e.at;
      msgModel ??= realModel(e.model);
    }
    for (const t of e.tools) {
      const prev = tools.get(t.id);
      const server = t.server ?? prev?.tool.server;
      const name = e.responseKind === "tool_result" && prev ? prev.tool.name : t.name;
      const input = t.input !== undefined ? t.input : prev?.tool.input;
      tools.set(t.id, {
        first: prev ? Math.min(prev.first, e.at) : e.at,
        last: prev ? Math.max(prev.last, e.at) : e.at,
        tool: { ...prev?.tool, ...t, ...(server !== undefined ? { server } : {}), input, name },
      });
    }
  }
  const turnKey = `${sandboxId}/${promptId}`;
  const endAt = Math.max(startAt, end.at);
  const timingComplete = Boolean(start?.at && end.at > startAt);
  const validFirst =
    timingComplete && firstAt !== undefined && firstAt >= startAt && firstAt <= endAt ? firstAt : undefined;
  return {
    promptId,
    start,
    startAt,
    endAt,
    timingComplete,
    durationMs: start?.at && end.at >= startAt ? end.at - startAt : undefined,
    turnKey,
    traceId: hash(turnKey, 32),
    rootSpanId: hash(turnKey, 16),
    messages,
    msgModel,
    tools,
    toolCount: tools.size,
    toolErrorCount: [...tools.values()].filter((t) => t.tool.result?.isError).length,
    ttftMs: validFirst !== undefined ? validFirst - startAt : undefined,
    completionStartTime: validFirst !== undefined ? new Date(validFirst).toISOString() : undefined,
    resolved: resolveLangfuseContext(ctx, history, { promptId, contentWithheld: Boolean(withheld) }),
  };
}

function encodeAttrs(values: Record<string, unknown>, tags: readonly string[]) {
  const attrs: { key: string; value: { stringValue?: string; arrayValue?: { values: { stringValue: string }[] } } }[] =
    [];
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const v = scrub(raw);
    attrs.push({ key, value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) } });
  }
  if (tags.length) {
    attrs.push({
      key: "langfuse.trace.tags",
      value: { arrayValue: { values: tags.map((t) => ({ stringValue: redactCredentials(t) })) } },
    });
  }
  return attrs;
}

export function langfuseSpans(
  sandboxId: string,
  events: AgentEvent[],
  turns: TurnTokenUsage[],
  full: boolean,
  marks: { historyUnavailable?: boolean; contentWithheld?: string } = {},
  context: LangfuseSandboxContext = {},
) {
  const spans = [];
  const trusted = !marks.contentWithheld;
  const exportFull = full && trusted;
  for (const end of events) {
    if (end.kind !== "prompt" || !isFinalPromptStatus(end.status) || !end.promptId) continue;
    const f = collectTurn(sandboxId, end, events, context, marks.contentWithheld);
    const byModel = new Map<string, TurnTokenUsage[]>();
    for (const row of turns) {
      if (row.promptId !== f.promptId) continue;
      const k = realModel(row.model) ?? "";
      byModel.set(k, [...(byModel.get(k) ?? []), row]);
    }
    const groups = [...byModel.entries()]
      .map(([key, rows]) => ({ key, model: key || (byModel.size === 1 ? f.msgModel : undefined), rows }))
      .filter(
        (g) =>
          g.model ||
          g.rows.some(
            (r) =>
              DIMS.some(([d]) => r[d] != null) || (r.pricing?.usd != null && Number.isFinite(Number(r.pricing.usd))),
          ),
      );
    const executedModels = trusted
      ? [...new Set(groups.map((g) => g.model).filter((m): m is string => Boolean(m)))]
      : [];
    const r = f.resolved;
    const repoPart = r.prRepo || r.repo;
    const subj =
      repoPart && r.prNumber
        ? `${repoPart} #${r.prNumber}`
        : r.prNumber
          ? `PR #${r.prNumber}`
          : r.repo || r.templateName || r.goldenName;
    const traceName = !trusted
      ? "Armada sandbox"
      : r.harness && subj
        ? `${r.harness} · ${subj}`
        : subj || (r.harness ? `${r.harness} · sandbox` : "Armada sandbox");
    const rawTags = [
      r.provider && `provider:${r.provider}`,
      r.harness && `harness:${r.harness}`,
      `status:${end.status}`,
      trusted && r.repo && `repo:${r.repo}`,
      trusted && (r.prUrl || r.prNumber) && "pr_linked",
      trusted && r.templateName && `template:${r.templateName}`,
      trusted && r.goldenName && `golden:${r.goldenName}`,
      ...(trusted ? executedModels.map((m) => `model:${m}`) : []),
      marks.contentWithheld && "content_withheld",
    ];
    const tags = [...new Set(rawTags.filter((t): t is string => Boolean(t)))];
    const traceAttrs: Record<string, unknown> = {
      "langfuse.trace.name": traceName,
      "langfuse.session.id": sandboxId,
      "langfuse.user.id": r.ownerId,
      "langfuse.release": VERSION,
      ...Object.fromEntries(
        Object.entries(r)
          .filter(([k]) => k !== "ownerId")
          .map(([k, v]) => [`langfuse.trace.metadata.${snake(k)}`, v]),
      ),
      "langfuse.trace.metadata.prompt_id": trusted ? f.promptId : undefined,
      "langfuse.trace.metadata.executed_models": executedModels.length ? executedModels : undefined,
      "langfuse.trace.metadata.status": end.status,
      "langfuse.trace.metadata.tool_count": f.toolCount,
      "langfuse.trace.metadata.tool_error_count": f.toolErrorCount,
      "langfuse.trace.metadata.duration_ms": f.durationMs,
      "langfuse.trace.metadata.ttft_ms": f.ttftMs,
    };
    const mk = (
      spanId: string,
      parentSpanId: string | undefined,
      name: string,
      s: number,
      e: number,
      err: boolean,
      obs: Record<string, unknown>,
    ) => ({
      traceId: f.traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind: 1,
      startTimeUnixNano: nano(s),
      endTimeUnixNano: nano(Math.max(s, e)),
      status: { code: err ? 2 : 1 },
      attributes: encodeAttrs(
        { ...traceAttrs, ...Object.fromEntries(Object.entries(obs).map(([k, v]) => [`langfuse.observation.${k}`, v])) },
        tags,
      ),
    });

    const rootIn = exportFull ? boundedScrub(f.start?.text || end.text || undefined, ROOT_MAX) : undefined;
    const rootOut =
      exportFull && f.messages.size ? boundedScrub([...f.messages.values()].join("\n"), ROOT_MAX) : undefined;
    const rootLevel =
      end.status === "failed" ? "ERROR" : end.status !== "finished" || f.toolErrorCount > 0 ? "WARNING" : "DEFAULT";
    spans.push(
      mk(
        f.rootSpanId,
        undefined,
        trusted && r.harness ? `${r.harness} turn` : "Armada turn",
        f.startAt,
        f.endAt,
        end.status !== "finished",
        {
          type: "agent",
          level: rootLevel,
          input: rootIn?.text,
          output: rootOut?.text,
          "metadata.status": end.status,
          "metadata.timing_incomplete": f.timingComplete ? undefined : true,
          "metadata.history_unavailable": marks.historyUnavailable || undefined,
          "metadata.content_withheld": marks.contentWithheld,
          "metadata.failure_reason": exportFull ? end.reason : end.status === "failed" ? "turn_failed" : undefined,
          "metadata.input_truncated": rootIn?.truncated ? true : undefined,
          "metadata.output_truncated": rootOut?.truncated ? true : undefined,
        },
      ),
    );
    for (const [idx, g] of groups.entries()) {
      const usageDetails = Object.fromEntries(
        DIMS.flatMap(([d, k]) =>
          g.rows.every((row) => typeof row[d] === "number")
            ? [[k, g.rows.reduce((s, row) => s + (row[d] as number), 0)]]
            : [],
        ),
      );
      const costs = g.rows.map((row) => row.pricing?.usd);
      const costDetails =
        costs.length && costs.every((c) => c != null && Number.isFinite(Number(c)))
          ? { total: costs.reduce((s, c) => s + Number(c), 0) }
          : undefined;
      spans.push(
        mk(
          hash(`${f.turnKey}/gen/${g.key || idx}`, 16),
          f.rootSpanId,
          trusted && g.model ? redactCredentials(g.model) : "generation",
          f.startAt,
          f.endAt,
          end.status !== "finished",
          {
            type: "generation",
            level: end.status === "failed" ? "ERROR" : "DEFAULT",
            "model.name": trusted ? g.model : undefined,
            usage_details: Object.keys(usageDetails).length ? usageDetails : undefined,
            cost_details: costDetails,
            completion_start_time: f.completionStartTime,
            "metadata.usage": trusted ? g.rows : undefined,
          },
        ),
      );
    }
    for (const [id, t] of f.tools) {
      const toolIn = exportFull ? boundedScrub(t.tool.input, TOOL_MAX) : undefined;
      const toolOut = exportFull ? boundedScrub(t.tool.result?.output, TOOL_MAX) : undefined;
      spans.push(
        mk(
          hash(`${f.turnKey}/${id}`, 16),
          f.rootSpanId,
          trusted ? redactCredentials(t.tool.name) : "tool",
          t.first,
          t.last,
          Boolean(t.tool.result?.isError),
          {
            type: "tool",
            level: t.tool.result?.isError ? "ERROR" : "DEFAULT",
            input: toolIn?.text,
            output: toolOut?.text,
            "metadata.mcp_server": trusted && t.tool.server ? t.tool.server : undefined,
            "metadata.duration_ms": Math.max(0, t.last - t.first),
            "metadata.input_truncated": toolIn?.truncated ? true : undefined,
            "metadata.output_truncated": toolOut?.truncated ? true : undefined,
          },
        ),
      );
    }
  }
  return spans;
}

export function langfuseTurnScores(
  sandboxId: string,
  events: readonly AgentEvent[],
  context: LangfuseSandboxContext = {},
  marks: { contentWithheld?: string } = {},
) {
  const scores: LangfuseScorePayload[] = [];
  for (const end of events) {
    if (end.kind !== "prompt" || !isFinalPromptStatus(end.status) || !end.promptId) continue;
    const f = collectTurn(sandboxId, end, events, context, marks.contentWithheld);
    const add = (name: LangfuseScorePayload["name"], value: number, dataType: LangfuseScorePayload["dataType"]) =>
      scores.push({ id: hash(`${f.traceId}:${name}`, 32), traceId: f.traceId, name, value, dataType });
    add("turn_success", end.status === "finished" ? 1 : 0, "BOOLEAN");
    if (f.toolCount > 0) add("tool_error_rate", Number((f.toolErrorCount / f.toolCount).toFixed(4)), "NUMERIC");
    if (f.ttftMs !== undefined) add("ttft_ms", f.ttftMs, "NUMERIC");
    add("pr_linked", f.resolved.prUrl || f.resolved.prNumber ? 1 : 0, "BOOLEAN");
  }
  return scores;
}
