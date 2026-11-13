import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ModelUsage = Record<string, number>;
export type ClaudeUsageBaseline = { modelUsage: Record<string, ModelUsage>; totalCostUSD: number };
const tokens = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
const optional = [
  "thinkingTokens",
  "cacheCreationEphemeral5mInputTokens",
  "cacheCreationEphemeral1hInputTokens",
] as const;
const metrics = [...tokens, ...optional, "webSearchRequests", "costUSD"] as const;
const finite = (n: unknown, max = 1e15): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;

/** Pinned CLI cost-state schema, also used by its resume loader (last valid row wins). */
function costState(row: any): ClaudeUsageBaseline | null {
  if (
    !finite(row.totalCostUSD, 1e9) ||
    !row.modelUsage ||
    typeof row.modelUsage !== "object" ||
    Array.isArray(row.modelUsage)
  )
    return null;
  for (const key of [
    "totalAPIDuration",
    "totalAPIDurationWithoutRetries",
    "totalToolDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
    "totalDuration",
    "startTime",
  ])
    if (!finite(row[key])) return null;
  if (row.hasUnknownModelCost !== undefined && typeof row.hasUnknownModelCost !== "boolean") return null;
  const models: Record<string, ModelUsage> = Object.create(null);
  for (const [model, usage] of Object.entries(row.modelUsage)) {
    if (!model || /[\p{Cc}\p{Cf}]/u.test(model) || !usage || typeof usage !== "object") return null;
    const u = usage as Record<string, unknown>;
    if (
      [...tokens, "webSearchRequests", "costUSD"].some((key) => !finite(u[key])) ||
      optional.some((key) => u[key] !== undefined && !finite(u[key]))
    )
      return null;
    models[model] = Object.fromEntries(metrics.filter((k) => u[k] !== undefined).map((k) => [k, u[k] as number]));
  }
  if (tokens.some((key) => Object.values(models).reduce((n, u) => n + (u[key] ?? 0), 0) > 1e15)) return null;
  return { modelUsage: models, totalCostUSD: row.totalCostUSD };
}

/** Read before creating the native query, so the baseline is exactly what resume restores.
 * Bounded, local-only lookup; never copy transcript text into events or error messages.
 */
export function claudeResumeUsage(
  session: string,
  env: Record<string, string>,
  cwd: string,
): ClaudeUsageBaseline | null {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session)) return null;
  try {
    const root = join(resolve(cwd, env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude")), "projects");
    const dirs = readdirSync(root, { withFileTypes: true });
    if (dirs.length > 1024) return null;
    const found: string[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const path = join(root, dir.name, `${session}.jsonl`);
      try {
        if (lstatSync(path).isFile()) found.push(path);
      } catch {
        /* No session in this project. */
      }
    }
    if (found.length !== 1) return null;
    const path = found[0]!;
    const stat = lstatSync(path);
    if (stat.size > 32 * 1024 * 1024) return null;
    const raw = readFileSync(path, "utf8");
    let baseline: ClaudeUsageBaseline | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // Native fBo ignores malformed rows and strips leading NUL padding.
      try {
        const row = JSON.parse(line.replace(/^\0+/, ""));
        if (row?.type === "cost-state" && row.sessionId === session) baseline = costState(row) ?? baseline;
      } catch {
        /* Same tolerant row parser as the pinned native loader. */
      }
    }
    return baseline;
  } catch {
    return null;
  }
}

export function claudeUsageDelta(
  current: Record<string, Record<string, unknown>>,
  cost: number,
  baseline: ClaudeUsageBaseline,
) {
  if (
    !finite(cost) ||
    cost < baseline.totalCostUSD ||
    Object.keys(baseline.modelUsage).some((model) => !Object.hasOwn(current, model))
  )
    return null;
  const models: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [model, usage] of Object.entries(current)) {
    const prior = baseline.modelUsage[model];
    const delta = { ...usage };
    for (const key of metrics) {
      if (usage[key] === undefined && prior?.[key] === undefined) continue;
      const value = usage[key],
        before = prior ? (prior[key] ?? (optional.some((k) => k === key) ? 0 : undefined)) : 0;
      if (!finite(value) || !finite(before) || value < before) return null;
      delta[key] = value - before;
    }
    models[model] = delta;
  }
  return { modelUsage: models, total_cost_usd: cost - baseline.totalCostUSD };
}
