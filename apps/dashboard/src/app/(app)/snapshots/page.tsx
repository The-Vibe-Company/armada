import {
  type DockerSnapshotRecord,
  isSandboxProvider,
  MODEL_CATALOG,
  machineCapacity,
  type SandboxProviderId,
} from "@armada/core";
import { CircleCheckIcon, FolderGit2Icon, GitBranchIcon, LayersIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { type ComponentProps, cache, Fragment, Suspense } from "react";
import { setGoldenVisibility } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { Disclosure } from "@/components/disclosure";
import { DockerLaunchLimitList } from "@/components/docker-launch-limit-list";
import { SnapshotBuildRefresh, SnapshotCreateChoice, SnapshotRebuildDialog } from "@/components/docker-snapshot-forms";
import { EnvironmentTemplates } from "@/components/environment-templates";
import { GoldenCreateDialog } from "@/components/golden-create-dialog";
import { GoldenForm } from "@/components/golden-form";
import { type LaunchConnections, type LaunchProps, LaunchStart } from "@/components/launch-dialog";
import { LaunchDialogContent } from "@/components/launch-surface";
import { Empty } from "@/components/page-header";
import { ProviderMark } from "@/components/provider-mark";
import { RemoveGolden } from "@/components/remove-golden";
import { ResourceBrowser, type ResourceRow, SelectItem } from "@/components/resource-browser";
import { SizeDefaults } from "@/components/size-defaults";
import { PanelSection, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { isUuid } from "@/lib/action";
import { CAPABILITIES_TIMEOUT_MS, createControlClient, readGoldenCapabilities } from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readSelectedDockerSnapshots } from "@/lib/data/docker-snapshots";
import { getGitHubConnection } from "@/lib/data/github";
import { findRemovedGolden, type GoldenRow, listGoldenHistory, listGoldens } from "@/lib/data/goldens";
import { readLaunchOptions } from "@/lib/data/launch-options";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listSelectedTemplates, lookupsFrom, type TemplateList } from "@/lib/data/templates";
import { listSelectedVault } from "@/lib/data/variables";
import { displayUser, listMemberships, type Membership, memberDirectory, requireViewer } from "@/lib/data/viewer";
import type { DockerHostState } from "@/lib/docker-hosts";
import { dockerHarnesses, dockerLaunchBlocker, dockerUnavailable } from "@/lib/docker-launch";
import { hasDockerHost, snapshotLaunchEnabled, snapshotRebuildAvailable, snapshotState } from "@/lib/docker-snapshots";
import { mcpUrl } from "@/lib/env";
import { capacityParts, environmentState } from "@/lib/environments";
import {
  editDefaults,
  GOLDEN_PROVIDERS,
  goldenInit,
  goldenLaunchReadiness,
  goldenRemoveBlocker,
  goldenRepos,
  goldenRowState,
  PROVIDER_LABELS,
  providerCapacity,
} from "@/lib/golden-form";
import { DOCKER_HOST_LABEL, dockerHostGroup } from "@/lib/labels";
import { boatOpenCodeAvailable } from "@/lib/launch-options";
import { goldenSizing, sizePolicyBlocker } from "@/lib/machine-size";
import { CLOUD_PROVIDERS_PATH, connectedProviders } from "@/lib/provider-setup";
import { relativeAge } from "@/lib/relative-time";
import { goldenRepositoryDirs } from "@/lib/repository-context";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { createClient } from "@/lib/supabase/server";
import { launchTarget, type TemplateLaunchTarget } from "@/lib/template-launch";
import type { TemplateLookups } from "@/lib/templates";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Snapshots" };
export const dynamic = "force-dynamic";
// The create, rebuild and launch server actions run in this route's function and wait for the server (a launch up to
// LAUNCH_TIMEOUT_MS). This is the same bound as `/api/v1/*`, so the fetch times out before the function.
export const maxDuration = 800;

