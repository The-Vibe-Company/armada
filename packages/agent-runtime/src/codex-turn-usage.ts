/** Native cumulative totals become per-turn deltas; an unknown/regressed baseline stays unknown. */
export function codexTurnUsage(
  total: Record<string, number> | null | undefined,
  baseline: Record<string, number> | null,
): Record<string, unknown> | null {
  if (
    !total ||
    !["inputTokens", "outputTokens", "cachedInputTokens"].every((key) => {
      const value = total[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    })
  )
    return null;
  const delta = (key: string) => {
    const next = total[key];
    const previous = baseline?.[key];
    return typeof next === "number" &&
      typeof previous === "number" &&
      Number.isSafeInteger(next) &&
      Number.isSafeInteger(previous) &&
      next >= previous
      ? next - previous
      : null;
  };
  return {
    inputTokens: delta("inputTokens"),
    outputTokens: delta("outputTokens"),
    cachedTokens: delta("cachedInputTokens"),
    ...(Number.isSafeInteger(total.cacheWriteInputTokens) ? { cacheWriteTokens: delta("cacheWriteInputTokens") } : {}),
    ...(Number.isSafeInteger(total.reasoningOutputTokens) ? { reasoningTokens: delta("reasoningOutputTokens") } : {}),
  };
}
