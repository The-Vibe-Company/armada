import { HARNESSES } from "@armada/core";
import type { Metadata } from "next";
import Link from "next/link";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listGoldens } from "@/lib/data/goldens";
import { listSandboxes } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
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
  const [{ rows, total }, goldens, directory] = await Promise.all([
    listSandboxes(supabase, filters, viewer.id),
    listGoldens(supabase),
    listMemberships(supabase, viewer.id)
      .then((items) => items.filter((item) => item.org.id === selected?.org.id))
      .then((memberships) =>
        memberDirectory(
          supabase,
          memberships.map((item) => item.org.id),
        ),
      ),
  ]);
  const goldenName = new Map(goldens.map((golden) => [golden.id, golden.name]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(filters.status || filters.harness || filters.golden || filters.owner);

  return (
    <>
      <PageHeader title="Sandboxes" description="Agents running on boat.dev, from the goldens you can see." />

      <form
        key={filtersToSearch(filters)}
        method="get"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,1fr)_auto]"
        aria-label="Filters"
      >
        <NativeSelect name="status" defaultValue={filters.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {SANDBOX_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="harness" defaultValue={filters.harness ?? ""} aria-label="Harness">
          <option value="">Any harness</option>
          {HARNESSES.map((harness) => (
            <option key={harness} value={harness}>
              {harness}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="golden" defaultValue={filters.golden ?? ""} aria-label="Golden">
          <option value="">Any golden</option>
          {goldens.map((golden) => (
            <option key={golden.id} value={golden.id}>
              {golden.name}
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
        <div className="flex gap-2">
          <Button type="submit">Filter</Button>
          {filtered && (
            <Button variant="ghost" asChild>
              <Link href="/sandboxes">Clear</Link>
            </Button>
          )}
        </div>
      </form>

      {rows.length === 0 ? (
        <Empty title={filtered ? "No sandbox matches these filters" : "No sandboxes yet"}>
          {filtered
            ? "Try clearing a filter."
            : "Launch one with `armada launch <golden>` or from an orchestrator over MCP."}
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sandbox</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Golden</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((sandbox) => (
                <TableRow key={sandbox.id}>
                  <TableCell>
                    <Link
                      href={`/sandboxes/${sandbox.id}`}
                      className="inline-flex items-center gap-1.5 font-mono text-sm underline-offset-4 hover:underline"
                    >
                      {sandbox.boat_id}
                      <LinkPendingIcon />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={sandbox.status} />
                  </TableCell>
                  <TableCell>{goldenName.get(sandbox.golden_id) ?? "Unknown"}</TableCell>
                  <TableCell>{sandbox.harness}</TableCell>
                  <TableCell>{displayUser(directory, sandbox.owner_id, viewer.id)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={sandbox.created_at}>{formatDate(sandbox.created_at)}</time>
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
            Page {filters.page} of {pages} · {total} sandboxes
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

function formatDate(iso: string): string {
  return `${new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