const DESCRIPTION = "Pre-built repositories and setup commands that sandboxes and templates start from.";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function GoldensPage({ searchParams }: Props) {
  const [query, viewer, supabase, selected] = await Promise.all([
    searchParams,
    requireViewer(),
    createClient(),
    selectedOrganization(),
  ]);
  const removedParam = query.removed;
  // The confirmation after a removal: only for a golden of this org the database records as removed, named from it.
  const removedRead =
    typeof removedParam === "string" && isUuid(removedParam) ? findRemovedGolden(supabase, removedParam) : null;
  // New builds, rebuilds and launches run on a provider the organization has connected (#598): exactly that one, never
  // another. Existing goldens and builds the page already tracks stay manageable without it; an org with neither is
  // sent to Settings to connect one. Null: the status could not be read, a retryable error rather than "none".
  const setupRead = selected ? readProviderSetup(selected.org.id) : Promise.resolve(null);
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const serverUrl = mcpUrl();
  const hostsRead = readSelectedDockerHosts();
  const snapshotsRead = readSelectedDockerSnapshots();
  // Docker discovery determines inventory readiness only when there is a host or snapshot to show.
  // Cloud-only inventories must not wait for the launch dialog's harness discovery.
  const dockerOptionRead = Promise.all([hostsRead, snapshotsRead]).then(([hosts, snapshots]) =>
    (hosts.state === "ready" && hosts.list.hosts.some((host) => host.state !== "revoked")) ||
    (snapshots.state === "ready" && snapshots.snapshots.length > 0)
      ? readDockerLaunchOption()
      : null,
  );
  const [setup, hostRead, snapshotRead, dockerOption, goldens, memberships, directory, github, removed] =
    await Promise.all([
      setupRead,
      hostsRead,
      snapshotsRead,
      dockerOptionRead,
      listGoldens(supabase),
      pending,
      pending.then((items) =>
        memberDirectory(
          supabase,
          items.map((item) => item.org.id),
        ),
      ),
      getGitHubConnection(supabase).catch(() => null),
      removedRead,
    ]);
  const hosts = hostRead.state === "ready" ? hostRead.list.hosts.filter((host) => host.state !== "revoked") : [];
  const snapshots = snapshotRead.state === "ready" ? snapshotRead.snapshots : [];
  const hasDocker = hasDockerHost(hosts) || snapshots.length > 0;
  const dockerPlacement = hostRead.state === "ready" && hostRead.list.placement;
  const canBuildDocker = dockerPlacement && Boolean(dockerOption?.enabled && dockerOption.capabilities.goldens);
  const setupPending = selected !== null && setup?.state === "pending";
  const connected = setup && setup.state !== "unavailable" ? connectedProviders(setup.status) : null;
  const canStart = (connected?.length ?? 0) > 0 || hasDocker;
  const tracked = (scope: string) => query[`build.${scope}`] !== undefined || query[`build-key.${scope}`] !== undefined;
  const createTracked = selected !== null && tracked(`create.${selected.org.id}`);
  const rebuildsTracked = new Set(
    goldens.filter((golden) => tracked(`rebuild.${golden.id}`)).map((golden) => golden.id),
  );
  if (setupPending && !hasDocker && goldens.length === 0 && !createTracked && rebuildsTracked.size === 0)
    redirect(CLOUD_PROVIDERS_PATH);
  const orgs = new Map(memberships.map((item) => [item.org.id, item]));
  const serverReady = serverUrl !== null;
  const githubConnected = Boolean(github && !github.revoked_at);
  const context: RowContext = {
    orgs,
    directory,
    viewerId: viewer.id,
    all: goldens,
    serverReady,
    connected,
    rebuildsTracked,
    hostStates: new Map((hostRead.state === "ready" ? hostRead.list.hosts : []).map((host) => [host.id, host.state])),
  };

  const now = Date.now();
  // A golden on a provider this page does not know is left out and counted, never a failed page (#1398).
  const shown = goldens.filter((golden) => {
    if (isSandboxProvider(golden.provider)) return true;
    console.error(`Environment row left out: provider does not match the contract (id ${golden.id}).`);
    return false;
  });
  const skipped = goldens.length - shown.length;
  const cloudRows = shown.map((golden) => environmentRow(golden, context, now));
  const rebuildableBoatIds = new Set(
    cloudRows.filter((row) => row.provider === "boat" && row.rebuildable).map((row) => row.key),
  );
  const replacements = goldens
    .filter((golden) => rebuildableBoatIds.has(golden.id))
    .map(({ id, name, visibility }) => ({ id, name, visibility }));
  const capacity =
    selected && connected?.length
      ? readSnapshotCapacity(supabase, serverUrl, viewer.token, selected.org.id, connected)
      : null;
  // A tracked build reopens the dialog even if a provider was disconnected.
  const create = selected && (canStart || createTracked) ? renderCreateDialog(selected) : undefined;

  function renderCreateDialog({ org, role }: Membership) {
    async function CreateOptions() {
      const [connections, accounts, available] = await Promise.all([
        readSnapshotConnections(),
        readSnapshotAccounts(),
        capacity,
      ]);
      const launch = { orgId: org.id, catalog: MODEL_CATALOG, connections, accounts };
      const providers = connected ?? [];
      return (
        <SnapshotCreateChoice
          githubConnected={githubConnected}
          snapshots={snapshots}
          launch={launch}
          orgId={org.id}
          isAdmin={role === "admin"}
          hosts={hosts}
          canBuild={canBuildDocker}
          cloudForms={Object.fromEntries(
            providers.map((provider) => [
              provider,
              <GoldenForm
                key={provider}
                mode="create"
                orgId={org.id}
                orgName={org.name}
                isAdmin={role === "admin"}
                providers={providers}
                capacities={available?.capacities ?? {}}
                canStart={serverReady}
                githubConnected={githubConnected}
                replacements={replacements}
                launch={launch}
              />,
            ]),
          )}
        />
      );
    }
    return (
      <GoldenCreateDialog orgId={org.id} initialOpen={createTracked}>
        <Suspense fallback={<p role="status">Loading snapshot options…</p>}>
          <CreateOptions />
        </Suspense>
      </GoldenCreateDialog>
    );
  }
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;
  // Build recovery belongs to the page; only an explicit item opens a detail.
  // Otherwise a Back/reload of the list would reopen a dismissed rebuild.
  const initial = requested;
  // A missing host feature is not a failed inventory read. If hosts are supported (or their read failed),
  // an unavailable snapshot list remains unknown even when no connected machine can be shown.
  const snapshotsUnavailable =
    selected !== null && hostRead.state !== "disabled" && snapshotRead.state === "unavailable";
  const inventoryIncomplete = snapshotsUnavailable || setup?.state === "unavailable" || skipped > 0;
  const reload = (
    <Button asChild variant="outline" size="sm">
      {/* A document request must recheck server data rather than reuse the client router's cached render. */}
      <a href="/snapshots">Reload Snapshots</a>
    </Button>
  );

  const notices = (
    <>
      <SnapshotBuildRefresh building={snapshots.some((row) => row.status === "building")} />
      {snapshotsUnavailable && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Self-hosted snapshots could not be loaded</AlertTitle>
          <AlertDescription>
            <p>
              Some snapshots may be missing. Reload Snapshots to try again. If this continues, ask an Armada
              administrator to check self-hosted access.
            </p>
            {reload}
          </AlertDescription>
        </Alert>
      )}
      {skipped > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {skipped} {skipped === 1 ? "snapshot" : "snapshots"} could not be shown.
        </p>
      )}
      {setup?.state === "unavailable" && (
        <Alert variant="destructive" data-setup-state="unavailable">
          <TriangleAlertIcon />
          <AlertTitle>Provider status unavailable</AlertTitle>
          <AlertDescription>
            <p>
              Provider connections could not be checked. Reload Snapshots to try again. Existing snapshots remain
              visible; cloud builds need a confirmed provider connection.
            </p>
            {reload}
          </AlertDescription>
        </Alert>
      )}
      {removed && (
        <Alert role="status" data-golden-removed className="border-success/40">
          <CircleCheckIcon className="text-success" />
          <AlertTitle>Removed {removed.name}</AlertTitle>
          <AlertDescription>
            Its sandboxes, logs and state artifacts stay. Any existing backend reservation is retained.
          </AlertDescription>
        </Alert>
      )}
      {capacity && (
        <Suspense fallback={null}>
          <SnapshotCapacityNotices capacity={capacity} />
        </Suspense>
      )}
    </>
  );

  async function SnapshotCapacitySummary() {
    if (!capacity) return null;
    const { entries } = await capacity;
    const parts = capacityParts(entries);
    return (
      <p className="text-xs text-muted-foreground" data-capacity-summary>
        {parts.map((part, index) => (
          <Fragment key={part.provider}>
            {index > 0 && <span aria-hidden> · </span>}
            <span
              data-capacity={part.kind}
              data-capacity-provider={part.provider}
              data-capacity-removed={entries[index]?.removed}
              className={cn(part.kind === "full" || part.kind === "legacy" ? "text-warning" : undefined)}
            >
              <span data-capacity-line>{part.text}</span>
              {part.reason && (
                <>
                  {" "}
                  (<span data-capacity-reason>{part.reason}</span>)
                </>
              )}
            </span>
          </Fragment>
        ))}
      </p>
    );
  }

  const empty =
    selected && inventoryIncomplete ? (
      <Empty title="Snapshots are not fully loaded" action={reload} icon={<LayersIcon />}>
        We cannot confirm whether snapshots are available. Reload Snapshots, or ask an Armada administrator to check
        access if this continues.
      </Empty>
    ) : selected ? (
      <Empty title="No snapshots yet" icon={<LayersIcon />}>
        {create
          ? "Use New snapshot to build the first one: the repositories an agent starts with, saved as a snapshot."
          : "Connect a sandbox provider to build the first one."}
      </Empty>
    ) : (
      <Empty
        title="No organization yet"
        action={
          <Button asChild>
            <Link href="/orgs">Choose an organization</Link>
          </Button>
        }
      >
        Create or join an organization before building snapshots.
      </Empty>
    );
  const rows: ResourceRow[] = [
    ...sortResources(cloudRows.filter((row) => row.bucket !== "ready")),
    ...sortResources(cloudRows.filter((row) => row.bucket === "ready")),
  ];
  const hostIds = new Set([...hosts.map((host) => host.id), ...snapshots.map((snapshot) => snapshot.hostId)]);
  for (const hostId of hostIds) {
    const host = hosts.find((item) => item.id === hostId);
    const saved = snapshots.filter((item) => item.hostId === hostId);
    const name = host?.name ?? saved[0]?.hostName ?? DOCKER_HOST_LABEL;
    const blocker = host
      ? dockerLaunchBlocker(dockerOption, dockerPlacement, host)
      : "This Docker host is no longer connected. Register it again from Docker hosts.";
    const agents = dockerHarnesses(dockerOption);
    const action =
      selected && host && !blocker ? (
        <DeferredLaunch>
          <EmptyHostLaunchStart
            orgId={selected.org.id}
            hostId={host.id}
            hostName={name}
            unavailable={dockerOption ? dockerUnavailable(dockerOption) : []}
            harnesses={agents.offered}
            initialHarness={agents.initial ?? "codex"}
          />
        </DeferredLaunch>
      ) : null;
    rows.push(
      {
        catalog: { group: "docker", attention: !!blocker, footer: name },
        key: `empty:${hostId}`,
        name: "Empty machine",
        search: name,
        meta: "No snapshot needed",
        state: <StateCell tone={blocker ? "warning" : "success"} label={blocker ? "Unavailable" : "Ready"} />,
        fact: blocker ?? "No repository, nothing installed by you",
        action,
        detail: (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {blocker ?? "Start without a snapshot. No repository or setup commands have been added by you."}
            </p>
            {action}
          </div>
        ),
      },
      ...saved.map((snapshot) =>
        dockerSnapshotRow(
          snapshot,
          context,
          snapshotLaunchEnabled(dockerOption, dockerPlacement),
          snapshotRead.state === "ready" ? snapshotRead.currentVersion : null,
          canBuildDocker,
        ),
      ),
    );
  }
  return (
    <ResourceBrowser
      variant="grid"
      catalogFilters={[
        { key: "all", label: "All" },
        { key: "boat", label: "Boat" },
        { key: "modal", label: "Modal" },
        ...(rows.some((row) => row.catalog?.group === "docker") ? [{ key: "docker", label: "Docker" }] : []),
        { key: "attention", label: "Needs attention" },
      ]}
      title="Snapshots"
      description={DESCRIPTION}
      label="Snapshots"
      rows={rows}
      blockers={[]}
      initial={initial}
      actions={create}
      notices={notices}
      empty={empty}
      footer={
        capacity && (
          <Suspense fallback={null}>
            <SnapshotCapacitySummary />
          </Suspense>
        )
      }
    />
  );
}

