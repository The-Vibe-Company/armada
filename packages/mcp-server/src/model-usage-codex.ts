import { createHash } from "node:crypto";
import type { ModelUsage, NativeCredits, UsageBucket, Window } from "./model-usage.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Native credit counts are opaque decimal strings, not monetary amounts. No defaults/coercion. */
function credits(value: unknown): NativeCredits | undefined {
  const row = record(value);
  if (
    typeof row.hasCredits !== "boolean" ||
    typeof row.unlimited !== "boolean" ||
    !(
      row.balance === null ||
      (typeof row.balance === "string" && row.balance.length <= 256 && /^[+-]?\d+(?:\.\d+)?$/.test(row.balance))
    )
  )
    return undefined;
  return { hasCredits: row.hasCredits, unlimited: row.unlimited, balance: row.balance };
}
const source = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
const percentage = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function reset(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value * 1000) <= 8.64e15
    ? new Date(value * 1000).toISOString()
    : null;
}
function scopedId(sourceId: string | null, kind: string): string {
  if (!sourceId) return kind;
  return sourceId.length <= 40
    ? sourceId + ":" + kind
    : "bucket-" + createHash("sha256").update(sourceId).digest("hex").slice(0, 16) + ":" + kind;
}

export function codexReading(data: Record<string, unknown>, observedAt: string, sparse: boolean, previous: ModelUsage) {
  const compatibility = record(data.rateLimits);
  const compatibilitySourceId =
    source(compatibility.limitId) ?? (sparse ? (previous.compatibilitySourceId ?? null) : null);
  const map = record(data.rateLimitsByLimitId);
  const entries = Object.entries(map);
  if (entries.length > 64) throw Error("native_quota_bucket_bound_exceeded");
  const buckets = new Map<string | null, UsageBucket>(
    sparse ? (previous.buckets ?? []).map((bucket) => [bucket.sourceId, bucket]) : [],
  );
  let observed = false;
  const normalize = (raw: unknown, sourceId: string | null, before?: UsageBucket): UsageBucket | undefined => {
    const row = record(raw);
    if (!Object.keys(row).length) return;
    if (before?.sourceId !== sourceId) before = undefined;
    const label =
      typeof row.limitName === "string" && row.limitName
        ? row.limitName.slice(0, 120)
        : (before?.label ?? sourceId ?? "Codex");
    const incoming = ["primary", "secondary"].flatMap((kind): Window[] => {
      const window = record(row[kind]);
      if (!Object.keys(window).length) return [];
      observed = true;
      return [
        {
          id: kind,
          label: kind,
          kind,
          sourceId,
          observedAt,
          usedPercent: percentage(window.usedPercent),
          resetsAt: reset(window.resetsAt),
          ...(typeof window.windowDurationMins === "number" &&
          Number.isSafeInteger(window.windowDurationMins) &&
          window.windowDurationMins >= 0
            ? { windowDurationMins: window.windowDurationMins }
            : {}),
        },
      ];
    });
    const merged = new Map<string, Window>(
      sparse ? (before?.windows ?? []).map((window) => [window.kind, window]) : [],
    );
    for (const window of incoming) merged.set(window.kind, window);
    const reported = credits(row.credits);
    if (reported) observed = true;
    const retained = reported ?? (sparse ? before?.credits : undefined);
    return {
      sourceId,
      label,
      windows: [...merged.values()],
      ...(retained
        ? { credits: retained, creditsObservedAt: reported ? observedAt : (before?.creditsObservedAt ?? observedAt) }
        : {}),
    };
  };
  // Compatibility and canonical map priors never cross source identities or overwrite each other.
  let compatibilityView =
    sparse && previous.compatibility?.sourceId === compatibilitySourceId ? previous.compatibility : undefined;
  if (Object.keys(compatibility).length) {
    compatibilityView = normalize(compatibility, compatibilitySourceId, compatibilityView);
    const canonical = normalize(
      compatibility,
      compatibilitySourceId,
      sparse ? buckets.get(compatibilitySourceId) : undefined,
    );
    if (canonical) buckets.set(compatibilitySourceId, canonical);
  }
  for (const [id, row] of entries) {
    if (!source(id)) throw Error("invalid_native_quota_source_id");
    const bucket = normalize(row, id, sparse ? buckets.get(id) : undefined);
    if (bucket) buckets.set(id, bucket);
  }
  if (!observed && sparse) return null;
  const all = [...buckets.values()];
  const compatibilityBucket = buckets.get(compatibilitySourceId);
  const single = !Object.keys(compatibility).length && all.length === 1 ? all[0] : undefined;
  const view = compatibilityView?.credits
    ? compatibilityView
    : compatibilityBucket?.credits
      ? compatibilityBucket
      : single?.credits
        ? single
        : undefined;
  const previousMatches = sparse && previous.creditsSourceId === compatibilitySourceId;
  const reportedCredits = view?.credits ?? (previousMatches ? previous.credits : undefined);
  const creditsSourceId = view ? view.sourceId : previousMatches ? previous.creditsSourceId : undefined;
  const creditsObservedAt = view?.creditsObservedAt ?? (previousMatches ? previous.creditsObservedAt : undefined);
  const flatCompatibility = compatibilityView?.windows.length
    ? compatibilityView
    : compatibilityBucket?.windows.length
      ? compatibilityBucket
      : compatibilityView;
  const flatBuckets = flatCompatibility
    ? [flatCompatibility, ...all.filter((bucket) => bucket.sourceId !== flatCompatibility.sourceId)]
    : all;
  const windows = flatBuckets.flatMap((bucket) =>
    bucket.windows.map((window) => ({
      ...window,
      id: bucket.sourceId === compatibilitySourceId ? window.kind : scopedId(bucket.sourceId, window.kind),
      label: bucket.sourceId === compatibilitySourceId ? window.kind : bucket.label.slice(0, 44) + " · " + window.kind,
    })),
  );
  const available = windows.length > 0 || Boolean(reportedCredits) || all.some((bucket) => bucket.credits);
  return {
    windows,
    buckets: all,
    compatibilitySourceId,
    ...(compatibilityView ? { compatibility: compatibilityView } : {}),
    ...(reportedCredits
      ? {
          credits: reportedCredits,
          ...(creditsSourceId !== undefined ? { creditsSourceId } : {}),
          ...(creditsObservedAt !== undefined ? { creditsObservedAt } : {}),
        }
      : {}),
    ...(!available ? { unavailable: true } : {}),
  };
}
