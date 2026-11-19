import type { AgentEvent, Sql, TurnTokenUsage } from "@armada/core";

export function completedUsageTurns(events: readonly AgentEvent[]) {
  const completed = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "prompt" || !event.promptId) continue;
    if (event.status !== "finished" && event.status !== "failed" && event.status !== "interrupted") continue;
    const date = new Date(event.at);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) continue;
    const at = date.toISOString();
    const prior = completed.get(event.promptId);
    if (!prior || at < prior) completed.set(event.promptId, at);
  }
  return completed;
}

export function unmeasuredUsage(promptId: string) {
  return { promptId, model: null, inputTokens: null, outputTokens: null, cachedTokens: null } satisfies TurnTokenUsage;
}

export async function publishAccountSpend(
  tx: Sql,
  sandboxId: string,
  completed: ReadonlyMap<string, string>,
  observations: readonly TurnTokenUsage[],
  priced: readonly TurnTokenUsage[],
  unmeasured: readonly TurnTokenUsage[],
) {
  const shares = new Map<string, TurnTokenUsage[]>();
  for (const promptId of completed.keys()) shares.set(promptId, []);
  for (const { promptId } of observations) shares.set(promptId, []);
  for (const row of priced) shares.get(row.promptId)?.push(row);
  const fallback = new Map(unmeasured.map((row) => [row.promptId, row.pricing]));
  const turns = [];
  for (const [promptId, rows] of shares) {
    const binding = rows.find((row) => row.pricing?.credentialId)?.pricing ?? fallback.get(promptId);
    if (binding?.billing === "subscription") continue;
    const accountId = binding?.billing === "per_token" ? binding.credentialId : null;
    let usd = 0n;
    let unpriced = rows.length === 0;
    for (const { pricing } of rows) {
      if (!pricing || pricing.credentialId !== accountId || pricing.billing !== "per_token" || pricing.usd === null) {
        unpriced = true;
        continue;
      }
      const [whole, fraction = ""] = pricing.usd.split(".");
      usd += BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    }
    turns.push({
      prompt_id: promptId,
      completed_at: completed.get(promptId) ?? null,
      account_id: accountId,
      usd: `${usd / 10n ** 18n}.${(usd % 10n ** 18n).toString().padStart(18, "0")}`,
      unpriced,
    });
  }
  if (turns.length) {
    await tx.query("select public.publish_account_spend($1::uuid, $2::text::jsonb)", [
      sandboxId,
      JSON.stringify(turns),
    ]);
  }
}
