import {
  type ConnectionPresetId,
  connectionPreset,
  isRecord,
  MODEL_CATALOG,
  MORPH_MODEL_IDS,
  presetModels,
} from "@armada/core";

export type LangfuseConfig = { host: string; publicKey: string; secretKey: string };
export type LangfuseTokenPricesPerMillion = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
};
export type LangfuseModelRecord = {
  id: string;
  modelName: string;
  matchPattern: string;
  unit: string | null;
  isLangfuseManaged: boolean;
  pricesPerMillion: LangfuseTokenPricesPerMillion;
};
export type LangfuseArmadaModelStatus = {
  id: string;
  label: string;
  providerGroup: "antigravity" | "morph";
  sampleModelNames: string[];
  defaultModelName: string;
  defaultMatchPattern: string;
  status: "matched_builtin" | "matched_custom" | "unmatched";
  matchedModel: LangfuseModelRecord | null;
  suggestedPricesPerMillion:
    | (LangfuseTokenPricesPerMillion & { source: "langfuse" | "catalog"; sourceModel: string | null })
    | null;
};
export type LangfuseModelOverrideInput = {
  modelName: string;
  matchPattern: string;
  pricesPerMillion: Partial<LangfuseTokenPricesPerMillion> & { input: number; output: number };
  replaceModelId?: string | null | undefined;
};
export type LangfuseModelsSummary = { armadaModels: LangfuseArmadaModelStatus[]; customModels: LangfuseModelRecord[] };
export type LangfuseModelsErrorCode = "rejected" | "unreachable" | "invalid_input";
export class LangfuseModelsError extends Error {
  readonly code: LangfuseModelsErrorCode;
  constructor(code: LangfuseModelsErrorCode, message: string) {
    super(message);
    this.name = "LangfuseModelsError";
    this.code = code;
  }
}

type CatRef = [ConnectionPresetId, string];
type Spec = {
  id: string;
  label: string;
  group: "antigravity" | "morph";
  samples: readonly string[];
  pattern: string;
  refs: readonly string[];
  cat: CatRef | null;
};

