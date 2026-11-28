type ContentMode = "metadata" | "full";
export type LangfuseTest = "ok" | "rejected" | "unreachable";

type Status = { enabled: boolean; contentMode: ContentMode };
export type LangfuseAdmin = Status & {
  scope: "admin";
  configured: boolean;
  host: string;
  publicKey: string | null;
  counters: { exported: number; failed: number; dropped: number };
  lastExportAt: string | null;
};
export type LangfuseSettings = LangfuseAdmin | (Status & { scope: "member" });

export type LangfuseInput = {
  host?: string;
  publicKey?: string;
  secretKey?: string;
  contentMode?: ContentMode;
  enabled?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("Invalid count");
  return value;
}

export function parseLangfuseSettings(input: unknown, admin: boolean): LangfuseSettings {
  const { enabled, contentMode, configured, host, publicKey, counters, lastExportAt } = record(input);
  if (typeof enabled !== "boolean" || (contentMode !== "metadata" && contentMode !== "full")) {
    throw new Error("Invalid Langfuse status");
  }
  if (!admin) return { scope: "member", enabled, contentMode };
  if (
    typeof configured !== "boolean" ||
    typeof host !== "string" ||
    (publicKey !== null && typeof publicKey !== "string") ||
    (lastExportAt !== null && (typeof lastExportAt !== "string" || !Number.isFinite(Date.parse(lastExportAt))))
  ) {
    throw new Error("Invalid Langfuse settings");
  }
  const { exported, failed, dropped } = record(counters);
  return {
    scope: "admin",
    enabled,
    contentMode,
    configured,
    host,
    publicKey,
    counters: { exported: count(exported), failed: count(failed), dropped: count(dropped) },
    lastExportAt,
  };
}

export function parseLangfuseTest(input: unknown): LangfuseTest {
  const { status } = record(input);
  if (status === "ok" || status === "rejected" || status === "unreachable") return status;
  throw new Error("Invalid Langfuse test result");
}

export type LangfuseEditable = Pick<LangfuseAdmin, "host" | "publicKey" | "contentMode">;

export const LANGFUSE_MISSING_FIELDS_ERROR = "Enter the host and keys from your Langfuse project settings.";
export const LANGFUSE_HOST_CHANGE_ERROR =
  "Changing the Langfuse host requires replacing the Secret key. Click Replace and enter the secret key for the new host.";

export type LangfuseFormResult = { ok: true; input: LangfuseInput } | { ok: false; error: string };

export function readLangfuseForm(form: FormData, baseline?: LangfuseEditable): LangfuseFormResult {
  const host = form.get("host");
  const publicKey = form.get("publicKey");
  const secretKey = form.get("secretKey");
  const contentMode = form.get("contentMode");
  if (
    typeof host !== "string" ||
    !host.trim() ||
    typeof publicKey !== "string" ||
    !publicKey.trim() ||
    (secretKey !== null && (typeof secretKey !== "string" || !secretKey.trim())) ||
    (contentMode !== "metadata" && contentMode !== "full")
  )
    return { ok: false, error: LANGFUSE_MISSING_FIELDS_ERROR };
  const hostValue = host.trim();
  const url = URL.canParse(hostValue) ? new URL(hostValue) : null;
  const origin = url && url.href === `${url.origin}/` ? url.origin : hostValue;
  const hostChanged = origin !== baseline?.host;
  // The API binds stored secrets to their origin. A host move always needs an explicit replacement.
  if (baseline && hostChanged && secretKey === null) return { ok: false, error: LANGFUSE_HOST_CHANGE_ERROR };
  return {
    ok: true,
    input: {
      ...(hostChanged ? { host: hostValue } : {}),
      ...(hostChanged || publicKey.trim() !== baseline?.publicKey ? { publicKey: publicKey.trim() } : {}),
      ...(secretKey === null ? {} : { secretKey: secretKey.trim() }),
      ...(contentMode === baseline?.contentMode ? {} : { contentMode }),
    },
  };
}

type OptN = number | null;
export type LangfuseTokenPricesPerMillion = { input: number; output: number } & Record<
  "cacheRead" | "cacheWrite" | "reasoning",
  OptN
>;
export type LangfuseModelRecord = Record<"id" | "modelName" | "matchPattern", string> & {
  unit: string | null;
  isLangfuseManaged: boolean;
  pricesPerMillion: LangfuseTokenPricesPerMillion;
};
export type LangfuseArmadaModelStatus = Record<"id" | "label" | "defaultModelName" | "defaultMatchPattern", string> & {
  providerGroup: "antigravity" | "morph";
  sampleModelNames: string[];
  status: "matched_builtin" | "matched_custom" | "unmatched";
  matchedModel: LangfuseModelRecord | null;
  suggestedPricesPerMillion:
    | (LangfuseTokenPricesPerMillion & { source: "langfuse" | "catalog"; sourceModel: string | null })
    | null;
};
export type LangfuseModelsSummary = { armadaModels: LangfuseArmadaModelStatus[]; customModels: LangfuseModelRecord[] };
export type LangfuseModelsSyncResult = LangfuseModelsSummary & Record<"created" | "skipped" | "failed", string[]>;
export type LangfuseModelOverrideInput = {
  modelName: string;
  matchPattern: string;
  replaceModelId?: string | null;
  pricesPerMillion: Partial<LangfuseTokenPricesPerMillion> & { input: number; output: number };
};

const PRICE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const usd = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const bad = (k: string): never => {
  throw new Error(`Invalid ${k}`);
};
const obj = (v: unknown, k: string) =>
  typeof v === "object" && v && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(k);
