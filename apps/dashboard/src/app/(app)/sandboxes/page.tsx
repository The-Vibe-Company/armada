import {
  HARNESSES,
  idlePauseMessage,
  MACHINE_SIZES,
  SANDBOX_PLACEMENT_PROVIDERS,
  type SandboxCost,
  type SandboxPlacementProviderId,
} from "@armada/core";
import { BoxesIcon, InfoIcon, LockIcon, SearchXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderMark } from "@/components/provider-mark";
import { PullRequestList } from "@/components/pull-requests";
import { RowCost } from "@/components/sandbox-cost";
import { SandboxLaunchAction } from "@/components/sandbox-launch-action";
import { SandboxActivityTabs, SandboxListTabs, sandboxRowGrid } from "@/components/sandbox-list-tabs";
import { SandboxRowMenu } from "@/components/sandbox-row-menu";
import { SandboxState } from "@/components/sandbox-state";
import { SandboxToolbar } from "@/components/sandbox-toolbar";
import LoadingSandboxes from "@/components/sandboxes-skeleton";
import { OutcomeBadge, OutcomeDetail } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createControlClient } from "@/lib/control";
import { readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { listSandboxMetadata, loadSandboxInventory } from "@/lib/data/sandbox-inventory";
import { listSandboxEnrichment } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { hasDockerHost } from "@/lib/docker-snapshots";
import { mcpUrl } from "@/lib/env";
import { DOCKER_HOST_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { preservationView, settledOutcome } from "@/lib/outcome";
import { CLOUD_PROVIDERS_PATH } from "@/lib/provider-setup";
import { machineSizeLabel, type SandboxListMetadata, skippedRowsNote } from "@/lib/sandbox-access";
import {
  FACETS,
  type Facet,
  type FacetOption,
  filtersToSearch,
  hasSandboxFilters,
  parseSandboxFilters,
  SANDBOX_STATUSES,
} from "@/lib/sandbox-filters";
import { sandboxListName } from "@/lib/sandbox-list-name";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Sandboxes" };
export const dynamic = "force-dynamic";
// Match Snapshots: launch actions wait for the same server timeout.
export const maxDuration = 800;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function SandboxesPage(props: Props) {
  return (
    <Suspense fallback={<LoadingSandboxes />}>
      <SandboxesContent {...props} />
    </Suspense>
  );
}

async function SandboxesContent({ searchParams }: Props) {
  const [viewer, query, supabase, selected] = await Promise.all([
    requireViewer(),
    searchParams,
    createClient(),
    selectedOrganization(),
  ]);
  const filters = parseSandboxFilters(query);
  if (!selected)
    return (
      <>
        <PageHeader title="Sandboxes" />
        <Empty
          title="No organization yet"
          icon={<BoxesIcon />}
          action={
            <Button asChild>
              <Link href="/orgs">Choose an organization</Link>
            </Button>
          }
        >
          Create or join an organization before launching or following a sandbox.
        </Empty>
      </>
    );
  const serverUrl = mcpUrl();
  const control = serverUrl && viewer.token ? createControlClient({ serverUrl, token: viewer.token }) : null;
  const inventory = loadSandboxInventory(
    supabase,
    selected.org.id,
    filters,
    viewer.id,
    query.activity,
    control,
    listSandboxMetadata(selected.org.id),
  );
  const hosts = readSelectedDockerHosts();
  const enrichmentRead = inventory.then(({ rows }) => listSandboxEnrichment(supabase, selected.org.id, rows));
  const [
    { rows, total, inventoryTotal, skipped, facets, activity, counts, page, workingIds, waitingIds, now },
    directory,
    setup,
    hostRead,
    enrichment,
  ] = await Promise.all([
    inventory,
    listMemberships(supabase, viewer.id)
      .then((items) => items.filter((item) => item.org.id === selected?.org.id))
      .then((memberships) =>
        memberDirectory(
          supabase,
          memberships.map((item) => item.org.id),
        ),
      ),
    selected ? readProviderSetup(selected.org.id) : null,
    hosts,
    enrichmentRead,
  ]);

  const hostNames = new Map(hostRead.state === "ready" ? hostRead.list.hosts.map((host) => [host.id, host.name]) : []);
  const filtered = hasSandboxFilters(filters);
  // An organization without a sandbox provider goes to the Cloud providers page to connect one; one with sandboxes to manage stays here.
  const hasDocker = hostRead.state === "ready" && hasDockerHost(hostRead.list.hosts);
  const setupPending = selected !== null && setup?.state === "pending" && !hasDocker;
  if (setupPending && !filtered && inventoryTotal === 0 && counts.deleted === 0 && skipped === 0)
    redirect(CLOUD_PROVIDERS_PATH);

  const launchAction = setupPending ? (
    <Button asChild>
      <Link href={CLOUD_PROVIDERS_PATH}>Connect a provider</Link>
    </Button>
  ) : selected ? (
    <div data-page-launch>
      <SandboxLaunchAction key={selected.org.id} />
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="Sandboxes"
        meta={
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            {total > 0 ? countLabel(total, filtered) : "0 sandboxes"}
          </span>
        }
      >
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
                    ? SANDBOX_PLACEMENT_PROVIDERS
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
                      : key === "provider"
                        ? ({ boat: "Boat cloud", modal: "Modal cloud", docker: DOCKER_HOST_LABEL }[
                            value as SandboxPlacementProviderId
                          ] ?? capitalize(value))
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
      >
        <SandboxActivityTabs counts={counts} tab={activity} search={filtersToSearch(filters)} />
      </SandboxToolbar>

      {skipped > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {skippedRowsNote(skipped)}
        </p>
      )}

      {total === 0 && activity !== "deleted" ? (
        skipped > 0 ? (
          <Empty
            title="Sandboxes are not fully loaded"
            icon={<SearchXIcon />}
            action={
              <Button variant="outline" asChild>
                <a href={`/sandboxes${filtersToSearch(filters)}`}>Reload Sandboxes</a>
              </Button>
            }
          >
            Some sandboxes could not be read. Reload to try again. If this continues, ask an Armada administrator for
            help.
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
          <Empty title="No sandboxes yet" icon={<BoxesIcon />}>
            Choose a snapshot, then tell an agent what to do. You can follow its progress and send more messages here.
          </Empty>
        )
      ) : (
        <SandboxListTabs
          counts={counts}
          tab={activity}
          page={page}
          search={filtersToSearch(filters)}
          rows={rows.map((sandbox) => {
            const life = lifecycleView(sandbox.status, readLifecycle(sandbox), now);
            const readyLabel = waitingIds.has(sandbox.id) ? "Waiting for you" : "Ready";
            const working = workingIds.has(sandbox.id);
            const activityLabel = working ? "Working" : sandbox.status === "running" ? "Running" : undefined;
            const facts = enrichment.get(sandbox.id);
            const hostName =
              sandbox.provider === "docker" && hostRead.state === "ready" && facts
                ? facts.hostId === null
                  ? "Machine not recorded"
                  : hostNames.has(facts.hostId)
                    ? (hostNames.get(facts.hostId) ?? "Unnamed machine")
                    : "Machine name unavailable"
                : undefined;
            const model = sandbox.canOpen
              ? (sandbox.model ?? facts?.cost?.models.join(", ") ?? "Model not reported")
              : "–";
            const owner = displayUser(directory, sandbox.ownerId, viewer.id);
            const lifetime =
              sandbox.status === "stopped" ? "Retained" : (life.remaining ?? life.lifetime ?? "Not recorded");
            return {
              id: sandbox.id,
              content: (
                <article
                  className={cn(sandboxRowGrid, "relative grid gap-y-2 py-2.5 hover:bg-muted/40 md:h-12 md:py-0")}
                >
                  <div className="col-span-2 min-w-0 md:col-span-1">
                    <SandboxName sandbox={sandbox} />
                    <p className="truncate text-xs text-muted-foreground" title={owner}>
                      {owner}
                    </p>
                  </div>
                  <div className="col-start-1 row-start-2 flex min-w-0 flex-col md:col-start-2 md:row-start-1">
                    <SandboxState
                      viewerOwns={sandbox.ownerId === viewer.id}
                      status={sandbox.status}
                      idlePaused={sandbox.idlePaused}
                      expiresAt={sandbox.expiresAt}
                      statusMessage={sandbox.canOpen ? sandbox.statusMessage : null}
                      activityLabel={activityLabel}
                      readyLabel={sandbox.taskOutcome?.state === "ready" ? "Finished" : readyLabel}
                    />
                    <LifecycleHint notice={life.notice} />
                  </div>
                  <div className="col-start-1 row-start-3 min-w-0 text-[13px] md:col-start-3 md:row-start-1">
                    <p className="truncate">{HARNESS_LABELS[sandbox.harness]}</p>
                    <p className="truncate text-xs text-muted-foreground" title={model}>
                      {model}
                      {sandbox.canOpen && sandbox.reasoningEffort ? ` (${sandbox.reasoningEffort})` : ""}
                    </p>
                  </div>
                  <div className="col-start-2 row-start-3 min-w-0 text-[13px] md:col-start-4 md:row-start-1">
                    <ProviderPlacement sandbox={sandbox} hostName={hostName} />
                    {facts?.snapshot && (
                      <p className="truncate text-xs text-muted-foreground" title={facts.snapshot}>
                        {facts.snapshot}
                      </p>
                    )}
                  </div>
                  <div className="col-start-2 row-start-2 min-w-0 text-[13px] tabular-nums md:col-start-5 md:row-start-1 md:text-right">
                    <div className="truncate">
                      <CostCell cost={facts?.cost} />
                    </div>
                    <p className="truncate text-xs text-muted-foreground" title={lifetime}>
                      {lifetime}
                    </p>
                  </div>
                  <div className="relative z-10 col-start-3 row-start-1 flex w-[72px] items-center justify-end md:col-start-6">
                    <SandboxRowDetails sandbox={sandbox} working={working} now={now} />
                    <SandboxRowMenu id={sandbox.id} name={sandboxListName(sandbox)} canOpen={sandbox.canOpen} />
                  </div>
                </article>
              ),
            };
          })}
        />
      )}
    </>
  );
}

/**
 * The sandbox's listed name. Its owner and the organization's admins open it; any other member sees the same metadata
 * without a link into its conversation, files or connections (#680). The server enforces that again on every read.
 */
function SandboxName({ sandbox }: { sandbox: SandboxListMetadata }) {
  const name = sandboxListName(sandbox);
  if (sandbox.canOpen)
    return (
      <Link
        href={`/sandboxes/${sandbox.id}`}
        // The link covers its whole row (the row is the target), and its focus ring is drawn around the row.
        className="flex max-w-full items-center gap-1.5 text-sm font-medium underline-offset-4 outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        <span className="min-w-0 truncate" title={name}>
          {name}
        </span>
        <LinkPendingIcon />
      </Link>
    );
  return (
    <span className="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground" data-restricted>
      <span className="min-w-0 truncate" title={name}>
        {name}
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

function LifecycleHint({ notice }: { notice: LifecycleView["notice"] }) {
  if (!notice) return null;
  return (
    <p className="truncate text-xs text-warning" data-lifecycle={notice.kind} title={notice.title}>
      {notice.kind === "retrying" ? "Stop retrying" : "Past deadline"}
    </p>
  );
}

function SandboxRowDetails({ sandbox, working, now }: { sandbox: SandboxListMetadata; working: boolean; now: Date }) {
  const statusMessage = sandbox.canOpen ? sandbox.statusMessage : null;
  const conversationHint = working ? null : conversationHintText(sandbox, now);
  const pullRequests = sandbox.canOpen ? sandbox.pullRequests : null;
  const outcome = settledOutcome(sandbox.status, sandbox.taskOutcome, pullRequests);
  const preservation = preservationView(sandbox.preservationNote, sandbox.status, sandbox.id, sandbox.canOpen);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Details for ${sandboxListName(sandbox)}`}>
          <InfoIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Sandbox details"
        className="max-h-[var(--radix-popover-content-available-height)] space-y-2 overflow-auto text-xs [overflow-wrap:anywhere]"
      >
        <p className="font-medium">{sandboxListName(sandbox)}</p>
        {conversationHint && <p className="text-muted-foreground">{conversationHint}</p>}
        {statusMessage && <p className="text-muted-foreground">{statusMessage}</p>}
        <p className="font-mono text-muted-foreground">{sandbox.id}</p>
        {(outcome || preservation || pullRequests?.length) && (
          <div className="space-y-1" data-list-outcome={outcome?.kind}>
            {outcome && <OutcomeBadge outcome={outcome} />}
            {outcome && <OutcomeDetail outcome={outcome} className="text-xs" />}
            <PullRequestList pullRequests={pullRequests} />
            {preservation && (
              <p
                data-preservation={preservation.kind}
                className={preservation.kind === "failed" ? "text-warning" : "text-muted-foreground"}
              >
                {preservation.text}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
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

function ProviderPlacement({ sandbox, hostName }: { sandbox: SandboxListMetadata; hostName: string | undefined }) {
  const label =
    sandbox.provider === "docker"
      ? `${DOCKER_HOST_LABEL}${hostName ? ` ${hostName}` : ""}`
      : sandbox.provider === "modal"
        ? "Modal cloud"
        : "Boat cloud";
  return (
    <span title={label} className="flex min-w-0 items-center gap-1.5 [&>svg]:shrink-0">
      <ProviderMark provider={sandbox.provider} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function conversationHintText(sandbox: SandboxListMetadata, now: Date) {
  if (idlePauseMessage(sandbox, now)) return "Wakes when you message";
  return sandbox.canOpen ? null : "Only its owner and admins can open it";
}