const MODELS_PATH = "/api/public/models";
const [TIMEOUT_MS, MAX_PAGES, PAGE_LIMIT, MAX_PRICE] = [5000, 10, 100, 100_000] as const;
const DSV41 = ["morph-dsv41flash", "morph-dsv41flash-1017"] as const;
const MORPH: Record<string, [string, string, readonly string[], CatRef]> = {
  "morph-dsv41flash": [
    "Morph DeepSeek V4.1 Flash",
    "(?i)^(armada/)?morph-dsv41flash(-1017)?$",
    ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-chat", "deepseek/deepseek-v4.1-flash"],
    ["deepseek", "deepseek-flash"],
  ],
  "morph-kimik31": [
    "Morph Kimi K3.1",
    "(?i)^(armada/)?morph-kimik31$",
    ["kimi-k3.1-pro", "kimi-k3.1", "moonshotai/kimi-k3.1-pro"],
    ["openrouter", "moonshotai/kimi-k3.1-pro"],
  ],
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hostOf = (c: LangfuseConfig) => c.host.replace(/\/+$/, "");
const authOf = (c: LangfuseConfig) => `Basic ${Buffer.from(`${c.publicKey}:${c.secretKey}`).toString("base64")}`;
const toMillion = (v: number) => Number((v * 1_000_000).toPrecision(12));
const toToken = (v: number) => Number((v / 1_000_000).toPrecision(12));
const fail = (code: LangfuseModelsErrorCode, msg: string) => new LangfuseModelsError(code, msg);
const nonNeg = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  const n = typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function compilePattern(pattern: string) {
  const ci = pattern.startsWith("(?i)");
  const src = ci ? pattern.slice(4) : pattern;
  if (!src) return null;
  try {
    return new RegExp(src, ci ? "i" : "");
  } catch {
    return null;
  }
}
export const matchesLangfusePattern = (pattern: string, modelName: string) =>
  compilePattern(pattern)?.test(modelName) ?? false;

function buildSpecs(morphIds: readonly string[] = MORPH_MODEL_IDS) {
  const specs: Spec[] = MODEL_CATALOG.antigravity.models
    .filter((m) => m.id !== "default")
    .map(({ id, label }) => {
      const n = id === "gemini-4-neon";
      const refs = n
        ? ["gemini-4-neon", "google/gemini-4-neon", "gemini-4-argon", "gemini-4-carbon"]
        : [id, `google/${id}`];
      const cat: CatRef = ["openrouter", n ? "google/gemini-4-argon" : `google/${id}`];
      return { id, label, group: "antigravity", samples: [id], pattern: `(?i)^${esc(id)}$`, refs, cat };
    });
  const seen = new Set<string>();
  for (const id of morphIds) {
    if (seen.has(id)) continue;
    const dsv = id === "morph-dsv41flash" || id === "morph-dsv41flash-1017";
    const key = dsv ? "morph-dsv41flash" : id;
    for (const v of dsv ? DSV41 : [id]) seen.add(v);
    const samples = (dsv ? DSV41.filter((v) => morphIds.includes(v)) : [id]).flatMap((v) => [v, `armada/${v}`]);
    const meta = Object.hasOwn(MORPH, key) ? MORPH[key] : undefined;
    const [label = id, pattern = `(?i)^(armada/)?${esc(id)}$`, refs = [], cat = null] = meta ?? [];
    specs.push({ id: key, label, group: "morph", samples, pattern, refs, cat });
  }
  return specs;
}
const SPECS: readonly Spec[] = buildSpecs();

export const findMatchingLangfuseModel = (modelName: string, models: readonly LangfuseModelRecord[]) =>
  models.find((m) => !m.isLangfuseManaged && matchesLangfusePattern(m.matchPattern, modelName)) ??
  models.find((m) => m.isLangfuseManaged && matchesLangfusePattern(m.matchPattern, modelName)) ??
  null;

export function resolveReferencePrices(spec: Pick<Spec, "refs" | "cat">, models: readonly LangfuseModelRecord[]) {
  const builtIns = models.filter(
    (m) => m.isLangfuseManaged && (m.pricesPerMillion.input > 0 || m.pricesPerMillion.output > 0),
  );
  for (const c of spec.refs) {
    const low = c.toLowerCase();
    const ref =
      builtIns.find((m) => m.modelName.toLowerCase() === low) ??
      builtIns.find((m) => matchesLangfusePattern(m.matchPattern, c));
    if (!ref) continue;
    const p = ref.pricesPerMillion;
    const cw = p.cacheWrite ?? p.input;
    const rs = p.reasoning ?? p.output;
    return { ...p, cacheWrite: cw, reasoning: rs, source: "langfuse" as const, sourceModel: ref.modelName };
  }
  const preset = spec.cat ? connectionPreset(spec.cat[0]) : null;
  const e = preset && spec.cat ? presetModels(preset).find((m) => m.id === spec.cat![1]) : undefined;
  const [input, output] = e ? [nonNeg(e.input), nonNeg(e.output)] : [null, null];
  if (!e || input === null || output === null) return null;
  const cacheRead = nonNeg(e.cacheRead);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: input,
    reasoning: output,
    source: "catalog" as const,
    sourceModel: e.id,
  };
}
function parseRecord(raw: unknown) {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const modelName = typeof raw.modelName === "string" ? raw.modelName.trim() : "";
  if (!id || !modelName) return null;
  const tiers = Array.isArray(raw.pricingTiers) ? raw.pricingTiers.filter(isRecord) : [];
  const tier = tiers.find((t) => t.isDefault === true) ?? tiers.find((t) => t.priority === 0) ?? tiers[0];
  const tp = tier && isRecord(tier.prices) ? tier.prices : null;
  const fp = isRecord(raw.prices) ? raw.prices : null;
  const pick = (k: string, leg?: "inputPrice" | "outputPrice") => {
    const v = nonNeg(tp?.[k]) ?? nonNeg(fp?.[k]) ?? (leg ? nonNeg(raw[leg]) : null);
    return v === null ? null : toMillion(v);
  };
  const pricesPerMillion = {
    input: pick("input", "inputPrice") ?? 0,
    output: pick("output", "outputPrice") ?? 0,
    cacheRead: pick("cache_read_input_tokens"),
    cacheWrite: pick("cache_creation_input_tokens"),
    reasoning: pick("reasoning"),
  };
  const matchPattern = typeof raw.matchPattern === "string" ? raw.matchPattern : "";
  const unit = typeof raw.unit === "string" ? raw.unit : null;
  const isLangfuseManaged = Boolean(raw.isLangfuseManaged);
  return { id, modelName, matchPattern, unit, isLangfuseManaged, pricesPerMillion } satisfies LangfuseModelRecord;
}
async function sendReq(
  send: typeof fetch,
  url: string,
  cfg: LangfuseConfig,
  method: string,
  sig?: AbortSignal,
  body?: string,
) {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  const headers: Record<string, string> = { authorization: authOf(cfg) };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    const signal = sig ? AbortSignal.any([sig, t]) : t;
    res = await send(url, { method, redirect: "error", signal, headers, ...(body !== undefined ? { body } : {}) });
  } catch {
    throw fail("unreachable", "Langfuse request failed");
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => {});
  throw res.status === 401 || res.status === 403
    ? fail("rejected", "Langfuse rejected credentials")
    : fail("unreachable", `Langfuse HTTP ${res.status}`);
}
function isLastPage(page: number, count: number, meta: Record<string, unknown> | null) {
  if (!count) return true;
  if (typeof meta?.totalPages === "number" && Number.isFinite(meta.totalPages)) return page >= meta.totalPages;
  if (typeof meta?.totalItems === "number" && Number.isFinite(meta.totalItems))
    return page * PAGE_LIMIT >= meta.totalItems;
  return count < PAGE_LIMIT;
}
export async function fetchLangfuseModels(send: typeof fetch, cfg: LangfuseConfig, sig?: AbortSignal) {
  const byId = new Map<string, LangfuseModelRecord>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await sendReq(send, `${hostOf(cfg)}${MODELS_PATH}?limit=${PAGE_LIMIT}&page=${page}`, cfg, "GET", sig);
    const data = await res.json().catch(() => null);
    if (!isRecord(data) || !Array.isArray(data.data)) throw fail("unreachable", "Invalid Langfuse models response");
    for (const item of data.data) {
      const r = parseRecord(item);
      if (r) byId.set(r.id, r);
    }
    if (isLastPage(page, data.data.length, isRecord(data.meta) ? data.meta : null)) break;
  }
  return [...byId.values()];
}
export function summarizeLangfuseModels(models: readonly LangfuseModelRecord[], morphIds?: readonly string[]) {
  const specs = morphIds === undefined ? SPECS : buildSpecs(morphIds);
  const armadaModels: LangfuseArmadaModelStatus[] = specs.map((spec) => {
    const hits = spec.samples.map((s) => findMatchingLangfuseModel(s, models));
    const all = hits.length > 0 && hits.every((m): m is LangfuseModelRecord => m !== null);
    const custom = all ? hits.find((m) => !m.isLangfuseManaged) : undefined;
    let status: LangfuseArmadaModelStatus["status"] = "unmatched";
    if (all) status = custom ? "matched_custom" : "matched_builtin";
    return {
      id: spec.id,
      label: spec.label,
      providerGroup: spec.group,
      sampleModelNames: [...spec.samples],
      defaultModelName: `armada:${spec.id}`,
      defaultMatchPattern: spec.pattern,
      status,
      matchedModel: all ? (custom ?? hits[0] ?? null) : null,
      suggestedPricesPerMillion: resolveReferencePrices(spec, models),
    };
  });
  return { armadaModels, customModels: models.filter((m) => !m.isLangfuseManaged) } satisfies LangfuseModelsSummary;
}
function checkPrice(v: unknown, field: string, opt: boolean) {
  if (opt && (v === undefined || v === null)) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE)
    throw fail("invalid_input", `Invalid ${field}`);
  return v;
}
export async function upsertLangfuseModel(
  send: typeof fetch,
  cfg: LangfuseConfig,
  input: LangfuseModelOverrideInput,
  sig?: AbortSignal,
) {
  if (!isRecord(input) || !isRecord(input.pricesPerMillion)) throw fail("invalid_input", "Invalid input");
  const modelName = typeof input.modelName === "string" ? input.modelName.trim() : "";
  const matchPattern = typeof input.matchPattern === "string" ? input.matchPattern.trim() : "";
  if (!modelName || modelName.length > 120) throw fail("invalid_input", "Invalid modelName");
  if (!matchPattern || matchPattern.length > 300 || !compilePattern(matchPattern))
    throw fail("invalid_input", "Invalid matchPattern");
  const rep = input.replaceModelId;
  const replaceId = typeof rep === "string" ? rep.trim() || null : null;
  const badRep = (rep !== undefined && rep !== null && typeof rep !== "string") || (replaceId?.length ?? 0) > 200;
  if (badRep) throw fail("invalid_input", "Invalid replaceModelId");
  const p = input.pricesPerMillion;
  const prices: Record<string, number> = {
    input: toToken(checkPrice(p.input, "input", false)!),
    output: toToken(checkPrice(p.output, "output", false)!),
  };
  const opt = [
    ["cache_read_input_tokens", p.cacheRead, "cacheRead"],
    ["cache_creation_input_tokens", p.cacheWrite, "cacheWrite"],
    ["reasoning", p.reasoning, "reasoning"],
  ] as const;
  for (const [k, raw, f] of opt) {
    const v = checkPrice(raw, f, true);
    if (v !== null) prices[k] = toToken(v);
  }
  const tier = { name: "Standard", isDefault: true, priority: 0, conditions: [], prices };
  const body = JSON.stringify({ modelName, matchPattern, unit: "TOKENS", pricingTiers: [tier] });
  const res = await sendReq(send, `${hostOf(cfg)}${MODELS_PATH}`, cfg, "POST", sig, body);
  const created = parseRecord(await res.json().catch(() => null));
  if (!created) throw fail("unreachable", "Invalid Langfuse model response");
  if (replaceId && replaceId !== created.id) await deleteLangfuseModel(send, cfg, replaceId, sig).catch(() => {});
  return created;
}
export async function deleteLangfuseModel(send: typeof fetch, cfg: LangfuseConfig, modelId: string, sig?: AbortSignal) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id || id.length > 200) throw fail("invalid_input", "Invalid modelId");
  const url = `${hostOf(cfg)}${MODELS_PATH}/${encodeURIComponent(id)}`;
  await (await sendReq(send, url, cfg, "DELETE", sig)).body?.cancel().catch(() => {});
}
const matchesTarget = (id: string, samples: readonly string[], pattern: string, cand: string) => {
  const s = cand.trim();
  const low = s.toLowerCase();
  if (!s) return false;
  return id.toLowerCase() === low || samples.some((n) => n.toLowerCase() === low) || matchesLangfusePattern(pattern, s);
};
export const isKnownLangfuseArmadaModel = (modelName: string) =>
  SPECS.some((s) => matchesTarget(s.id, s.samples, s.pattern, modelName));
