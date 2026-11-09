import { MODEL_CATALOG } from "@armada/core";
import type { Metadata } from "next";
import Link from "next/link";
import { CreatedAt } from "@/components/created-at";
import { LinkPendingIcon } from "@/components/link-pending";
import { OrchestratorStateBadge } from "@/components/orchestrator-badge";
import { CreateOrchestrator } from "@/components/orchestrator-create";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderName } from "@/components/provider-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listGoldens } from "@/lib/data/goldens";
import { listModelAccounts, readFailure, viewerOrchestrators } from "@/lib/data/orchestrators";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import type { OrchestratorApi } from "@/lib/orchestrator-api";
import { type OrchestratorListView, timeUntil } from "@/lib/orchestrators";
import { goldenRepositoryDirs } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Orchestrators" };
export const dynamic = "force-dynamic";

const DESCRIPTION = "Your lasting coordinators. Each keeps one conversation and launches workers for you.";

/**
 * The viewer's own orchestrators in the selected organization, newest activity first, as the Armada server lists
 * them. Orchestrators are private: nobody else's appear, an org admin's included. Create is offered only once the
 * server answers the list, so a server without orchestrators never shows a form it would refuse.
 */
export default async function OrchestratorsPage() {
  const viewer = await requireViewer();
  const selected = await selectedOrganization();
  if (!selected)
    return (
      <>
        <PageHeader title="Orchestrators" description={DESCRIPTION} />
        <Empty title="No organization selected">Choose or create an organization first.</Empty>
      </>
    );
  const api = viewerOrchestrators(viewer);
  let list: OrchestratorListView | null = null;
  let problem: ReturnType<typeof readFailure> | null = null;
  if (!api) problem = { failure: "unavailable", message: "The Armada server is not configured for this dashboard." };
  else {
    // The server says whether it admits orchestrators at all; a list or a form is shown only when it does.
    const capabilities = await api.capabilities().catch((error: unknown) => readFailure(error));
    if ("enabled" in capabilities && !capabilities.enabled)
      problem = { failure: "unavailable", message: capabilities.message };
    else if ("failure" in capabilities) problem = capabilities;
    else
      try {
        list = await readAll(api, selected.org.id);
      } catch (error) {
        problem = readFailure(error);
      }
  }

  const [goldens, accounts] = list
    ? await Promise.all([listGoldens(await createClient()), listModelAccounts(viewer, selected.org.id)])
    : [[], null];
  const creatable = goldens
    .filter((golden) => golden.provider_snapshot_id)
    .map((golden) => ({
      id: golden.id,
      name: golden.name,
      provider: golden.provider,
      repositories: goldenRepositoryDirs(golden.config),
    }));
  const create =
    list && accounts && creatable.length > 0 ? (
      <CreateOrchestrator orgId={selected.org.id} goldens={creatable} accounts={accounts} catalog={MODEL_CATALOG} />
    ) : null;
  const items = [...(list?.items ?? [])].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const now = Date.now();

  return (
    <>
      <PageHeader title="Orchestrators" description={DESCRIPTION}>
        {create}
      </PageHeader>

      {problem && (
        <Empty
          title={problem.failure === "unavailable" ? "Not available here yet" : "Orchestrators could not be loaded"}
        >
          {problem.message}
        </Empty>
      )}

      {list && list.unreadable > 0 && (
        <Alert>
          <AlertDescription>
            {list.unreadable === 1 ? "One orchestrator" : `${list.unreadable} orchestrators`} could not be read by this
            dashboard. Reload after an update.
          </AlertDescription>
        </Alert>
      )}

      {list && items.length === 0 && (
        <Empty title="No orchestrators yet">
          {creatable.length === 0 ? (
            <>
              An orchestrator runs from a snapshotted golden.{" "}
              <Link href="/goldens" className="font-medium underline underline-offset-4">
                Build one
              </Link>
            </>
          ) : (
            "Create one to coordinate workers from a single conversation."
          )}
        </Empty>
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden sm:table-cell">Agent</TableHead>
                <TableHead className="hidden md:table-cell">Provider</TableHead>
                <TableHead className="hidden lg:table-cell">Last activity</TableHead>
                <TableHead className="hidden xl:table-cell">Idle stop</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} data-orchestrator={item.id}>
                  <TableCell className="max-w-0 min-w-40 sm:max-w-none">
                    <Link
                      href={`/orchestrators/${encodeURIComponent(item.id)}`}
                      className="inline-flex max-w-full items-center gap-1.5 font-medium underline-offset-4 hover:underline"
                    >
                      <span className="truncate">{item.configuration.name}</span>
                      <LinkPendingIcon />
                    </Link>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground md:hidden">
                      <ProviderName provider={item.configuration.provider} className="shrink-0 gap-1" />
                      {/* From sm up the Agent column shows these. */}
                      <span className="truncate sm:hidden">
                        <span aria-hidden="true">·</span> {HARNESS_LABELS[item.configuration.harness]} ·{" "}
                        {item.configuration.model}
                      </span>
                    </p>
                  </TableCell>
                  <TableCell>
                    <OrchestratorStateBadge state={item.state} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span>{HARNESS_LABELS[item.configuration.harness]}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{item.configuration.model}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <ProviderName provider={item.configuration.provider} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    <CreatedAt iso={item.lastActivityAt} now={now} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground xl:table-cell">
                    {(item.state === "ready" && item.idleDeadline && timeUntil(item.idleDeadline, now)) || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

/** Pages to read before showing the list: a hundred orchestrators each, far more than one person keeps. */
const MAX_PAGES = 10;

/** Every page of the viewer's list, following the server's cursor; never a silently truncated first page. */
async function readAll(api: OrchestratorApi, orgId: string): Promise<OrchestratorListView> {
  const all: OrchestratorListView = { items: [], cursor: null, unreadable: 0 };
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await api.list(orgId, cursor);
    all.items.push(...read.items);
    all.unreadable += read.unreadable;
    if (!read.cursor || read.cursor === cursor) return all;
    cursor = read.cursor;
  }
  return { ...all, cursor };
}
