import { MODEL_PRICES_AS_OF, type SandboxCost } from "@armada/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration } from "@/lib/lifecycle";
import { costFigure, costTitle, formatTokens, formatUsd } from "@/lib/sandbox-cost";

/**
 * What a sandbox's reported tokens would cost at list prices: the total, its tokens, turns and compute time, and the
 * per-turn breakdown on demand. Never what was paid: a subscription's figure is API-equivalent, an API key's estimated.
 */
export function SandboxCostCard({ cost }: { cost: SandboxCost }) {
  const figure = costFigure(cost);
  const facts: [string, string][] = [
    ["Input", formatTokens(cost.tokens.input)],
    ["Cached input", formatTokens(cost.tokens.cached)],
    ["Output", formatTokens(cost.tokens.output)],
    ["Turns", String(cost.turnCount)],
    ["Compute time", cost.computeSeconds === null ? "Not recorded" : formatDuration(cost.computeSeconds)],
    ["Model", cost.models.length > 0 ? cost.models.join(", ") : "Not reported"],
  ];
  return (
    <Card className="gap-3 py-5" data-sandbox-cost={figure.kind}>
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Cost</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {figure.kind === "none" ? (
          <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
        ) : (
          <>
            <div>
              <p className="text-xs text-muted-foreground">{cost.label}</p>
              <p
                className={
                  figure.kind === "priced"
                    ? "text-2xl font-semibold tracking-tight tabular-nums"
                    : "text-base font-medium text-muted-foreground"
                }
                title={costTitle(cost)}
              >
                {figure.text}
              </p>
              {figure.kind === "priced" && figure.partial && (
                <p className="text-xs text-warning">
                  Leaves out {cost.unpricedTurns} turn{cost.unpricedTurns === 1 ? "" : "s"} without a known price.
                </p>
              )}
            </div>
            <dl className="divide-y divide-border/70 text-[13px]">
              {facts.map(([label, value]) => (
                <div
                  key={label}
                  className="flex min-w-0 items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
                >
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 text-right break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <details className="group text-[13px]">
              <summary className="cursor-pointer font-medium">Per turn</summary>
              <TurnTable cost={cost} />
            </details>
            <p className="text-xs text-muted-foreground">
              List prices of {MODEL_PRICES_AS_OF}, short-prompt rates. Armada does not record cache writes, so they are
              not counted.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TurnTable({ cost }: { cost: SandboxCost }) {
  // A turn is a prompt: its rows (one per model) share its number.
  const numbers = new Map<string, number>();
  for (const turn of cost.turns) if (!numbers.has(turn.promptId)) numbers.set(turn.promptId, numbers.size + 1);
  const several = cost.models.length > 1 || cost.turns.some((turn) => turn.model === null);
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs tabular-nums" aria-label="Cost per turn">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-2 text-left font-normal">
              Turn
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-normal">
              In
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-normal">
              Cached
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-normal">
              Out
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {cost.turns.map((turn) => (
            <tr key={`${turn.promptId}:${turn.model ?? ""}`}>
              <td className="py-1 pr-2">
                {numbers.get(turn.promptId)}
                {/* A turn can call more than one model (Claude Code's background model): each row names its own. */}
                {several && (
                  <span className="block max-w-28 truncate text-muted-foreground" title={turn.model ?? undefined}>
                    {turn.model ?? "Model not reported"}
                  </span>
                )}
              </td>
              <td className="py-1 pr-2 text-right">{tokens(turn.inputTokens)}</td>
              <td className="py-1 pr-2 text-right">{tokens(turn.cachedTokens)}</td>
              <td className="py-1 pr-2 text-right">{tokens(turn.outputTokens)}</td>
              <td className="py-1 text-right">
                {turn.usd !== null ? (
                  formatUsd(turn.usd)
                ) : (
                  <span className="text-muted-foreground">
                    {turn.unknown === "price" ? "Price unknown" : "Not reported"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tokens(value: number | null): string {
  return value === null ? "–" : formatTokens(value);
}