export async function syncMissingLangfuseModels(
  send: typeof fetch,
  cfg: LangfuseConfig,
  sig?: AbortSignal,
  opts?: { onlyModels?: readonly string[] | undefined },
) {
  const models = await fetchLangfuseModels(send, cfg, sig);
  const { armadaModels } = summarizeLangfuseModels(models);
  const only = opts?.onlyModels;
  const targets = only
    ? armadaModels.filter((e) => only.some((n) => matchesTarget(e.id, e.sampleModelNames, e.defaultMatchPattern, n)))
    : armadaModels;
  const updated = [...models];
  const [created, skipped, failed]: [string[], string[], string[]] = [[], [], []];
  for (const e of targets) {
    const low = e.defaultModelName.toLowerCase();
    const hasCustom = updated.some((m) => !m.isLangfuseManaged && m.modelName.toLowerCase() === low);
    if (e.status !== "unmatched" || hasCustom || !e.suggestedPricesPerMillion) {
      skipped.push(e.id);
      continue;
    }
    if (sig?.aborted) {
      failed.push(e.id);
      continue;
    }
    try {
      const inp = {
        modelName: e.defaultModelName,
        matchPattern: e.defaultMatchPattern,
        pricesPerMillion: e.suggestedPricesPerMillion,
      };
      updated.push(await upsertLangfuseModel(send, cfg, inp, sig));
      created.push(e.id);
    } catch {
      failed.push(e.id);
    }
  }
  return { created, skipped, failed, summary: summarizeLangfuseModels(updated) };
}
