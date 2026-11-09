import { HARNESSES } from "@armada/core";
import { RocketIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreatedAt } from "@/components/created-at";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listGoldenHistory } from "@/lib/data/goldens";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { listSandboxes } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import { type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { filtersToSearch, PAGE_SIZE, parseSandboxFilters, SANDBOX_STATUSES } from "@/lib/sandbox-filters";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sandboxes" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SandboxesPage({ searchParams }: Props) {
  const viewer = await requireViewer();
  const filters = parseSandboxFilters(await searchParams);
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [{ rows, total }, goldens, directory, setup] = await Promise.all([
    listSandboxes(supabase, filters, viewer.id),
    // Removed goldens included: a retained sandbox keeps naming (and filtering by) the golden it started from.
    listGoldenHistory(supabase),
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
  const goldenName = new Map(
    goldens.map((golden) => [golden.id, golden.removed_at ? `${golden.name} (removed)` : golden.name]),
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const now = new Date();
  const filtered = Boolean(filters.status || filters.harness || filters.golden || filters.owner);
  // An organization without a sandbox provider goes to Settings to connect one; one with sandboxes to manage stays here.
  const setupPending = selected !== null && setup?.state === "pending";
  if (setupPending && !filtered && total === 0) redirect(PROVIDER_SETTINGS_PATH);

  const launchAction = setupPending ? (
    <Button asChild>
      <Link href={PROVIDER_SETTINGS_PATH}>Connect a provider</Link>
    </Button>
  ) : selected ? (
    <Button asChild>
      <Link href="/goldens">
        <LinkPendingIcon>
          <RocketIcon />
        </LinkPendingIcon>
        Launch a sandbox
      </Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Sandboxes">{launchAction}</PageHeader>

      <form
        key={filtersToSearch(filters)}
        method="get"
        className="grid grid-cols-2 gap-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
        aria-label="Filters"
      >
        <NativeSelect name="status" defaultValue={filters.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {SANDBOX_STATUSES.map((status) => (
            <option key={status} value={status}>
              {capitalize(status)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="harness" defaultValue={filters.harness ?? ""} aria-label="Harness">
          <option value="">Any harness</option>
          {HARNESSES.map((harness) => (
            <option key={harness} value={harness}>
              {HARNESS_LABELS[harness]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="golden" defaultValue={filters.golden ?? ""} aria-label="Golden">
          <option value="">Any golden</option>
          {goldens.map((golden) => (
            <option key={golden.id} value={golden.id}>
              {goldenName.get(golden.id)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="owner" defaultValue={filters.owner ?? ""} aria-label="Owner">
          <option value="">Any owner</option>
          <option value="me">Me</option>
          {[...directory]
            .filter(([id]) => id !== viewer.id)
            .map(([id, email]) => (
              <option key={id} value={id}>
                {email}
              </option>
            ))}
        </NativeSelect>
        <div className="col-span-2 flex gap-2 lg:col-span-1">
          <Button type="submit" variant="secondary">
            Filter
          </Button>
          {filtered && (
            <Button variant="ghost" asChild>
              <Link href="/sandboxes">Clear</Link>
            </Button>
          )}
        </div>
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <Empty title="No sandbox matches these filters">Try clearing a filter.</Empty>
        ) : (
          <Empty title="No sandboxes yet" action={launchAction}>
            A sandbox starts from a golden. Pick one on the Goldens page, or run{" "}
            <code className="font-mono text-xs">armada launch &lt;golden&gt;</code> or launch from an orchestrator over
            MCP.
          </Empty>
        )
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Sandbox</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Golden</TableHead>
                <TableHead className="hidden md:table-cell">Harness</TableHead>
                <TableHead className="hidden md:table-cell">Owner</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((sandbox) => (
                <TableRow key={sandbox.id}>
                  <TableCell className="max-w-0 min-w-40 sm:max-w-none">
                    <Link
                      href={`/sandboxes/${sandbox.id}`}
                      className="inline-flex max-w-full items-center gap-1.5 font-mono text-sm font-medium underline-offset-4 hover:underline"
                    >
                      <span className="truncate">{sandbox.provider_sandbox_id}</span>
                      <LinkPendingIcon />
                    </Link>
                    <p className="truncate text-xs text-muted-foreground sm:hidden">
                      {goldenName.get(sandbox.golden_id) ?? "Unknown golden"}, {HARNESS_LABELS[sandbox.harness]}
                    </p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={sandbox.status} />
                    <LifecycleHint view={lifecycleView(sandbox.status, readLifecycle(sandbox), now)} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {goldenName.get(sandbox.golden_id) ?? "Unknown"}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{HARNESS_LABELS[sandbox.harness]}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {displayUser(directory, sandbox.owner_id, viewer.id)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    <CreatedAt iso={sandbox.created_at} now={now.getTime()} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