async function readSnapshotConnections(): Promise<LaunchConnections> {
  const listed = await listSelectedConnections();
  return listed.state === "ready"
    ? { connections: listed.connections }
    : { unavailable: listed.state === "error" ? listed.message : "The Armada server is not configured." };
}

const readSnapshotAccounts = cache(async () => launchAccounts(await listSelectedAccounts(), Date.now()));
const readSnapshotTemplateChoices = cache(async (goldens: GoldenRow[]) => {
  const [list, connections, vault] = await Promise.all([
    listSelectedTemplates(),
    listSelectedConnections(),
    listSelectedVault(),
  ]);
  return launchTemplates(list, goldens, lookupsFrom(goldens, connections, vault));
});

async function EmptyHostLaunchStart(
  props: Omit<Extract<ComponentProps<typeof LaunchStart>, { hostId: string }>, "accounts">,
) {
  const accounts = await readSnapshotAccounts();
  return (
    <EnvironmentLaunchDialog>
      <LaunchStart {...props} accounts={accounts} />
    </EnvironmentLaunchDialog>
  );
}

async function readSnapshotCapacity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  serverUrl: string | null,
  token: string | null,
  orgId: string,
  providers: SandboxProviderId[],
) {
  const [history, capabilities] = await Promise.all([
    listGoldenHistory(supabase),
    allCapabilities(serverUrl, token, orgId, providers),
  ]);
  const entries = capabilities.map(([provider, read]) => {
    const bound = new Set(
      read.ok ? read.bindings?.filter((b) => b.relation === "current_backend").map((b) => b.goldenId) : [],
    );
    const removed = history.filter(
      (golden) => golden.provider === provider && golden.removed_at && bound.has(golden.id),
    ).length;
    return { provider, state: providerCapacity(history, read, provider), removed };
  });
  const capacities = Object.fromEntries(entries.map(({ provider, state }) => [provider, state]));
  return { history, capabilities: Object.fromEntries(capabilities), capacities, entries };
}

