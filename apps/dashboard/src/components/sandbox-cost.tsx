import { MODEL_PRICES_AS_OF, type SandboxCost } from "@armada/core";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDuration } from "@/lib/lifecycle";
import { costFigure, costTitle, formatTokens, formatUsd } from "@/lib/sandbox-cost";
import { cn } from "@/lib/utils";

/**
 * What a sandbox's reported tokens would cost at list prices: the total, its tokens, turns and compute time, and the
 * per-turn breakdown on demand. Never what was paid: a subscription's figure is API-equivalent, an API key's estimated.
 */
export function SandboxCostCard({ cost }: { cost: SandboxCost }) {
  const figure = costFigure(cost);
  const facts: [string, string][] = [
    ["Input", formatTokens(cost.tokens.input)],
    ["Cached input", formatTokens(cost.tokens.cached)],
    ["Cache writes", formatTokens(cost.tokens.cacheWrite)],
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
                  {cost.unpricedTurns > 0
                    ? `Leaves out ${cost.unpricedTurns} turn${cost.unpricedTurns === 1 ? "" : "s"} without complete token reporting or a known price.`
                    : "Usage coverage is incomplete; this is only the reported subtotal."}
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
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="group h-auto justify-start gap-1 p-0 text-[13px]">
                  <ChevronRightIcon aria-hidden className="size-3 group-data-[state=open]:rotate-90" />
                  Per turn
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent forceMount className="pt-2 data-[state=closed]:hidden">
                <TurnTable cost={cost} />
              </CollapsibleContent>
            </Collapsible>
            <p className="text-xs text-muted-foreground">
              List prices of {MODEL_PRICES_AS_OF}, short-prompt rates. Cache writes use the listed 5-minute Claude or
              30-minute OpenAI rate; actual billing may differ.
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
    <Table className="w-full text-xs tabular-nums" aria-label="Cost per turn">
      <TableHeader className="[&_tr]:border-0">
        <TableRow className="border-0 hover:bg-transparent">
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 pr-2 text-left font-normal">
            Turn
          </TableHead>
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 pr-2 text-right font-normal">
            In
          </TableHead>
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 pr-2 text-right font-normal">
            Cached
          </TableHead>
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 pr-2 text-right font-normal">
            Writes
          </TableHead>
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 pr-2 text-right font-normal">
            Out
          </TableHead>
          <TableHead scope="col" className="h-auto px-0 whitespace-normal py-1 text-right font-normal">
            Cost
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/70">
        {cost.turns.map((turn) => (
          <TableRow className="border-0 hover:bg-transparent" key={`${turn.promptId}:${turn.model ?? ""}`}>
            <TableCell className="px-0 whitespace-normal py-1 pr-2">
              {numbers.get(turn.promptId)}
              {/* A turn can call more than one model (Claude Code's background model): each row names its own. */}
              {several && (
                <span className="block max-w-28 truncate text-muted-foreground" title={turn.model ?? undefined}>
                  {turn.model ?? "Model not reported"}
                </span>
              )}
            </TableCell>
            <TableCell className="px-0 whitespace-normal py-1 pr-2 text-right">{tokens(turn.inputTokens)}</TableCell>
            <TableCell className="px-0 whitespace-normal py-1 pr-2 text-right">{tokens(turn.cachedTokens)}</TableCell>
            <TableCell className="px-0 whitespace-normal py-1 pr-2 text-right">
              {tokens(turn.cacheWriteTokens)}
            </TableCell>
            <TableCell className="px-0 whitespace-normal py-1 pr-2 text-right">{tokens(turn.outputTokens)}</TableCell>
            <TableCell className="px-0 whitespace-normal py-1 text-right">
              {turn.usd !== null ? (
                formatUsd(turn.usd)
              ) : (
                <span className="text-muted-foreground">
                  {turn.unknown === "price" ? "Price unknown" : "Not reported"}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function tokens(value: number | null): string {
  return formatTokens(value);
}

/**
 * A row's one small cost figure (the sandboxes list, the fleet board): the amount, or the short words for no usage or
 * an unknown price. Its title says whether the amount is an estimate or the API equivalent, and what it leaves out.
 */
export function RowCost({ cost, className }: { cost: SandboxCost; className?: string }) {
  const figure = costFigure(cost);
  if (figure.kind !== "priced")
    return (
      <span
        className={cn("text-xs whitespace-nowrap text-muted-foreground", className)}
        title={figure.text}
        data-row-cost={figure.kind}
      >
        {/* A row stays narrow: the full words are its title, and on the sandbox's page. */}
        {figure.kind === "none" ? "No usage yet" : figure.text}
      </span>
    );
  return (
    <span className={cn("font-medium tabular-nums", className)} title={costTitle(cost)} data-row-cost="priced">
      {figure.partial ? "≥ " : ""}
      {figure.text}
    </span>
  );
}
