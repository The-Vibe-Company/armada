import { formatLaunchDuration } from "@armada/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProviderLaunchTimes } from "@/lib/data/launch-times";

const PROVIDER_LABELS: Record<string, string> = { boat: "Boat", modal: "Modal", docker: "Your servers" };

/** #2560: launch-to-ready p50/p90 per provider over the last 30 days; nothing before a launch is measured. */
export function LaunchTimes({ rows }: { rows: ProviderLaunchTimes | null }) {
  if (!rows?.length) return null;
  return (
    <section className="space-y-2" aria-labelledby="launch-times" data-launch-times>
      <h2 id="launch-times" className="text-sm font-medium">
        Launch time
      </h2>
      <p className="text-xs text-muted-foreground">
        From sandbox creation to harness ready, for recent launches in the last 30 days of sandboxes you can open. Only
        launches through the Armada runtime are measured.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead className="text-right">Launches</TableHead>
            <TableHead className="text-right">p50</TableHead>
            <TableHead className="text-right">p90</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.provider}>
              <TableCell>{PROVIDER_LABELS[row.provider] ?? row.provider}</TableCell>
              <TableCell className="text-right tabular-nums">{row.count}</TableCell>
              <TableCell className="text-right tabular-nums">{formatLaunchDuration(row.p50Ms)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatLaunchDuration(row.p90Ms)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