type CapacityRead = ReturnType<typeof readSnapshotCapacity>;

async function SnapshotCapacityNotices({ capacity }: { capacity: CapacityRead }) {
  const { capabilities, history } = await capacity;
  return GOLDEN_PROVIDERS.map((provider) => {
    const read = capabilities[provider];
    if (!read?.ok) return null;
    const reconcile = history.filter(
      (g) =>
        !g.removed_at &&
        g.provider === provider &&
        read.bindings?.some((b) => b.goldenId === g.id && b.relation !== "current_backend"),
    );
    return reconcile.length > 0 ? <LegacyConflict key={provider} provider={provider} goldens={reconcile} /> : null;
  });
}

/**
 * The selected org's golden limit on each connected provider, from the Armada server's `golden/capabilities {org,
 * provider}`. A provider the org has not connected is not read. One read per provider, in parallel, never retried;
 * one provider's failure does not hide the other's answer.
 */
async function allCapabilities(
  serverUrl: string | null,
  token: string | null,
  org: string,
  providers: readonly SandboxProviderId[],
) {
  const read = (provider: SandboxProviderId) =>
    !serverUrl || !token
      ? Promise.resolve({ ok: false as const, reason: "The Armada server is not configured for this dashboard." })
      : readGoldenCapabilities(
          createControlClient({ serverUrl, token, timeoutMs: CAPABILITIES_TIMEOUT_MS }),
          org,
          provider,
        );
  return Promise.all(providers.map(async (provider) => [provider, await read(provider)] as const));
}

/** Visible goldens with a verified current-backend reservation. */

