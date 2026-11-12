import type { AgentEvent } from "./provider.ts";
import type { StoredTurnPricing } from "./turn-pricing.ts";

/** Closed, secret-free explanations for an unmeasured Boat turn. */
export const USAGE_UNAVAILABLE_CODES = [
  "admission_missing",
  "admission_expired",
  "admission_superseded",
  "legacy_disabled",
  "native_start_unobserved",
  "native_input_unmatched",
  "native_turn_unobserved",
  "native_terminal_unobserved",
  "native_history_unavailable",
  "native_boundary_unverified",
  "unsafe_reader_state",
  "reader_unavailable",
  "compute_inactive",
  "unsupported_harness",
] as const;
export type UsageUnavailableCode = (typeof USAGE_UNAVAILABLE_CODES)[number];
export interface UsageUnavailableReason {
  code: UsageUnavailableCode;
  message: string;
}
const USAGE_UNAVAILABLE_MESSAGES: Record<UsageUnavailableCode, string> = {
  admission_missing:
    "No usage admission was bound to this prompt. Check pre-prompt installation/admission; counters are unknown, not zero.",
  admission_expired:
    "Usage admission expired before a matching native start was observed. Waiting for a log flush cannot repair that attribution.",
  admission_superseded:
    "An unclaimed usage admission was superseded. Its counters cannot safely be attributed to this prompt.",
  legacy_disabled:
    "Legacy ambiguous admission state disables attribution until a fresh physical sandbox generation. Do not delete safety state to guess counters.",
  native_start_unobserved:
    "Admission exists, but no matching native start was observed. Check the live process bridge, entrypoint and input matching before rebuilding a golden.",
  native_input_unmatched:
    "The bridge observed native input that did not exactly match the pending admission, or used an unsupported input shape. No counters were guessed.",
  native_turn_unobserved: "The native session was captured, but a native turn ID has not been observed.",
  native_terminal_unobserved:
    "The native turn was identified, but its matching terminal notification has not been observed.",
  native_history_unavailable:
    "Native session history is missing, unreadable, ambiguous or exceeds the bounded read budget.",
  native_boundary_unverified:
    "Native history does not yet prove this turn's identity, closed boundary and baseline. Delayed or unsupported records remain unknown.",
  unsafe_reader_state:
    "The guest usage reader refused unsafe or unreadable local state. Check directory ownership/permissions without removing safety files.",
  reader_unavailable:
    "The guest usage reader could not return a valid bounded observation. No raw guest error, command output or transcript is exposed.",
  compute_inactive:
    "Collection requires active, admitted compute. This read will not resume stopped or fenced compute; earlier observations are retained.",
  unsupported_harness:
    "This Boat harness has no verified native per-turn usage collector. Missing counters are unknown, not zero.",
};
export function usageUnavailableReason(code: UsageUnavailableCode): UsageUnavailableReason {
  return { code, message: USAGE_UNAVAILABLE_MESSAGES[code] };
}

/**
 * Harness-native counters, not disjoint pricing buckets. For Codex, cachedTokens
 * and cacheWriteTokens are subsets of inputTokens; do not add them to input.
 * Claude inputTokens excludes separately reported cache-read/cache-creation
 * tokens. Reasoning tokens are a subset of output when the harness reports them.
 * Cross-harness totals retain these definitions, not a unique-token or price sum.
 */
export interface TurnTokenUsage {
  /** Service-owned quote. Native decoders must not copy this from guest events. */
  pricing?: StoredTurnPricing | null;
  promptId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  /** Native Claude cache-write subsets, not additional input. Absence means TTL detail was not reported.
   * Their sum may be less than cacheWriteTokens (legacy/unclassified writes); never assume the remainder is 5m.
   */
  cacheWriteTokensByTtl?: {
    fiveMinute: number | null;
    oneHour: number | null;
    /** Sticky server-observed contradiction for this prompt/model; replay cannot resolve it. */
    conflicted?: true;
  };
  /** Why no counters could be collected; never a raw provider/guest error. */
  unavailableReason?: UsageUnavailableReason;
}
export interface SandboxUsage {
  /** Seconds between Armada-recorded compute transitions; null for legacy/incomplete history. */
  computeSeconds: number | null;
  turnCount: number | null;
  turns: TurnTokenUsage[];
  tokenTotals?: TokenUsageTotals;
}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Pinned Claude ModelUsage lifetime fields may be partial after an older native CLI session. */
function claudeCacheWriteTtl(usage: Record<string, unknown>): Pick<TurnTokenUsage, "cacheWriteTokensByTtl"> {
  const fiveKey = "cacheCreationEphemeral5mInputTokens",
    hourKey = "cacheCreationEphemeral1hInputTokens";
  if (!Object.hasOwn(usage, fiveKey) && !Object.hasOwn(usage, hourKey)) return {};
  const total = count(usage.cacheCreationInputTokens),
    five = count(usage[fiveKey]),
    hour = count(usage[hourKey]);
  const invalid =
    total === null ||
    (Object.hasOwn(usage, fiveKey) && five === null) ||
    (Object.hasOwn(usage, hourKey) && hour === null) ||
    (five !== null && five > total) ||
    (hour !== null && hour > total) ||
    (five !== null && hour !== null && (!Number.isSafeInteger(five + hour) || five + hour > total));
  return { cacheWriteTokensByTtl: invalid ? { fiveMinute: null, oneHour: null } : { fiveMinute: five, oneHour: hour } };
}

