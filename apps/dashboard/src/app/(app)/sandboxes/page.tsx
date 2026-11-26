import {
  HARNESSES,
  type Harness,
  idlePauseMessage,
  MACHINE_SIZES,
  SANDBOX_PLACEMENT_LABELS,
  SANDBOX_PLACEMENT_PROVIDERS,
  type SandboxCost,
  type SandboxPlacementProviderId,
  type SandboxPullRequest,
} from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { BoxesIcon, GitMergeIcon, GitPullRequestIcon, LockIcon, SearchXIcon, TerminalIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CreatedAt } from "@/components/created-at";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderMark } from "@/components/provider-mark";
import { ClaudeAI, OpenAI } from "@/components/provider-marks";
import { RowCost } from "@/components/sandbox-cost";
import { SandboxExplorerBar } from "@/components/sandbox-explorer-bar";
import { SandboxLaunchAction } from "@/components/sandbox-launch-action";
import { SandboxListLiveSync } from "@/components/sandbox-list-live-sync";
import { SandboxListTabs, sandboxRowGrid } from "@/components/sandbox-list-tabs";
import { SandboxRowMenu } from "@/components/sandbox-row-menu";
import { SandboxState } from "@/components/sandbox-state";
import LoadingSandboxes from "@/components/sandboxes-skeleton";
import { StatusDot } from "@/components/status-badge";
import { OutcomeBadge } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { createControlClient } from "@/lib/control";
import { readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { listSandboxMetadata, loadSandboxInventory } from "@/lib/data/sandbox-inventory";
import { listSandboxEnrichment } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { hasDockerHost } from "@/lib/docker-snapshots";
import { mcpUrl } from "@/lib/env";
import { DOCKER_HOST_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { type OutcomeView, type PreservationView, preservationView, settledOutcome } from "@/lib/outcome";
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
import { displayedSandboxModel, isDefaultModelAlias } from "@/lib/sandbox-model";
import { TONE_BADGE } from "@/lib/status-tone";
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
  const enrichmentRead = inventory.then(({ rows }) => listSandboxEnrichment(supabase, selected.org.id, rows));
  const setupRead = inventory.then(({ inventoryTotal }) =>
    inventoryTotal === 0 ? readProviderSetup(selected.org.id) : null,
  );
  const hostReadPromise = inventory.then(async ({ rows }) => {
    if (rows.some((row) => capabilities(row.provider).launchSource === "host")) return readSelectedDockerHosts();
    const setup = await setupRead;
    return setup?.state === "pending" ? readSelectedDockerHosts() : null;
  });
  const [
    { rows, total, inventoryTotal, skipped, facets, activity, counts, page, workingIds, waitingIds, now },
    directory,
    setup,
    hostRead,
    enrichment,
  ] = await Promise.all([
    inventory,
    memberDirectory(supabase, [selected.org.id]),
    setupRead,
    hostReadPromise,
    enrichmentRead,
  ]);

  const hostNames = new Map(hostRead?.state === "ready" ? hostRead.list.hosts.map((host) => [host.id, host.name]) : []);
  const filtered = hasSandboxFilters(filters);
  const deletedCount = facets.status.get("deleted") ?? 0;
  // An organization without a sandbox provider goes to the Cloud providers page to connect one; one with sandboxes to manage stays here.
  const hasDocker = hostRead?.state === "ready" && hasDockerHost(hostRead.list.hosts);
  const setupPending = selected !== null && setup?.state === "pending" && !hasDocker;
  if (setupPending && !filtered && inventoryTotal === 0 && deletedCount === 0 && skipped === 0)
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

  const workingCount = workingIds.size;
  const waitingCount = waitingIds.size;
  const waitingParams = new URLSearchParams(filtersToSearch({ ...filters, page: 1 }));
  waitingParams.set("activity", "need");
  const waitingHref = `/sandboxes?${waitingParams}`;
  const hasOtherOwners = [...facets.owner.keys()].some((id) => id !== viewer.id);
  const showScopeToggle = directory.size > 1 || hasOtherOwners || filters.owner.includes("me");

  const emptyLaunchAction = setupPending ? (
    <Button asChild>
      <Link href={CLOUD_PROVIDERS_PATH}>Connect a provider</Link>
    </Button>
  ) : (
    <SandboxLaunchAction key={`empty-${selected.org.id}`} />
  );
  const mineOnly =
    filters.owner.length === 1 &&
    filters.owner[0] === "me" &&
    !filters.q &&
    !filters.status.length &&
    !filters.provider.length &&
    !filters.harness.length &&
    !filters.model.length &&
    !filters.size.length;

  return (
    <>
      <SandboxListLiveSync organizationId={selected.org.id} />
      <PageHeader
        title="Sandboxes"
        meta={
          workingCount > 0 || waitingCount > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-3">
              {workingCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <StatusDot tone="success" pulse />
                  {`${workingCount} working`}
                </span>
              )}
              {waitingCount > 0 && (
                <Link
                  href={waitingHref}
                  className="inline-flex items-center gap-1.5 text-warning underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <StatusDot tone="warning" />
                  {`${waitingCount} waiting`}
                </Link>
              )}
            </span>
          ) : (
            <span>{total > 0 ? countLabel(total, filtered) : "0 sandboxes"}</span>
          )
        }
      >
        {launchAction}
      </PageHeader>

      <SandboxExplorerBar
        filters={filters}
        activity={activity}
        counts={counts}
        deletedCount={deletedCount}
        workingCount={workingCount}
        waitingCount={waitingCount}
        showScopeToggle={showScopeToggle}
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
                            : isDefaultModelAlias(value)
                              ? "Account default"
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

      {skipped > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {skippedRowsNote(skipped)}
        </p>
      )}

      {total === 0 ? (
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
          mineOnly && inventoryTotal > 0 ? (
            <Empty
              title="You have no sandboxes yet"
              icon={<BoxesIcon />}
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {emptyLaunchAction}
                  <Button variant="outline" asChild>
                    <Link href="/sandboxes">
                      {`View all ${inventoryTotal} ${inventoryTotal === 1 ? "sandbox" : "sandboxes"}`}
                    </Link>
                  </Button>
                </div>
              }
            >
              Launch a sandbox to start working, or view sandboxes created by your team.
            </Empty>
          ) : (
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
          )
        ) : (
          <Empty title="No sandboxes yet" icon={<BoxesIcon />} action={emptyLaunchAction}>
            Choose a snapshot, then tell an agent what to do. You can follow its progress and send more messages here.
          </Empty>
        )
      ) : (
        <SandboxListTabs
          counts={counts}
          tab={activity}
          page={page}
          search={filtersToSearch(filters)}
          filtered={filtered}
          launchAction={emptyLaunchAction}
          rows={rows.map((sandbox) => {
            const life = lifecycleView(sandbox.status, readLifecycle(sandbox), now);
            const working = workingIds.has(sandbox.id);
            const waiting = waitingIds.has(sandbox.id);
            const readyLabel = waiting ? "Waiting for you" : "Ready";
            const activityLabel = working ? "Working" : sandbox.status === "running" ? "Running" : undefined;
            const pullRequests = sandbox.canOpen ? sandbox.pullRequests : null;
            const outcome = settledOutcome(sandbox.status, sandbox.taskOutcome, pullRequests);
            const preservation = preservationView(
              sandbox.preservationNote,
              sandbox.status,
              sandbox.id,
              sandbox.canOpen,
            );
            const facts = enrichment.get(sandbox.id);
            const isHostProvider = capabilities(sandbox.provider).launchSource === "host";
            const hostName =
              isHostProvider && hostRead?.state === "ready" && facts
                ? facts.hostId === null
                  ? "Machine not recorded"
                  : hostNames.has(facts.hostId)
                    ? (hostNames.get(facts.hostId) ?? "Unnamed machine")
                    : "Machine name unavailable"
                : undefined;
            const model = sandbox.canOpen
              ? displayedSandboxModel(sandbox.harness, sandbox.model, facts?.cost?.models)
              : null;
            const effort = sandbox.canOpen && sandbox.reasoningEffort ? sandbox.reasoningEffort : null;
            const modelLine = [model, effort].filter(Boolean).join(" · ");
            const owner = displayUser(directory, sandbox.ownerId, viewer.id);
            const ownerInitial = ((sandbox.ownerId === viewer.id ? viewer.email : owner) || "?").charAt(0);
            const remainingSeconds =
              life.remaining && sandbox.expiresAt
                ? Math.floor((Date.parse(sandbox.expiresAt) - now.getTime()) / 1000)
                : null;
            const expiringSoon = remainingSeconds !== null && remainingSeconds > 0 && remainingSeconds < 30 * 60;
            const timeLabel = life.remaining ?? (sandbox.status === "stopped" ? "Retained" : null);
            const statusSubline = life.notice
              ? null
              : !working && idlePauseMessage(sandbox, now)
                ? "Wakes on message"
                : sandbox.canOpen && sandbox.statusMessage
                  ? sandbox.statusMessage
                  : null;
            const isQuiet = !working && (sandbox.status === "stopped" || sandbox.status === "deleted");
            const accentClass =
              sandbox.status === "failed"
                ? "shadow-[inset_2px_0_0_var(--danger)]"
                : waiting && !working
                  ? "shadow-[inset_2px_0_0_var(--warn)]"
                  : undefined;
            return {
              id: sandbox.id,
              canOpen: sandbox.canOpen,
              content: (
                <article
                  className={cn(
                    sandboxRowGrid,
                    "group relative grid min-h-[58px] gap-y-2 py-2.5 transition-colors duration-120 ease-(--ease-out) motion-reduce:transition-none fine-hover:bg-[var(--raised)]/65",
                    isQuiet && "bg-[var(--sunken)]/30 text-muted-foreground",
                    accentClass,
                  )}
                >
                  <div className="col-span-2 min-w-0 md:col-span-1">
                    <div className="flex min-w-0 items-center gap-1.5" data-list-outcome={outcome?.kind}>
                      <SandboxName sandbox={sandbox} quiet={isQuiet} />
                      {outcome && (
                        <span className="shrink-0" title={outcome.kind === "blocked" ? outcome.reason : undefined}>
                          <OutcomeBadge outcome={outcome} />
                        </span>
                      )}
                      <InlinePullRequests pullRequests={pullRequests} outcome={outcome} />
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border bg-[var(--raised)] text-[10px] font-medium uppercase"
                      >
                        {ownerInitial}
                      </span>
                      <span className="truncate" title={owner}>
                        {owner}
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
                        ·
                      </span>
                      <span className="relative z-10 shrink-0">
                        <CreatedAt iso={sandbox.createdAt} now={now.getTime()} />
                      </span>
                      <span aria-hidden="true" className="hidden shrink-0 text-muted-foreground/50 lg:inline">
                        ·
                      </span>
                      <span
                        className="hidden shrink-0 font-mono text-[11px] text-[var(--faint)] lg:inline"
                        title={sandbox.id}
                      >
                        {sandbox.id.slice(0, 8)}
                      </span>
                      {preservation && <PreservationPill preservation={preservation} />}
                    </div>
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
                    {statusSubline && (
                      <p className="truncate text-xs text-muted-foreground" title={statusSubline}>
                        {statusSubline}
                      </p>
                    )}
                  </div>
                  <div className="col-start-1 row-start-3 min-w-0 text-[13px] md:col-start-3 md:row-start-1">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <AgentMark harness={sandbox.harness} />
                      <span className="truncate">{HARNESS_LABELS[sandbox.harness]}</span>
                    </p>
                    {modelLine && (
                      <p className="truncate font-mono text-[11px] text-muted-foreground" title={modelLine}>
                        {modelLine}
                      </p>
                    )}
                  </div>
                  <div className="col-start-2 col-span-2 row-start-3 min-w-0 text-[13px] md:col-start-4 md:col-span-1 md:row-start-1">
                    {facts?.snapshot ? (
                      <>
                        <p className="truncate" title={facts.snapshot}>
                          {facts.snapshot}
                        </p>
                        <ProviderPlacement
                          sandbox={sandbox}
                          hostName={hostName}
                          className="text-xs text-muted-foreground"
                        />
                      </>
                    ) : (
                      <ProviderPlacement sandbox={sandbox} hostName={hostName} />
                    )}
                  </div>
                  <div className="col-start-2 col-span-2 row-start-2 min-w-0 text-right text-[13px] tabular-nums md:col-start-5 md:col-span-1 md:row-start-1">
                    <div className="truncate">
                      <CostCell cost={facts?.cost} />
                    </div>
                    {timeLabel && (
                      <p
                        className={cn(
                          "truncate text-xs",
                          expiringSoon ? "font-medium text-warning" : "text-muted-foreground",
                        )}
                        title={timeLabel}
                      >
                        {timeLabel}
                      </p>
                    )}
                  </div>
                  <div className="relative z-10 col-start-3 row-start-1 flex w-9 items-center justify-end md:col-start-6">
                    <SandboxRowMenu
                      id={sandbox.id}
                      name={sandboxListName(sandbox)}
                      canOpen={sandbox.canOpen}
                      canManage={sandbox.canManage}
                      status={sandbox.status}
                      provider={sandbox.provider}
                    />
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
function SandboxName({ sandbox, quiet = false }: { sandbox: SandboxListMetadata; quiet?: boolean }) {
  const name = sandboxListName(sandbox);
  if (sandbox.canOpen)
    return (
      <Link
        href={`/sandboxes/${sandbox.id}`}
        // The link covers its whole row (the row is the target), and its focus ring is drawn around the row.
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
          quiet && "text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate" title={name}>
          {name}
        </span>
        <LinkPendingIcon />
      </Link>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" data-restricted>
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      <LockIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Only its owner and organization admins can open it</span>
    </span>
  );
}

const PR_PILL =
  "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap transition-opacity duration-120 ease-(--ease-out) motion-reduce:transition-none fine-hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function InlinePullRequests({
  pullRequests,
  outcome,
}: {
  pullRequests: readonly SandboxPullRequest[] | null | undefined;
  outcome: OutcomeView | null;
}) {
  if (pullRequests?.length) {
    const first = pullRequests[0]!;
    const extra = pullRequests.length - 1;
    const Icon = first.state === "merged" ? GitMergeIcon : GitPullRequestIcon;
    const tone =
      first.state === "merged" ? TONE_BADGE.success : first.state === "open" ? TONE_BADGE.info : TONE_BADGE.neutral;
    return (
      <span className="inline-flex shrink-0 items-center gap-1" data-pull-requests>
        <a
          href={first.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${first.repository}#${first.number}`}
          className={cn(PR_PILL, tone)}
        >
          <Icon aria-hidden="true" className="size-3" />#{first.number}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {extra > 0 && (
          <span
            className="rounded-md border bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={pullRequests
              .slice(1)
              .map((pr) => `${pr.repository}#${pr.number}`)
              .join(", ")}
          >
            +{extra}
          </span>
        )}
      </span>
    );
  }
  if (outcome?.kind !== "ready" || !outcome.pr?.href) return null;
  const Icon = outcome.merged ? GitMergeIcon : GitPullRequestIcon;
  return (
    <a
      href={outcome.pr.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(PR_PILL, outcome.merged ? TONE_BADGE.success : TONE_BADGE.info)}
    >
      <Icon aria-hidden="true" className="size-3" />
      {outcome.pr.label.replace(/^PR\s+/, "")}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function PreservationPill({ preservation }: { preservation: PreservationView }) {
  const labels = {
    preserved: "Work preserved",
    failed: "Preservation failed",
    unknown: "Preservation unknown",
    other: preservation.text,
  };
  return (
    <span
      data-preservation={preservation.kind}
      title={preservation.text}
      className={cn(
        "inline-flex max-w-full shrink-0 truncate rounded-md border px-1.5 py-0 text-[11px] font-medium",
        preservation.kind === "failed" ? TONE_BADGE.warning : TONE_BADGE.neutral,
      )}
    >
      {labels[preservation.kind]}
    </span>
  );
}

function AgentMark({ harness }: { harness: Harness }) {
  if (harness === "claude") return <ClaudeAI className="size-3.5 shrink-0" />;
  if (harness === "codex") return <OpenAI className="size-3.5 shrink-0" />;
  return <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * The row's cost figure. Usage is interior: a sandbox the viewer may not open has none to show, as on the server's list.
 * The title says whether the figure is an estimate or the API equivalent of a subscription's tokens.
 */
function CostCell({ cost }: { cost: SandboxCost | undefined }) {
  if (!cost)
    return (
      <span className="text-muted-foreground" title="Only its owner and organization admins see its usage">
        <span aria-hidden="true">—</span>
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

/** "3 sandboxes", or with filters "1 sandbox matches" / "3 sandboxes match". */
function countLabel(total: number, filtered: boolean): string {
  const noun = total === 1 ? "sandbox" : "sandboxes";
  return filtered ? `${total} ${noun} ${total === 1 ? "matches" : "match"}` : `${total} ${noun}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ProviderPlacement({
  sandbox,
  hostName,
  className,
}: {
  sandbox: SandboxListMetadata;
  hostName: string | undefined;
  className?: string;
}) {
  const label =
    capabilities(sandbox.provider).launchSource === "host"
      ? (hostName ?? DOCKER_HOST_LABEL)
      : SANDBOX_PLACEMENT_LABELS[sandbox.provider];
  return (
    <span title={label} className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <ProviderMark provider={sandbox.provider} />
      <span className="truncate">{label}</span>
    </span>
  );
}