function LegacyConflict({ provider, goldens }: { provider: SandboxProviderId; goldens: GoldenRow[] }) {
  const label = PROVIDER_LABELS[provider];
  return (
    <Alert data-legacy-conflict={provider}>
      <TriangleAlertIcon />
      <AlertTitle>
        {goldens.length} {label} snapshots need backend reconciliation
      </AlertTitle>
      <AlertDescription>
        <p>Armada keeps them all: it does not choose, merge or delete any.</p>
        <ul className="list-inside list-disc">
          {goldens.map((golden) => (
            <li key={golden.id}>
              <span className="font-mono text-xs">{golden.name}</span> ({golden.visibility})
            </li>
          ))}
        </ul>
        <p>
          These live snapshots are unbound or bound to another backend. Ask an operator for deliberate canonical
          adoption or reconciliation before building. Rebuilding does not automatically fix their binding.
        </p>
      </AlertDescription>
    </Alert>
  );
}

type RowContext = {
  orgs: Map<string, Membership>;
  directory: Map<string, string>;
  viewerId: string;
  all: GoldenRow[];
  serverReady: boolean;
  /** The providers the org has connected; a golden launches and rebuilds only on its own. Null: status unavailable. */
  connected: SandboxProviderId[] | null;
  /** Goldens whose rebuild this page tracks in its URL: their form stays to follow the job, even without a provider. */
  rebuildsTracked: Set<string>;
  /** Listed host states, so a draining host reads as draining rather than merely unavailable. */
  hostStates: Map<string, DockerHostState>;
};

type EnvironmentRow = ResourceRow & {
  bucket: Bucket;
  tie: string;
  provider: SandboxProviderId;
  /** The viewer may rebuild it from its panel now. */
  rebuildable: boolean;
};

