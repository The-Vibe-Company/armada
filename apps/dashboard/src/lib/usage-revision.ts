import { createHash } from "node:crypto";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Server-only refresh identity for persisted turn observations. Ignore live elapsed
 * compute time and derived totals: they must not trigger a page refresh every poll.
 * Normalize PostgREST rows and status projections to the same ordering/null semantics. */
export function usageRevision(value: unknown): string {
  const usage = record(value);
  const turns = (Array.isArray(usage?.turns) ? usage.turns : []).flatMap((raw) => {
    const turn = record(raw);
    if (!turn || typeof turn.promptId !== "string") return [];
    return [
      [
        turn.promptId,
        typeof turn.model === "string" ? turn.model : null,
        ...["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"].map((key) =>
          count(turn[key]),
        ),
      ],
    ];
  });
  const observations = turns.map((turn) => JSON.stringify(turn)).sort();
  return createHash("sha256")
    .update(JSON.stringify([count(usage?.turnCount), observations]))
    .digest("hex");
}