/** Native final snapshots only, never deltas or account quota reports. */
export function reportedTurnUsage(events: readonly AgentEvent[]): { turnCount: number; turns: TurnTokenUsage[] } {
  const prompts = new Set<string>();
  const rows = new Map<string, TurnTokenUsage>();
  for (const event of events) {
    if (!event.promptId) continue;
    if (event.kind === "prompt") prompts.add(event.promptId);
    if (event.kind !== "other") continue;
    const data = object(event.data);
    if (!data) continue;
    if (event.type === "result") {
      const models = object(data.modelUsage);
      if (!models) continue;
      for (const [model, raw] of Object.entries(models)) {
        const usage = object(raw);
        if (!usage) continue;
        rows.set(JSON.stringify([event.promptId, model]), {
          promptId: event.promptId,
          model,
          inputTokens: count(usage.inputTokens),
          outputTokens: count(usage.outputTokens),
          cachedTokens: count(usage.cacheReadInputTokens),
          cacheWriteTokens: count(usage.cacheCreationInputTokens),
          ...claudeCacheWriteTtl(usage),
          reasoningTokens: count(usage.thinkingTokens) ?? count(usage.reasoningTokens),
        });
      }
    } else if (event.type === "armada/turnUsage") {
      const model = typeof data.model === "string" ? data.model : null;
      rows.set(JSON.stringify([event.promptId, model]), {
        promptId: event.promptId,
        model,
        inputTokens: count(data.inputTokens),
        outputTokens: count(data.outputTokens),
        cachedTokens: count(data.cachedTokens),
        cacheWriteTokens: count(data.cacheWriteTokens),
        reasoningTokens: count(data.reasoningTokens),
      });
    }
  }
  return { turnCount: prompts.size, turns: [...rows.values()] };
}

export interface TokenUsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}
export interface SandboxUsageSummary extends TokenUsageTotals {
  computeSeconds: number | null;
  turnCount: number | null;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;

/** A missing turn/field makes that total unknown, not a falsely complete subtotal. */
export function summarizeSandboxUsage(usage: SandboxUsage | null | undefined): SandboxUsageSummary {
  const complete =
    usage?.turnCount !== null &&
    usage?.turnCount !== undefined &&
    new Set(usage.turns.map((turn) => turn.promptId)).size === usage.turnCount;
  const tokens = Object.fromEntries(
    TOKEN_FIELDS.map((key) => {
      const values = usage?.turns.map((turn) => count(turn[key])) ?? [];
      const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
      return [key, complete && values.every((value) => value !== null) && Number.isSafeInteger(sum) ? sum : null];
    }),
  ) as unknown as TokenUsageTotals;
  return { ...tokens, computeSeconds: usage?.computeSeconds ?? null, turnCount: usage?.turnCount ?? null };
}

/** Add totals at read time, including persisted observations predating these fields. */
export function withUsageTotals(usage: SandboxUsage | null | undefined): SandboxUsage | null {
  if (!usage) return null;
  const { computeSeconds: _compute, turnCount: _turns, ...tokenTotals } = summarizeSandboxUsage(usage);
  return { ...usage, tokenTotals };
}

/** Empty child sets cost zero; any unknown component keeps that component unknown. */
export function sumSandboxUsage(usages: readonly (SandboxUsage | null)[]): SandboxUsageSummary {
  const rows = usages.map(summarizeSandboxUsage);
  return Object.fromEntries(
    ([...TOKEN_FIELDS, "computeSeconds", "turnCount"] as const).map((key) => {
      const values = rows.map((row) => row[key]);
      const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
      return [
        key,
        values.every((value) => value !== null) &&
        (key === "computeSeconds" ? Number.isFinite(sum) : Number.isSafeInteger(sum))
          ? sum
          : null,
      ];
    }),
  ) as unknown as SandboxUsageSummary;
}
