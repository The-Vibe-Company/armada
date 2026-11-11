import { HARNESSES, MACHINE_SIZES, SANDBOX_PROVIDERS, type SandboxCost, type SandboxListMetadata } from "@armada/core";
import { BoxesIcon, LockIcon, RocketIcon, SearchXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CreatedAt } from "@/components/created-at";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderName } from "@/components/provider-mark";
import { RowCost } from "@/components/sandbox-cost";
import { SandboxRowMenu } from "@/components/sandbox-row-menu";
import { SandboxToolbar } from "@/components/sandbox-toolbar";
import LoadingSandboxes from "@/components/sandboxes-skeleton";
import { StatusBadge } from "@/components/status-badge";
import { OutcomeBadge, OutcomeDetail } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { listSandboxCosts, listSandboxes } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import { type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { preservationView, settledOutcome } from "@/lib/outcome";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { machineSizeLabel, sandboxName } from "@/lib/sandbox-access";
import { costFigure } from "@/lib/sandbox-cost";
import {
  FACETS,
  type Facet,
  type FacetOption,
  filtersToSearch,
  hasSandboxFilters,
  PAGE_SIZE,
  parseSandboxFilters,
  SANDBOX_STATUSES,
} from "@/lib/sandbox-filters";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sandboxes" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function SandboxesPage(props: Props) {
  return (
    <Suspense fallback={<LoadingSandboxes />}>
      <SandboxesContent {...props} />
    </Suspense>
  );
}