/** One golden as a row of the list (its state, repositories and one action) and as its panel (everything else). */
function environmentRow(golden: GoldenRow, context: RowContext, now: number): EnvironmentRow {
  if (!isSandboxProvider(golden.provider)) throw new Error("Unsupported snapshot provider.");
  const membership = context.orgs.get(golden.org_id);
  const isAdmin = membership?.role === "admin";
  const row = goldenRowState(golden, context.all, { id: context.viewerId, isAdmin });
  const label = `${PROVIDER_LABELS[golden.provider]} cloud`;
  const canStart = context.connected?.includes(golden.provider) ?? false;
  const readiness = goldenLaunchReadiness({
    provider: golden.provider,
    hasSnapshot: Boolean(golden.provider_snapshot_id),
    serverReady: context.serverReady,
    connected: context.connected,
  });
  const rebuildPaused = !context.serverReady || (!canStart && !context.rebuildsTracked.has(golden.id));
  const rebuildable = !rebuildPaused && row.canRebuild && Boolean(membership);
  const state = environmentState({
    provider: golden.provider,
    readiness,
    providerMissing: context.connected !== null && !canStart,
    buildBlocker: rebuildable ? null : (row.reason ?? "Building is not available from here."),
  });
  const repos = goldenRepos(golden.config);
  const directories = goldenRepositoryDirs(golden.config);
  const sizing = goldenSizing(golden, directories);
  const capacity =
    sizing.kind === "ready" && sizing.policy?.golden ? machineCapacity(golden.provider, sizing.policy.golden) : null;
  const owner = displayUser(context.directory, golden.owner_id, context.viewerId);
  const age = relativeAge(golden.created_at, now);
  const meta = [
    label,
    capacity ? `${capacity.vcpus} vCPU · ${capacity.memoryMiB / 1024} GB` : null,
    golden.visibility === "private" ? "Private" : (membership?.org.name ?? "Organization"),
  ]
    .filter(Boolean)
    .join(" · ");
  const twinLabel = `${golden.name} on ${label}`;

  const buildWarnings = (golden.build_warnings ?? []).flatMap((warning) => {
    if (warning === "skillpack_download_unavailable")
      return [
        {
          reason: warning,
          label: "Skillpack unavailable",
          message:
            "The last build could not download Skillpack. Allow HTTPS access to GitHub releases, then rebuild before using skills.",
        },
      ];
    if (warning === "skillpack_user_local_only")
      return [
        {
          reason: warning,
          label: "User-local Skillpack",
          message:
            "The last build installed Skillpack for the sandbox user only. Skill installation uses the user-local executable; no system launcher was available.",
        },
      ];
    return [];
  });

  const action =
    state.action === "launch" ? (
      <SnapshotLaunchDialog
        golden={golden.name}
        provider={golden.provider}
        orgId={golden.org_id}
        catalog={MODEL_CATALOG}
        repositories={directories}
        templateSource={{ goldens: context.all, goldenId: golden.id }}
        {...(sizing.kind === "ready" ? { sizing: { policy: sizing.policy } } : {})}
      />
    ) : state.action === "snapshot" ? (
      <SelectItem item={golden.id} variant="outline" size="sm" aria-label={`Build ${twinLabel}`}>
        Build
      </SelectItem>
    ) : state.action === "connect" ? (
      <Button variant="outline" size="sm" asChild>
        <Link href={CLOUD_PROVIDERS_PATH} aria-label={`Connect ${label} to launch ${golden.name}`}>
          Connect {PROVIDER_LABELS[golden.provider]}
        </Link>
      </Button>
    ) : null;

  const detail = (
    <div className="space-y-4">
      <div className="space-y-1">
        <StateCell tone={state.tone} label={state.label} />
        <p className="text-sm text-muted-foreground">{state.detail}</p>
        {state.action !== null && state.action !== "snapshot" && <div className="pt-2">{action}</div>}
      </div>
      {buildWarnings.map((warning) => (
        <Alert key={warning.reason} className="border-warning/40" data-golden-build-warning={warning.reason}>
          <TriangleAlertIcon aria-hidden className="text-warning" />
          <AlertTitle>{warning.label}</AlertTitle>
          <AlertDescription>
            <p>{warning.message}</p>
          </AlertDescription>
        </Alert>
      ))}
      <EnvironmentTemplates goldenId={golden.id} provider={golden.provider} />
      <PanelSection title="Repositories">
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository recorded in this snapshot.</p>
        ) : (
          <ul className="space-y-1.5 text-sm" aria-label={`Repositories of ${golden.name} on ${label}`}>
            {repos.map((repo) => (
              <li key={`${repo.url}-${repo.dir}`} className="space-y-0.5">
                <span className="flex items-center gap-1.5 font-mono text-xs">
                  <FolderGit2Icon aria-hidden className="size-3.5 text-muted-foreground" />
                  {repo.slug ?? repo.url}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 pl-5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <GitBranchIcon aria-hidden className="size-3.5" />
                    {repo.branch}
                  </span>
                  {repo.dir && <span className="font-mono">/home/user/{repo.dir}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      {goldenInit(golden.config).length > 0 && (
        <PanelSection title="Setup commands">
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {goldenInit(golden.config).join("\n")}
          </pre>
        </PanelSection>
      )}
      <IdentifierDetails>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Snapshot</dt>
          <dd className="flex min-w-0 items-center gap-1">
            {golden.provider_snapshot_id ? (
              <>
                <span className="truncate font-mono text-xs" title={`${golden.provider} snapshot`}>
                  {golden.provider_snapshot_id}
                </span>
                <CopyButton value={golden.provider_snapshot_id} label={`Copy the snapshot of ${golden.name}`} />
              </>
            ) : (
              <span className="text-muted-foreground">Not snapshotted</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Provider</dt>
          <dd>{label}</dd>
          <dt className="text-muted-foreground">Organization</dt>
          <dd>{membership?.org.name ?? "Unknown"}</dd>
          <dt className="text-muted-foreground">Owner</dt>
          <dd>{owner}</dd>
        </dl>
      </IdentifierDetails>
      {sizing.kind !== "unsupported" && context.serverReady && membership && (
        <PanelSection title="Machine size">
          <SizeDefaults
            goldenId={golden.id}
            orgId={golden.org_id}
            provider={golden.provider}
            directories={directories}
            sizing={sizing}
            blocker={
              sizePolicyBlocker(golden, { id: context.viewerId, isAdmin }) ??
              (row.duplicateName ? "Rename one of the same-name snapshots to change its size defaults." : null)
            }
          />
        </PanelSection>
      )}
      <PanelSection title="Visibility">
        <VisibilityControl golden={golden} viewerId={context.viewerId} isAdmin={isAdmin} />
      </PanelSection>
      <PanelSection title="Rebuild">
        {rebuildPaused ? (
          <p className="text-xs text-muted-foreground" data-rebuild-paused>
            {!context.serverReady
              ? "Rebuilding needs the Armada server."
              : context.connected === null
                ? "Rebuilding paused: provider status unavailable."
                : `Rebuilding needs ${label} connected.`}
          </p>
        ) : rebuildable && membership ? (
          <Disclosure summary="Edit and rebuild" defaultOpen={!golden.provider_snapshot_id}>
            <GoldenForm
              mode="update"
              goldenId={golden.id}
              provider={golden.provider}
              orgId={golden.org_id}
              orgName={membership.org.name}
              isAdmin={isAdmin}
              name={golden.name}
              visibility={golden.visibility}
              defaults={editDefaults(golden)}
              canStart={canStart}
            />
          </Disclosure>
        ) : (
          <p className="text-xs text-muted-foreground" data-rebuild-blocked>
            {row.reason ?? "Rebuilding is not available for this snapshot."}
          </p>
        )}
      </PanelSection>
      {context.serverReady && membership && goldenRemoveBlocker(golden, { id: context.viewerId, isAdmin }) === null && (
        <PanelSection title="Remove">
          <RemoveGolden goldenId={golden.id} orgId={golden.org_id} name={golden.name} providerLabel={label} />
        </PanelSection>
      )}
    </div>
  );

  return {
    catalog: {
      group: golden.provider,
      attention: state.bucket !== "ready",
      footer: [golden.visibility === "private" ? "Only you" : "Organization", age && `created ${age}`]
        .filter(Boolean)
        .join(" · "),
    },
    key: golden.id,
    name: golden.name,
    tie: golden.provider,
    bucket: state.bucket,
    provider: golden.provider,
    rebuildable,
    search: [
      golden.name,
      label,
      golden.visibility === "private" ? "private" : "org",
      ...repos.map((r) => r.slug ?? r.url),
    ].join(" "),
    mark: (
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center [&_svg]:size-8">
        <ProviderMark provider={golden.provider} />
      </span>
    ),
    meta,
    subtitle: meta,
    state: (
      <StateCell
        tone={state.tone}
        label={state.label}
        {...(readiness.kind === "ready" ? {} : { "data-launch-paused": readiness.kind })}
      />
    ),
    fact: (
      <>
        <p>
          {readiness.kind === "ready"
            ? "Ready to launch"
            : state.action === "snapshot"
              ? "Build it once; launches then start from it."
              : state.detail}
        </p>
        {repos.length > 0 && (
          <p className="truncate" title={repos.map((repo) => repo.slug ?? repo.url).join(", ")}>
            {repos[0]?.slug ?? repos[0]?.url}
            {repos.length > 1 ? ` +${repos.length - 1} more` : ""}
          </p>
        )}
      </>
    ),
    action,
    detail,
    attrs: { "data-golden": golden.name, "data-golden-provider": golden.provider },
    panelAttrs: { "data-golden-panel": golden.name, "data-golden-provider": golden.provider },
  };
}

/** Share with the org or make private, for whoever may; otherwise who can. */
function VisibilityControl({ golden, viewerId, isAdmin }: { golden: GoldenRow; viewerId: string; isAdmin: boolean }) {
  const next = golden.visibility === "private" ? "org" : "private";
  const now = golden.visibility === "private" ? "Only you see it." : "Every member of the organization sees it.";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">{now}</p>
      {golden.owner_id !== viewerId ? (
        <span className="text-xs text-muted-foreground">Only its owner changes sharing</span>
      ) : next === "org" && !isAdmin ? (
        <span className="text-xs text-muted-foreground">Org admins share snapshots</span>
      ) : (
        <ActionForm
          action={setGoldenVisibility}
          successToast={
            next === "org" ? `Shared ${golden.name} with the org.` : `${golden.name} is now private to you.`
          }
          className="flex flex-col items-end gap-1"
        >
          <input type="hidden" name="golden" value={golden.id} />
          <input type="hidden" name="visibility" value={next} />
          <SubmitButton variant="outline" size="sm">
            {next === "org" ? "Share with org" : "Make private"}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}

/** The templates of the list as launch choices; one whose revision could not be read is not offered. */
function launchTemplates(
  list: TemplateList,
  goldens: readonly GoldenRow[],
  lookups: TemplateLookups,
): TemplateLaunchTarget[] {
  if (list.state !== "ready") return [];
  return list.items.flatMap((item) => launchTarget(item, goldens, lookups) ?? []);
}

/** Host artifacts use the shared snapshot list and launch dialog, not a second Docker launch surface. */
function dockerSnapshotRow(
  snapshot: DockerSnapshotRecord,
  context: RowContext,
  launchEnabled: boolean,
  currentVersion: string | null,
  canBuild: boolean,
): ResourceRow & { bucket: Bucket; tie: string } {
  const state = snapshotState(snapshot, launchEnabled, context.hostStates.get(snapshot.hostId));
  const canRebuild = snapshotRebuildAvailable(
    snapshot,
    currentVersion,
    { id: context.viewerId, isAdmin: context.orgs.get(snapshot.orgId)?.role === "admin" },
    canBuild,
  );
  const action =
    state.bucket === "ready" ? (
      <SnapshotLaunchDialog
        golden={snapshot.name}
        snapshotId={snapshot.id}
        hostName={snapshot.hostName ?? DOCKER_HOST_LABEL}
        provider="docker"
        orgId={snapshot.orgId}
        catalog={MODEL_CATALOG}
        repositories={[]}
      />
    ) : null;
  const organization = context.orgs.get(snapshot.orgId)?.org.name ?? "Organization";
  const age = relativeAge(snapshot.createdAt, Date.now());
  const scope = snapshot.visibility === "private" ? "only you" : organization;
  const meta = dockerHostGroup(snapshot.hostName, scope);
  const repoSummary = snapshot.config.repos.map((repo) => repo.dir).join(", ") || "No repository";
  const repos = snapshot.config.repos;
  const detailText =
    snapshot.status === "building"
      ? "Repositories and setup are building on this host. Closing this panel does not stop the build."
      : snapshot.status === "failed"
        ? (snapshot.failureReason ?? "The build did not publish a snapshot.")
        : !snapshot.hostAvailable
          ? context.hostStates.get(snapshot.hostId) === "draining"
            ? "The original host is draining for uninstall. Finish or retry the uninstall on the machine; snapshots are local to its installation."
            : "Bring the original registered host online. Snapshots are local to its installation; they are not copied to other hosts."
          : !launchEnabled
            ? "Snapshot launches are unavailable on this server. Check Docker placement and the server version."
            : "Launch the saved workspace on its original host, with your current account and GitHub access.";
  return {
    catalog: {
      group: "docker",
      attention: state.bucket !== "ready",
      footer: snapshot.visibility === "private" ? "Only you" : "Organization",
    },
    key: snapshot.id,
    name: snapshot.name,
    tie: `docker-${snapshot.id}`,
    bucket: state.bucket,
    search: [snapshot.name, meta, snapshot.visibility, ...repos.map((repo) => repo.url)].join(" "),
    mark: (
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center [&_svg]:size-8">
        <ProviderMark provider="docker" />
      </span>
    ),
    meta,
    subtitle: meta,
    state: <StateCell tone={state.tone} label={state.label} />,
    fact: (
      <>
        <p>
          {repoSummary}
          {snapshot.status === "ready" && age ? ` · built ${age}` : ""}
        </p>
        {snapshot.status === "failed" && <p>{detailText}</p>}
        {snapshot.baselineWarning && <p>Developer baseline outdated</p>}
        {canRebuild && <p>A newer Armada version is available. Open it to rebuild.</p>}
      </>
    ),
    action,
    detail: (
      <div className="space-y-4">
        <StateCell tone={state.tone} label={state.label} />
        <p className="text-sm text-muted-foreground">{detailText}</p>
        {snapshot.baselineWarning && <p className="text-sm text-muted-foreground">{snapshot.baselineWarning}</p>}
        {snapshot.status === "failed" && (
          <p className="text-sm text-muted-foreground">
            Check this server and the build configuration, then use New snapshot to create a new build. This failed
            snapshot cannot be rebuilt.
          </p>
        )}
        {action}
        {canRebuild && currentVersion && (
          <PanelSection title="New Armada version available">
            <p className="text-sm text-muted-foreground">
              Rebuild with Armada {currentVersion}. Your saved snapshot remains unchanged.
            </p>
            <SnapshotRebuildDialog
              orgId={snapshot.orgId}
              snapshotId={snapshot.id}
              name={snapshot.name}
              currentVersion={currentVersion}
            />
          </PanelSection>
        )}
        <PanelSection title="Repositories">
          <ul className="space-y-2 text-sm">
            {repos.map((repo) => (
              <li key={repo.dir}>
                <p className="font-mono text-xs break-all">{repo.url}</p>
                <p className="text-xs text-muted-foreground">
                  {repo.branch ?? "default branch"} · /home/user/{repo.dir}
                </p>
              </li>
            ))}
          </ul>
        </PanelSection>
        {snapshot.config.init.length > 0 && (
          <PanelSection title="Setup commands">
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {snapshot.config.init.join("\n")}
            </pre>
          </PanelSection>
        )}
        <PanelSection title="Visibility">
          <p className="text-sm text-muted-foreground">
            {snapshot.visibility === "private"
              ? "Only you may see and launch this snapshot."
              : "Current organization members may launch this snapshot."}{" "}
            Visibility and host are fixed when built.
          </p>
        </PanelSection>
        <IdentifierDetails>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt>Snapshot</dt>
            <dd className="break-all font-mono">{snapshot.id}</dd>
            <dt>Host</dt>
            <dd className="break-all font-mono">{snapshot.hostId}</dd>
            <dt>Armada version</dt>
            <dd>{snapshot.builtOnVersion ?? "Unknown"}</dd>
          </dl>
        </IdentifierDetails>
      </div>
    ),
    attrs: { "data-golden": snapshot.name, "data-golden-provider": "docker" },
  };
}

/** Keep machine identifiers out of the normal reading path, with an aligned ghost disclosure. */
function IdentifierDetails({ children }: { children: import("react").ReactNode }) {
  return (
    <Collapsible className="border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">Technical details</h3>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            Show identifiers
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

type SnapshotLaunchProps = Omit<LaunchProps, "accounts" | "connections" | "templates"> & {
  templateSource?: { goldens: GoldenRow[]; goldenId: string };
};

function SnapshotLaunchDialog(props: SnapshotLaunchProps) {
  return (
    <DeferredLaunch>
      <SnapshotLaunchStart {...props} />
    </DeferredLaunch>
  );
}
async function SnapshotLaunchStart({ templateSource, ...props }: SnapshotLaunchProps) {
  const [connections, accounts, templates, boatOptions] = await Promise.all([
    readSnapshotConnections(),
    readSnapshotAccounts(),
    templateSource ? readSnapshotTemplateChoices(templateSource.goldens) : [],
    props.provider === "boat" ? readLaunchOptions() : null,
  ]);
  return (
    <EnvironmentLaunchDialog>
      <LaunchStart
        {...props}
        connections={connections}
        accounts={accounts}
        templates={
          templateSource ? templates.filter((template) => template.definition.goldenId === templateSource.goldenId) : []
        }
        boatOpenCodeAvailable={boatOptions !== null && boatOpenCodeAvailable(boatOptions)}
        dockerLimits={<DockerLaunchLimitList />}
      />
    </EnvironmentLaunchDialog>
  );
}

function DeferredLaunch({ children }: { children: import("react").ReactNode }) {
  return (
    <Suspense
      fallback={
        <Button variant="outline" size="sm" disabled>
          Loading launch options…
        </Button>
      }
    >
      {children}
    </Suspense>
  );
}

function EnvironmentLaunchDialog({ children }: { children: import("react").ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Launch
        </Button>
      </DialogTrigger>
      <LaunchDialogContent>{children}</LaunchDialogContent>
    </Dialog>
  );
}
