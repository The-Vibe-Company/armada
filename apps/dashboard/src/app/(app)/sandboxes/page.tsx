import {
  HARNESSES,
  idlePauseMessage,
  MACHINE_SIZES,
  SANDBOX_PLACEMENT_LABELS,
  SANDBOX_PLACEMENT_PROVIDERS,
  type SandboxCost,
  type SandboxListMetadata,
  type SandboxPlacementProviderId,
} from "@armada/core";
import { BoxesIcon, LockIcon, RocketIcon, SearchXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { readLaunchDialogOptions } from "@/app/actions/sandboxes";
import { LaunchStart } from "@/components/launch-dialog";
import { LaunchDialogContent } from "@/components/launch-surface";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderName } from "@/components/provider-mark";
import { RowCost } from "@/components/sandbox-cost";
import { SandboxListTabs } from "@/components/sandbox-list-tabs";
import { SandboxRowMenu } from "@/components/sandbox-row-menu";
import { SandboxState } from "@/components/sandbox-state";
import { SandboxToolbar } from "@/components/sandbox-toolbar";
import LoadingSandboxes from "@/components/sandboxes-skeleton";
import { OutcomeBadge, OutcomeDetail } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { findGoldenLabel } from "@/lib/data/goldens";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { listSandboxCosts, listSandboxHostNames } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { hasDockerHost } from "@/lib/docker-snapshots";
import { HARNESS_LABELS } from "@/lib/labels";
import { type LifecycleView, lifecycleView, readLifecycle } from "@/lib/lifecycle";
import { preservationView, settledOutcome } from "@/lib/outcome";
import { CLOUD_PROVIDERS_PATH } from "@/lib/provider-setup";
import { machineSizeLabel, parseSandboxListMetadata, skippedRowsNote } from "@/lib/sandbox-access";
import {
  FACETS,
  type Facet,
  type FacetOption,
  filterSandboxes,
  filtersToSearch,
  hasSandboxFilters,
  parseSandboxFilters,
  SANDBOX_STATUSES,
  sandboxFacetCounts,
  sortSandboxes,
} from "@/lib/sandbox-filters";
import { sandboxListName } from "@/lib/sandbox-list-name";
import { createClient, type Supabase } from "@/lib/supabase/server";

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
  const viewer = await requireViewer();
  const filters = parseSandboxFilters(await searchParams);
  const supabase = await createClient();
  const selected = await selectedOrganization();
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
  const inventory = loadInventory(supabase, selected.org.id, filters, viewer.id);
  const hosts = readSelectedDockerHosts();
  // Enrich rows as soon as their actual dependencies resolve, not after unrelated setup/directory reads.
  const costsRead = inventory.then(({ rows }) => listSandboxCosts(supabase, rows));
  const namesRead = Promise.all([inventory, hosts]).then(([{ rows }, hostRead]) =>
    listSandboxHostNames(supabase, rows, hostRead.state === "ready" ? hostRead.list : null),
  );
  const [{ rows, total, inventoryTotal, skipped, facets }, directory, setup, hostRead, costs, hostNames] =
    await Promise.all([
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
      costsRead,
      namesRead,
    ]);
  // Interior fields are read only for rows the server authorizes this viewer to open.
  const readableIds = rows.filter((row) => row.canOpen).map((row) => row.id);
  const snapshots = new Map<string, string>();
  if (readableIds.length) {
    const { data, error } = await supabase.from("sandboxes").select("id,golden_id").in("id", readableIds);
    if (error) throw new Error(error.message);
    const goldenIds = [...new Set((data ?? []).flatMap((row) => (row.golden_id ? [row.golden_id] : [])))];
    const labels = new Map(
      await Promise.all(goldenIds.map(async (id) => [id, (await findGoldenLabel(supabase, id))?.name] as const)),
    );
    for (const row of data ?? [])
      if (row.golden_id && labels.get(row.golden_id)) snapshots.set(row.id, labels.get(row.golden_id) as string);
  }

  const now = new Date();
  const filtered = hasSandboxFilters(filters);
  // An organization without a sandbox provider goes to the Cloud providers page to connect one; one with sandboxes to manage stays here.
  const hasDocker = hostRead.state === "ready" && hasDockerHost(hostRead.list.hosts);
  const setupPending = selected !== null && setup?.state === "pending" && !hasDocker;
  if (setupPending && !filtered && inventoryTotal === 0 && skipped === 0) redirect(CLOUD_PROVIDERS_PATH);

  const launchAction = setupPending ? (
    <Button asChild>
      <Link href={CLOUD_PROVIDERS_PATH}>Connect a provider</Link>
    </Button>
  ) : selected ? (
    <Suspense
      fallback={
        <Button disabled>
          <RocketIcon /> Launch a sandbox
        </Button>
      }
    >
      <SandboxLaunchAction />
    </Suspense>
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
                        ? (SANDBOX_PLACEMENT_LABELS[value as SandboxPlacementProviderId] ?? capitalize(value))
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

      {skipped > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {skippedRowsNote(skipped)}
        </p>
      )}

      {rows.length === 0 ? (
        total > 0 ? (
          <Empty title="This page is past the last one" icon={<SearchXIcon />}>
            <Link href={`/sandboxes${filtersToSearch({ ...filters, page: 1 })}`} className="underline">
              Go to the first page
            </Link>
          </Empty>
        ) : skipped > 0 ? (
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
          <Empty title="No sandboxes yet" action={launchAction} icon={<BoxesIcon />}>
            Choose a snapshot, then tell an agent what to do. You can follow its progress and send more messages here.
          </Empty>
        )
      ) : (
        <SandboxListTabs
          rows={rows.map((sandbox) => {
            const life = lifecycleView(sandbox.status, readLifecycle(sandbox), now);
            const paused = Boolean(idlePauseMessage(sandbox, now));
            const working = sandbox.status === "running" || sandbox.status === "starting";
            const need =
              sandbox.canOpen &&
              !paused &&
              (sandbox.status === "ready" ||
                sandbox.status === "failed" ||
                Boolean(life.notice) ||
                (working && Date.parse(sandbox.expiresAt ?? "") - now.getTime() < 30 * 60_000));
            return {
              id: sandbox.id,
              need,
              working,
              content: (
                <article className="relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <SandboxName sandbox={sandbox} snapshot={snapshots.get(sandbox.id)} />
                    <p className="mt-1 text-xs text-muted-foreground">
                      <ProviderPlacement sandbox={sandbox} hostName={hostNames.get(sandbox.id)} /> ·{" "}
                      {displayUser(directory, sandbox.ownerId, viewer.id)}
                    </p>
                  </div>
                  <div className="col-start-1 sm:col-auto">
                    <SandboxState
                      status={sandbox.status}
                      idlePaused={sandbox.idlePaused}
                      expiresAt={sandbox.expiresAt}
                      statusMessage={sandbox.canOpen ? sandbox.statusMessage : null}
                      readyLabel={sandbox.taskOutcome?.state === "ready" ? "Finished" : undefined}
                    />
                    <ConversationHint sandbox={sandbox} now={now} />
                    <OutcomeHint sandbox={sandbox} />
                    {sandbox.canOpen && sandbox.statusMessage && (
                      <p className="mt-1 text-xs text-muted-foreground">{sandbox.statusMessage}</p>
                    )}
                  </div>
                  <p className="min-w-0 break-words text-sm text-muted-foreground max-sm:col-start-1">
                    {sandbox.canOpen
                      ? (sandbox.model ?? costs.get(sandbox.id)?.models.join(", ") ?? "Model not reported")
                      : "–"}
                  </p>
                  <div className="text-xs text-muted-foreground max-sm:col-start-1">
                    <LifecycleHint view={life} />
                    <CostCell cost={sandbox.canOpen ? costs.get(sandbox.id) : undefined} />
                  </div>
                  <div className="relative z-10 max-sm:col-start-2 max-sm:row-start-1">
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
function SandboxName({ sandbox, snapshot }: { sandbox: SandboxListMetadata; snapshot?: string | undefined }) {
  const name = `${HARNESS_LABELS[sandbox.harness]} on ${snapshot ?? (sandbox.provider === "docker" ? "your server" : "sandbox")}`;
  if (sandbox.canOpen)
    return (
      <Link
        href={`/sandboxes/${sandbox.id}`}
        // The link covers its whole row (the row is the target), and its focus ring is drawn around the row.
        className="inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium underline-offset-4 outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        <span className="min-w-0 break-words whitespace-normal" title={name}>
          {name}
        </span>
        <LinkPendingIcon />
      </Link>
    );
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-sm text-muted-foreground" data-restricted>
      <span className="min-w-0 break-words whitespace-normal" title={name}>
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

function ProviderPlacement({ sandbox, hostName }: { sandbox: SandboxListMetadata; hostName: string | undefined }) {
  return (
    <span className="inline-flex min-w-0 flex-col gap-0.5">
      <ProviderName provider={sandbox.provider} />
      {sandbox.provider === "docker" && (
        <span className="max-w-48 text-xs whitespace-normal text-muted-foreground break-words">
          {sandbox.canOpen ? (hostName ?? "Machine name unavailable") : "Machine details private"}
        </span>
      )}
    </span>
  );
}

/** The state badge stays canonical; touch users also get the next step without a hover tooltip. */
function ConversationHint({ sandbox, now }: { sandbox: SandboxListMetadata; now: Date }) {
  const text = idlePauseMessage(sandbox, now)
    ? "Wakes when you message"
    : !sandbox.canOpen
      ? "Only its owner and admins can open it"
      : null;
  return text ? <p className="mt-1 max-w-48 text-xs whitespace-normal text-muted-foreground">{text}</p> : null;
}

/** Reuse the unified dialog without routing the person through the snapshot inventory. */
async function SandboxLaunchAction() {
  const options = await readLaunchDialogOptions().catch(() => null);
  const target = options?.targets.find((item) => !item.reason);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <RocketIcon /> Launch a sandbox
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>
        {options && target ? (
          target.hostId ? (
            <LaunchStart
              orgId={options.orgId}
              hostId={target.hostId}
              hostName={target.label.replace(/^Empty machine · /, "")}
              accounts={options.accounts}
              unavailable={[]}
              harnesses={target.harnesses ?? []}
              initialHarness={target.initialHarness ?? "codex"}
            />
          ) : (
            <LaunchStart
              orgId={options.orgId}
              golden={target.golden}
              provider={target.provider}
              {...(target.snapshotId ? { snapshotId: target.snapshotId } : {})}
              repositories={target.repositories}
              {...(target.sizing ? { sizing: target.sizing } : {})}
              accounts={options.accounts}
              catalog={options.catalog}
              connections={options.connections}
              boatOpenCodeAvailable={options.boatOpenCodeAvailable}
            />
          )
        ) : (
          <DialogHeader className="overflow-y-auto p-6 pr-12 text-left">
            <DialogTitle>Launch a sandbox</DialogTitle>
            <DialogDescription>
              {options
                ? options.targets.length > 0
                  ? "Your starting points need attention before launching."
                  : "No starting points yet. Build a snapshot or connect your server before launching."
                : "Starting points could not be loaded. Reload Sandboxes to try again."}
            </DialogDescription>
            {options && options.targets.length > 0 && (
              <ul className="space-y-3 text-sm">
                {options.targets.map((item) => (
                  <li key={item.id}>
                    <p className="font-medium">{item.label}</p>
                    <p className="text-muted-foreground">{item.reason}</p>
                    <Link className="underline underline-offset-4" href={item.hostId ? "/hosts" : "/snapshots"}>
                      {item.hostId ? "Open Hosts" : "Open Snapshots"}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Button asChild variant="outline">
              <Link href={options ? "/snapshots" : "/sandboxes"}>
                {options ? "Open Snapshots" : "Reload Sandboxes"}
              </Link>
            </Button>
          </DialogHeader>
        )}
      </LaunchDialogContent>
    </Dialog>
  );
}

/** Read the authorized metadata once; activity tabs must see the entire loaded inventory, not one page. */
async function loadInventory(
  supabase: Supabase,
  orgId: string,
  filters: ReturnType<typeof parseSandboxFilters>,
  viewerId: string,
) {
  const inventory: SandboxListMetadata[] = [];
  let skipped = 0;
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase
      .rpc("sandbox_list_metadata")
      .eq("orgId", orgId)
      .order("id")
      .range(from, from + 499);
    if (error?.code === "PGRST103") break;
    if (error) throw new Error(error.message);
    const parsed = parseSandboxListMetadata(data);
    inventory.push(...parsed.rows);
    skipped += parsed.skipped.length;
    if (parsed.rows.length + parsed.skipped.length < 500) break;
  }
  const rows = sortSandboxes(filterSandboxes(inventory, filters, viewerId), filters.sort);
  return {
    rows,
    total: rows.length,
    inventoryTotal: inventory.filter((row) => row.status !== "deleted").length,
    skipped,
    facets: sandboxFacetCounts(inventory, filters, viewerId),
  };
}
