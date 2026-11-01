import { formatTokens, projectUsageSchema, todayUsage, usageSummary } from "@armada/protocol/usage";

/** The room is loaded on navigation; older or malformed usage readings show no pill. */
export default function UsagePill({ usage: raw, now }: { usage: unknown; now: number }) {
  const parsed = projectUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const at = new Date(now).toISOString();
  const used = usage ? todayUsage(usage, at)?.coordinator : undefined;
  const total =
    used && [used.input, used.output, used.cacheRead, used.cacheWrite].some((v) => v !== null)
      ? (used.input ?? 0) + (used.output ?? 0) + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0)
      : null;
  const summary = usageSummary(usage, at);
  return (
    <span
      role="status"
      data-usage="today"
      title={summary}
      aria-label={summary}
      className="inline-flex h-6 flex-none items-center gap-1.5 rounded-full bg-fill px-2 font-mono text-meta text-text-2 shadow-ring"
    >
      <span className="@max-[900px]/strip:sr-only">Today</span>
      <span className="@max-[640px]/strip:hidden">
        {formatTokens(used?.input ?? null)} in / {formatTokens(used?.output ?? null)} out
        {used?.unknown ? " + unknown" : ""}
      </span>
      <span className="hidden @max-[640px]/strip:inline">
        {total === null ? "?" : formatTokens(total)}
        {used?.unknown ? "+" : ""}
      </span>
    </span>
  );
}
