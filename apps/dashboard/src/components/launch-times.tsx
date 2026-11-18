import { formatLaunchDuration } from "@armada/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProviderLaunchTimes } from "@/lib/data/launch-times";
import { DOCKER_HOSTS_LABEL } from "@/lib/labels";

const PROVIDER_LABELS: Record<string, string> = { boat: "Boat", modal: "Modal", docker: DOCKER_HOSTS_LABEL };

const KIND_LABELS = { launch: "Launch", resume: "Resume" } as const;

/** #2560: accepted-to-ready p50/p90 per provider, launches and resumes apart, over the last 30 days. */
export function LaunchTimes({ rows }: { rows: ProviderLaunchTimes | null }) {
  if (!rows?.length) return null;
  return (
    <section className="space-y-2" aria-labelledby="launch-times" data-launch-times>
      <h2 id="launch-times" className="text-sm font-medium">
        Launch time
      </h2>
      <p className="text-xs text-muted-foreground">
        From the accepted request to the sandbox being ready for a prompt, for recent launches and resumes in the last
        30 days of sandboxes you can open.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Count</TableHead>
            <TableHead className="text-right">p50</TableHead>
            <TableHead className="text-right">p90</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.provider}:${row.kind}`}>
              <TableCell>{PROVIDER_LABELS[row.provider] ?? row.provider}</TableCell>
              <TableCell>{KIND_LABELS[row.kind]}</TableCell>
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