async function SandboxesContent({ searchParams }: Props) {
  const viewer = await requireViewer();
  const filters = parseSandboxFilters(await searchParams);
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [{ rows, total, inventoryTotal, facets }, directory, setup] = await Promise.all([
    listSandboxes(supabase, filters, viewer.id),
    listMemberships(supabase, viewer.id)
      .then((items) => items.filter((item) => item.org.id === selected?.org.id))
      .then((memberships) =>
        memberDirectory(
          supabase,
          memberships.map((item) => item.org.id),
        ),
      ),
    selected ? readProviderSetup(selected.org.id) : null,
  ]);
  const costs = await listSandboxCosts(supabase, rows);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const now = new Date();
  const filtered = hasSandboxFilters(filters);
  // An organization without a sandbox provider goes to Settings to connect one; one with sandboxes to manage stays here.
  const setupPending = selected !== null && setup?.state === "pending";
  if (setupPending && !filtered && inventoryTotal === 0) redirect(PROVIDER_SETTINGS_PATH);

  const launchAction = setupPending ? (
    <Button asChild>
      <Link href={PROVIDER_SETTINGS_PATH}>Connect a provider</Link>
    </Button>
  ) : selected ? (
    <Button asChild>
      <Link href="/environments">
        <LinkPendingIcon>
          <RocketIcon />
        </LinkPendingIcon>
        Launch a sandbox
      </Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Sandboxes" meta={total > 0 ? countLabel(total, filtered) : undefined}>
        {launchAction}
      </PageHeader>

      <SandboxToolbar
        filters={filters}
        options={
          Object.fromEntries(
            FACETS.map((key) => {
              const known =
                key === "status"
                  ? SANDBOX_STATUSES
                  : key === "provider"
                    ? SANDBOX_PROVIDERS
                    : key === "harness"
                      ? HARNESSES
                      : key === "size"
                        ? [...MACHINE_SIZES, "unknown"]
                        : [];
              const values = [...new Set([...known, ...facets[key].keys(), ...filters[key]])];
              const label = (value: string) =>
                key === "owner"
                  ? displayUser(directory, value === "me" ? viewer.id : value, viewer.id)
                  : key === "harness"
                    ? HARNESS_LABELS[value as keyof typeof HARNESS_LABELS]
                    : key === "size"
                      ? value === "unknown"
                        ? "Not recorded"
                        : machineSizeLabel(value as (typeof MACHINE_SIZES)[number])
                      : key === "model"
                        ? value === "unknown"
                          ? "Not recorded"
                          : value
                        : capitalize(value);
              const options = values
                .filter(
                  (value) =>
                    key !== "owner" || (value !== "me" && (value !== viewer.id || filters.owner.includes(viewer.id))),
                )
                .map((value) => ({ value, label: label(value), count: facets[key].get(value) ?? 0 }));
              if (key === "owner")
                options.unshift({ value: "me", label: "Mine", count: facets.owner.get(viewer.id) ?? 0 });
              return [key, options];
            }),
          ) as Record<Facet, FacetOption[]>
        }
      />

      {rows.length === 0 ? (
        total > 0 ? (
          <Empty title="This page is past the last one" icon={<SearchXIcon />}>
            <Link href={`/sandboxes${filtersToSearch({ ...filters, page: 1 })}`} className="underline">
              Go to the first page
            </Link>
          </Empty>
        ) : filtered ? (
          <Empty
            title="No sandbox matches these filters"
            icon={<SearchXIcon />}
            action={
              <Button variant="outline" asChild>
                <Link href="/sandboxes">Clear filters</Link>
              </Button>
            }
          >
            Try a different search or remove a filter to see more sandboxes.
          </Empty>
        ) : (
          <Empty title="No sandboxes yet" action={launchAction} icon={<BoxesIcon />}>
            A sandbox starts from a golden. Pick one on the Environments page, or run{" "}
            <code className="font-mono text-xs">armada launch &lt;golden&gt;</code> or launch through MCP.
          </Empty>
        )
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <Table className="max-sm:block max-sm:whitespace-normal">
            <TableHeader className="max-sm:hidden">
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead>Sandbox</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Provider</TableHead>
                <TableHead className="hidden md:table-cell">Harness</TableHead>
                <TableHead className="hidden md:table-cell">Size</TableHead>
                <TableHead className="hidden md:table-cell">Owner</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Cost</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-sm:block">
              {rows.map((sandbox) => (
                <TableRow
                  key={sandbox.id}
                  className="relative max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-3 max-sm:p-4"
                >
                  <TableCell className="w-full min-w-0 max-sm:col-span-2 max-sm:block max-sm:p-0 sm:max-w-0 sm:min-w-40">
                    <SandboxName sandbox={sandbox} />
                    <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground sm:hidden">
                      <ProviderName provider={sandbox.provider} className="shrink-0 gap-1" />
                      <span className="break-words">
                        <span aria-hidden="true">·</span> {HARNESS_LABELS[sandbox.harness]}
                        {sandbox.machineSize && `, ${machineSizeLabel(sandbox.machineSize)}`}
                      </span>
                    </p>
                    {sandbox.model && <p className="mt-1 break-all text-xs text-muted-foreground">{sandbox.model}</p>}
                    <PhoneCost cost={costs.get(sandbox.id)} />
                  </TableCell>
                  <TableCell className="max-sm:block max-sm:p-0">
                    <StatusBadge status={sandbox.status} />
                    <LifecycleHint view={lifecycleView(sandbox.status, readLifecycle(sandbox), now)} />
                    <OutcomeHint sandbox={sandbox} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <ProviderName provider={sandbox.provider} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{HARNESS_LABELS[sandbox.harness]}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {sandbox.machineSize ? (
                      machineSizeLabel(sandbox.machineSize)
                    ) : (
                      <span className="text-muted-foreground">Not recorded</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {displayUser(directory, sandbox.ownerId, viewer.id)}
                  </TableCell>
                  {/* Above the row's link, so the exact time stays reachable by pointer and keyboard. */}
                  <TableCell className="relative z-10 hidden text-muted-foreground lg:table-cell">
                    <CreatedAt iso={sandbox.createdAt} now={now.getTime()} />
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <CostCell cost={costs.get(sandbox.id)} />
                  </TableCell>
                  <TableCell className="relative z-10 max-sm:col-start-2 max-sm:row-start-2 max-sm:p-0">
                    <SandboxRowMenu id={sandbox.id} name={sandboxName(sandbox)} canOpen={sandbox.canOpen} />
                  </TableCell>
                  <TableCell className="relative z-10 col-span-2 block p-0 text-xs text-muted-foreground sm:hidden">
                    {displayUser(directory, sandbox.ownerId, viewer.id)} · Created{" "}
                    <CreatedAt iso={sandbox.createdAt} now={now.getTime()} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Past the last page the empty state above already leads back; a pager there would count beyond the end. */}
      {pages > 1 && filters.page <= pages && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {filters.page} of {pages}, {total} sandboxes
          </span>
          <div className="flex gap-2">
            {filters.page > 1 && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/sandboxes${filtersToSearch({ ...filters, page: filters.page - 1 })}`}>Previous</Link>
              </Button>
            )}
            {filters.page < pages && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/sandboxes${filtersToSearch({ ...filters, page: filters.page + 1 })}`}>Next</Link>
              </Button>
            )}
          </div>
        </nav>
      )}
    </>
  );
}

/**
 * The sandbox's listed name. Its owner and the organization's admins open it; any other member sees the same metadata
 * without a link into its conversation, files or connections (#680). The server enforces that again on every read.
 */
function SandboxName({ sandbox }: { sandbox: SandboxListMetadata }) {
  if (sandbox.canOpen)
    return (
      <Link
        href={`/sandboxes/${sandbox.id}`}
        // The link covers its whole row (the row is the target), and its focus ring is drawn around the row.
        className="inline-flex max-w-full items-center gap-1.5 font-mono text-[13px] font-medium underline-offset-4 outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        <span className="break-all whitespace-normal sm:truncate" title={sandboxName(sandbox)}>
          {sandboxName(sandbox)}
        </span>
        <LinkPendingIcon />
      </Link>
    );
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 font-mono text-sm text-muted-foreground"
      data-restricted
    >
      <span className="break-all whitespace-normal sm:truncate" title={sandboxName(sandbox)}>
        {sandboxName(sandbox)}
      </span>
      <LockIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Only its owner and organization admins can open it</span>
    </span>
  );
}

/**
 * The row's cost figure. Usage is interior: a sandbox the viewer may not open has none to show, as on the server's list.
 * The title says whether the figure is an estimate or the API equivalent of a subscription's tokens.
 */
function CostCell({ cost }: { cost: SandboxCost | undefined }) {
  if (!cost)
    return (
      <span className="text-muted-foreground" title="Only its owner and organization admins see its usage">
        <span aria-hidden="true">–</span>
        <span className="sr-only">Usage not visible</span>
      </span>
    );
  return <RowCost cost={cost} />;
}

/** On a phone the cost column is folded under the name, with the same words. */
function PhoneCost({ cost }: { cost: SandboxCost | undefined }) {
  if (!cost) return null;
  const figure = costFigure(cost);
  return (
    <p className="text-xs text-muted-foreground tabular-nums sm:hidden" data-phone-cost={figure.kind}>
      {figure.kind === "priced" ? `${cost.label}: ${figure.partial ? "≥ " : ""}${figure.text}` : figure.text}
    </p>
  );
}

/** Under the status, quietly: the time left, or that the deadline passed or a stop is being retried. */
function LifecycleHint({ view }: { view: LifecycleView }) {
  if (view.notice)
    return (
      <p className="mt-1 text-xs text-warning" data-lifecycle={view.notice.kind}>
        {view.notice.kind === "retrying" ? "Stop retrying" : "Past deadline"}
      </p>
    );
  if (view.remaining)
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-lifecycle="remaining">
        {view.remaining}
      </p>
    );
  return null;
}

/**
 * Under the status: what the agent reported for its latest finished turn (owner and admins only; the metadata hides it
 * from other members), and a stopped sandbox's work-preservation receipt. The recovery command is on its page.
 */
function OutcomeHint({ sandbox }: { sandbox: SandboxListMetadata }) {
  const outcome = settledOutcome(sandbox.status, sandbox.taskOutcome);
  const preservation = preservationView(sandbox.preservationNote, sandbox.status, sandbox.id, sandbox.canOpen);
  if (!outcome && !preservation) return null;
  return (
    <div className="mt-1 max-w-56 space-y-1 whitespace-normal" data-list-outcome={outcome?.kind}>
      {outcome && <OutcomeBadge outcome={outcome} />}
      {outcome && <OutcomeDetail outcome={outcome} className="line-clamp-2 text-xs" />}
      {preservation && (
        <p
          data-preservation={preservation.kind}
          className={preservation.kind === "failed" ? "text-xs text-warning" : "text-xs text-muted-foreground"}
        >
          {preservation.text}
        </p>
      )}
    </div>
  );
}

/** "3 sandboxes", or with filters "1 sandbox matches" / "3 sandboxes match". */
function countLabel(total: number, filtered: boolean): string {
  const noun = total === 1 ? "sandbox" : "sandboxes";
  return filtered ? `${total} ${noun} ${total === 1 ? "matches" : "match"}` : `${total} ${noun}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