const str = (v: unknown, k: string) => (typeof v === "string" && v.trim() ? v : bad(k));
const optStr = (v: unknown, k: string) => (v === null || typeof v === "string" ? v : bad(k));
const list = (v: unknown, k: string) =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : bad(k);
const num = (v: unknown, k: string) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : bad(k));
const optNum = (v: unknown, k: string) => (v === null ? null : num(v, k));
const one = <T extends string>(v: unknown, xs: readonly T[], k: string) => (xs.includes(v as T) ? (v as T) : bad(k));

const parsePrices = (v: unknown) => {
  const r = obj(v, "prices");
  const [input, output, cacheRead] = [num(r.input, "input"), num(r.output, "output"), optNum(r.cacheRead, "cr")];
  const [cacheWrite, reasoning] = [optNum(r.cacheWrite, "cw"), optNum(r.reasoning, "rs")];
  return { input, output, cacheRead, cacheWrite, reasoning } satisfies LangfuseTokenPricesPerMillion;
};
const parseModel = (v: unknown) => {
  const r = obj(v, "model");
  const isLangfuseManaged = typeof r.isLangfuseManaged === "boolean" ? r.isLangfuseManaged : bad("managed");
  const [id, modelName] = [str(r.id, "id"), str(r.modelName, "name")];
  const [matchPattern, unit] = [str(r.matchPattern, "pat"), optStr(r.unit, "unit")];
  const pricesPerMillion = parsePrices(r.pricesPerMillion);
  return { id, modelName, matchPattern, unit, isLangfuseManaged, pricesPerMillion } satisfies LangfuseModelRecord;
};
const parseArmada = (v: unknown) => {
  const r = obj(v, "armada");
  const s = r.suggestedPricesPerMillion === null ? null : obj(r.suggestedPricesPerMillion, "suggested");
  const src = s ? one(s.source, ["langfuse", "catalog"], "source") : null;
  const suggestedPricesPerMillion =
    s && src ? { ...parsePrices(s), source: src, sourceModel: optStr(s.sourceModel, "src") } : null;
  const [id, label] = [str(r.id, "id"), str(r.label, "label")];
  const [defaultModelName, defaultMatchPattern] = [str(r.defaultModelName, "name"), str(r.defaultMatchPattern, "pat")];
  const providerGroup = one(r.providerGroup, ["antigravity", "morph"], "providerGroup");
  const status = one(r.status, ["matched_builtin", "matched_custom", "unmatched"], "status");
  const sampleModelNames = list(r.sampleModelNames, "samples");
  const matchedModel = r.matchedModel === null ? null : parseModel(r.matchedModel);
  const base = { id, label, providerGroup, sampleModelNames, defaultModelName, defaultMatchPattern };
  return { ...base, status, matchedModel, suggestedPricesPerMillion } satisfies LangfuseArmadaModelStatus;
};

export function parseLangfuseModelsSummary(input: unknown) {
  const r = obj(input, "summary");
  if (!Array.isArray(r.armadaModels) || !Array.isArray(r.customModels)) throw new Error("Invalid summary");
  const [armadaModels, customModels] = [r.armadaModels.map(parseArmada), r.customModels.map(parseModel)];
  return { armadaModels, customModels } satisfies LangfuseModelsSummary;
}
export function parseLangfuseModelsSyncResult(input: unknown) {
  const r = obj(input, "sync");
  const [created, skipped, failed] = [list(r.created, "created"), list(r.skipped, "skipped"), list(r.failed, "failed")];
  return { ...parseLangfuseModelsSummary(r), created, skipped, failed } satisfies LangfuseModelsSyncResult;
}
export function parseLangfuseModelSaveResult(input: unknown) {
  const r = obj(input, "save");
  return { ...parseLangfuseModelsSummary(r), model: parseModel(r.model) };
}
export function readLangfuseModelOverrideForm(form: FormData) {
  const get = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)).trim() : "");
  const [modelName, matchPattern] = [get("modelName"), get("matchPattern")];
  if (!modelName) return { ok: false as const, error: "Enter a model name." };
  const stripped = matchPattern.replace(/^\(\?i\)/, "");
  if (!stripped) return { ok: false as const, error: "Enter a regular expression match pattern." };
  try {
    new RegExp(stripped);
  } catch {
    return { ok: false as const, error: "Match pattern must be a valid regex." };
  }
  const vals: Record<string, OptN> = {};
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
    const raw = form.get(k);
    if (raw !== null && typeof raw !== "string") return { ok: false as const, error: `Invalid ${k} price.` };
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) {
      if (k === "input" || k === "output") return { ok: false as const, error: `Enter a valid ${k} price.` };
      vals[k] = null;
      continue;
    }
    const n = PRICE_RE.test(s) ? Number(s) : Number.NaN;
    if (!Number.isFinite(n) || n < 0) return { ok: false as const, error: `${k} price must be >= 0.` };
    vals[k] = n;
  }
  const replaceModelId = get("replaceModelId");
  const { input, output, cacheRead = null, cacheWrite = null, reasoning = null } = vals;
  if (typeof input !== "number" || typeof output !== "number") return { ok: false as const, error: "Invalid price." };
  const base = { modelName, matchPattern, pricesPerMillion: { input, output, cacheRead, cacheWrite, reasoning } };
  const out = { ...base, ...(replaceModelId ? { replaceModelId } : {}) } satisfies LangfuseModelOverrideInput;
  return { ok: true as const, input: out };
}
export const formatUsdPerMillion = (v: OptN) => (v === null ? "—" : `$${usd.format(v)}`);
