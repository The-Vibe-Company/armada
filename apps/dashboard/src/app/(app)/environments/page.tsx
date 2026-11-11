import { type Golden, MODEL_CATALOG, type SandboxProviderId } from "@armada/core";
import {
  CircleCheckIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  LayersIcon,
  LockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Fragment } from "react";
import { setGoldenVisibility } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { Disclosure } from "@/components/disclosure";
import { GoldenCreateDialog } from "@/components/golden-create-dialog";
import { GoldenForm } from "@/components/golden-form";
import { type LaunchConnections, LaunchDialog } from "@/components/launch-dialog";
import { Empty } from "@/components/page-header";
import { ProviderMark } from "@/components/provider-mark";
import { RemoveGolden } from "@/components/remove-golden";
import { ResourceBrowser, type ResourceRow, SelectItem } from "@/components/resource-browser";
import { SizeDefaults } from "@/components/size-defaults";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { isUuid } from "@/lib/action";
import {
  CAPABILITIES_TIMEOUT_MS,
  createControlClient,
  type GoldenCapabilities,
  readGoldenCapabilities,
} from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { getGitHubConnection } from "@/lib/data/github";
import { findRemovedGolden, type GoldenRow, listGoldenHistory, listGoldens } from "@/lib/data/goldens";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listSelectedTemplates, lookupsFrom, type TemplateList } from "@/lib/data/templates";
import { listSelectedVault } from "@/lib/data/variables";
import { displayUser, listMemberships, type Membership, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  boatFull,
  capacityParts,
  type EnvironmentState,
  environmentBlockers,
  environmentState,
} from "@/lib/environments";
import {
  type CapacityState,
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
import { goldenSizing, sizePolicyBlocker } from "@/lib/machine-size";
import type { LaunchAccounts } from "@/lib/model-accounts";
import { connectedProviders, PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { relativeAge } from "@/lib/relative-time";
import { goldenRepositoryDirs } from "@/lib/repository-context";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { createClient } from "@/lib/supabase/server";
import { launchTarget, type TemplateLaunchTarget } from "@/lib/template-launch";
import type { TemplateLookups } from "@/lib/templates";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Environments" };
export const dynamic = "force-dynamic";
// The create and rebuild server actions run in this route's function and wait for the server's build (up to
// GOLDEN_BUILD_TIMEOUT_MS). This is the same bound as `/api/v1/*`, so the fetch times out before the function.
export const maxDuration = 800;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function GoldensPage({ searchParams }: Props) {
  const query = await searchParams;
  const removedParam = query.removed;
  const viewer = await requireViewer();
  const supabase = await createClient();
  // The confirmation after a removal: only for a golden of this org the database records as removed, named from it.
  const removed =
    typeof removedParam === "string" && isUuid(removedParam) ? await findRemovedGolden(supabase, removedParam) : null;
  const selected = await selectedOrganization();
  // New builds, rebuilds and launches run on a provider the organization has connected (#598): exactly that one, never
  // another. Existing goldens and builds the page already tracks stay manageable without it; an org with neither is
  // sent to Settings to connect one. Null: the status could not be read, a retryable error rather than "none".
  const setup = selected ? await readProviderSetup(selected.org.id) : null;
  const setupPending = selected !== null && setup?.state === "pending";
  const connected = setup && setup.state !== "unavailable" ? connectedProviders(setup.status) : null;
  const canStart = (connected?.length ?? 0) > 0;
  const tracked = (scope: string) => query[`build.${scope}`] !== undefined || query[`build-key.${scope}`] !== undefined;
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const serverUrl = mcpUrl();
  const [goldens, history, memberships, directory, github, capabilities, listed, accountList, templateList, vault] =
    await Promise.all([
      listGoldens(supabase),
      listGoldenHistory(supabase),
      pending,
      pending.then((items) =>
        memberDirectory(
          supabase,
          items.map((item) => item.org.id),
        ),
      ),
      getGitHubConnection(supabase).catch(() => null),
      selected ? allCapabilities(serverUrl, viewer.token, selected.org.id, connected ?? []) : null,
      listSelectedConnections(),
      listSelectedAccounts(),
      listSelectedTemplates(),
      listSelectedVault(),
    ]);
  const connections: LaunchConnections =
    listed.state === "ready"
      ? { connections: listed.connections }
      : { unavailable: listed.state === "error" ? listed.message : "The Armada server is not configured." };
  const accounts = launchAccounts(accountList, Date.now());
  const templates = launchTemplates(templateList, goldens, lookupsFrom(goldens, listed, vault));
  const createTracked = selected !== null && tracked(`create.${selected.org.id}`);
  const rebuildsTracked = new Set(
    goldens.filter((golden) => tracked(`rebuild.${golden.id}`)).map((golden) => golden.id),
  );
  if (setupPending && goldens.length === 0 && !createTracked && rebuildsTracked.size === 0)
    redirect(PROVIDER_SETTINGS_PATH);
  const orgs = new Map(memberships.map((item) => [item.org.id, item]));
  // Usage comes only from caller-visible server bindings, never historical row counts.
  const capacities = capabilities
    ? (Object.fromEntries(
        Object.entries(capabilities).map(([provider, read]) => [
          provider,
          providerCapacity(history, read, provider as SandboxProviderId),
        ]),
      ) as Partial<Record<SandboxProviderId, CapacityState>>)
    : null;
  const counts = Object.fromEntries(
    GOLDEN_PROVIDERS.map((provider) => {
      const read = capabilities?.[provider];
      const bound = new Set(
        read?.ok ? read.bindings?.filter((b) => b.relation === "current_backend").map((b) => b.goldenId) : [],
      );
      const rows = history.filter((golden) => golden.provider === provider && bound.has(golden.id));
      const removed = rows.filter((golden) => golden.removed_at).length;
      return [provider, { live: rows.length - removed, removed }];
    }),
  ) as Record<SandboxProviderId, SlotCounts>;
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
    connections,
    accounts,
    templates,
  };

  const now = Date.now();
  const rows = sortResources(goldens.map((golden) => environmentRow(golden, context, now)));
  const providerPending = setupPending && selected !== null;
  const blockers = environmentBlockers({ providerPending, rows: rows.map((row) => ({ ...row, state: row.status })) });
  // Without a confirmed provider the create form is shown only to follow a build this page already tracks.
  // A build the page tracks reopens the dialog, which follows it.
  const create =
    selected && capacities && (canStart || createTracked) ? (
      <GoldenCreateDialog orgId={selected.org.id} initialOpen={createTracked}>
        <CreatePanel
          org={selected}
          providers={connected ?? []}
          capacities={capacities}
          boatLive={counts.boat.live}
          serverReady={serverReady}
          githubConnected={githubConnected}
          rebuildable={rows.filter((row) => row.provider === "boat" && row.rebuildable)}
        />
      </GoldenCreateDialog>
    ) : undefined;
  const parts =
    selected && capacities
      ? capacityParts(
          (connected ?? []).flatMap((provider) => {
            const state = capacities[provider];
            return state ? [{ provider, state, removed: counts[provider].removed }] : [];
          }),
        )
      : [];
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;
  const initial =
    requested ?? (createTracked ? null : (goldens.find((golden) => rebuildsTracked.has(golden.id))?.id ?? null));

  const notices = (
    <>
      {setup?.state === "unavailable" && (
        <Alert variant="destructive" data-setup-state="unavailable">
          <TriangleAlertIcon />
          <AlertTitle>Provider status unavailable</AlertTitle>
          <AlertDescription>
            <p>{setup.message}</p>
            {/* A document request, not a client navigation: the router would reuse its cached render (staleTimes). */}
            <a className="underline underline-offset-4" href="/environments">
              Check again
            </a>
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
      {selected &&
        capacities &&
        GOLDEN_PROVIDERS.map((provider) => {
          const read = capabilities?.[provider];
          const reconcile = history.filter(
            (g) =>
              !g.removed_at &&
              g.provider === provider &&
              read?.ok &&
              read.bindings?.some((b) => b.goldenId === g.id && b.relation !== "current_backend"),
          );
          return reconcile.length > 0 ? (
            <LegacyConflict key={provider} provider={provider} goldens={reconcile} />
          ) : null;
        })}
    </>
  );

  return (
    <ResourceBrowser
      title="Environments"
      description="Goldens: what a sandbox contains when it starts."
      meta={goldens.length > 0 ? goldens.length : undefined}
      label="Environments"
      rows={rows}
      blockers={blockers}
      notices={notices}
      initial={initial}
      {...(create ? { actions: create } : {})}
      footer={
        parts.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-capacity-summary>
            {parts.map((part, index) => (
              <Fragment key={part.provider}>
                {index > 0 && <span aria-hidden> · </span>}
                <span
                  data-capacity={part.kind}
                  data-capacity-provider={part.provider}
                  data-capacity-removed={counts[part.provider].removed}
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
        ) : null
      }
      empty={
        selected ? (
          <Empty title="No environments yet" icon={<LayersIcon />}>
            {create
              ? "Use New to build the first one: the repositories an agent starts with, saved as a snapshot."
              : "Connect a sandbox provider to build the first one."}
          </Empty>
        ) : (
          <Empty title="No organization">
            <Link className="underline underline-offset-4" href="/orgs">
              Create or join an organization
            </Link>{" "}
            to build environments.
          </Empty>
        )
      }
    />
  );
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
): Promise<Partial<Record<SandboxProviderId, GoldenCapabilities>>> {
  const read = (provider: SandboxProviderId): Promise<GoldenCapabilities> =>
    !serverUrl || !token
      ? Promise.resolve({ ok: false, reason: "The Armada server is not configured for this dashboard." })
      : readGoldenCapabilities(
          createControlClient({ serverUrl, token, timeoutMs: CAPABILITIES_TIMEOUT_MS }),
          org,
          provider,
        );
  return Object.fromEntries(
    await Promise.all(providers.map(async (provider) => [provider, await read(provider)] as const)),
  );
}

/** Visible goldens with a verified current-backend reservation. */
type SlotCounts = { live: number; removed: number };

function LegacyConflict({ provider, goldens }: { provider: SandboxProviderId; goldens: GoldenRow[] }) {
  const label = PROVIDER_LABELS[provider];
  return (
    <Alert data-legacy-conflict={provider}>
      <TriangleAlertIcon />
      <AlertTitle>
        {goldens.length} {label} goldens need backend reconciliation
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
          These live goldens are unbound or bound to another backend. Ask an operator for deliberate canonical adoption
          or reconciliation before building. Rebuilding does not automatically fix their binding.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The create form, in the dialog the New button opens. When Boat is full it says so first and points at the
 * environments the viewer can rebuild instead; the form stays a click away (Modal, or a slot freed meanwhile).
 */
function CreatePanel({
  org,
  capacities,
  boatLive,
  serverReady,
  githubConnected,
  providers,
  rebuildable,
}: {
  org: Membership;
  /** The providers the org has connected, where a new golden may be built; none: the form only follows a tracked build. */
  providers: SandboxProviderId[];
  capacities: Partial<Record<SandboxProviderId, CapacityState>>;
  /** Live Boat goldens visible here; the Boat slot may instead be held by a removed one. */
  boatLive: number;
  serverReady: boolean;
  githubConnected: boolean;
  /** The Boat environments this viewer may rebuild, offered instead of a new one when Boat is full. */
  rebuildable: EnvironmentRow[];
}) {
  const discouraged = boatFull(capacities);
  const modalOpen = capacities.modal !== undefined && capacities.modal.kind !== "unavailable";
  if (!serverReady)
    return (
      <p className="text-sm text-muted-foreground">
        The Armada server is not configured: goldens cannot be built here.
      </p>
    );
  return (
    <div className="space-y-3" data-create-golden={discouraged ? "discouraged" : "open"}>
      {discouraged && (
        <Alert className="border-warning/40" data-boat-full>
          <LayersIcon className="text-warning" />
          <AlertTitle>Boat is full</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {boatLive > 0
                ? `Every Boat slot is used. Rebuild an existing environment with new repositories instead${modalOpen ? ", or build on Modal" : ""}.`
                : `A removed Boat environment holds the slot${modalOpen ? ": build on Modal" : ""}.`}
            </p>
            {boatLive > 0 && rebuildable.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {rebuildable.map((row) => (
                  <li key={row.key}>
                    {/* Closes the dialog and opens the environment's panel, where it is rebuilt. */}
                    <DialogClose asChild>
                      <span>
                        <SelectItem item={row.key} variant="outline" size="sm" className="h-7">
                          Rebuild {row.name}
                        </SelectItem>
                      </span>
                    </DialogClose>
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      {!githubConnected && (
        <Alert className="py-2">
          <InfoIcon />
          <AlertTitle className="flex flex-wrap gap-x-2">
            GitHub is not connected
            <Link className="font-normal underline underline-offset-4" href="/settings">
              Connect GitHub in Settings
            </Link>
          </AlertTitle>
        </Alert>
      )}
      <Disclosure summary="Show the create form" defaultOpen={!discouraged} quiet={!discouraged}>
        <GoldenForm
          mode="create"
          orgId={org.org.id}
          orgName={org.org.name}
          isAdmin={org.role === "admin"}
          capacities={capacities}
          providers={providers}
          canStart={providers.length > 0}
        />
      </Disclosure>
    </div>
  );
}

type RowContext = {
  orgs: Map<string, Membership>;
  directory: Map<string, string>;
  viewerId: string;
  all: Golden[];
  serverReady: boolean;
  /** The providers the org has connected; a golden launches and rebuilds only on its own. Null: status unavailable. */
  connected: SandboxProviderId[] | null;
  /** Goldens whose rebuild this page tracks in its URL: their form stays to follow the job, even without a provider. */
  rebuildsTracked: Set<string>;
  connections: LaunchConnections;
  accounts: LaunchAccounts;
  /** Every template the viewer can launch, with the environment each starts from. */
  templates: readonly TemplateLaunchTarget[];
};

type EnvironmentRow = ResourceRow & {
  bucket: Bucket;
  tie: string;
  provider: SandboxProviderId;
  status: EnvironmentState;
  /** The viewer may rebuild it from its panel now. */
  rebuildable: boolean;
};

/** One golden as a row of the list (its state, repositories and one action) and as its panel (everything else). */
function environmentRow(golden: Golden, context: RowContext, now: number): EnvironmentRow {
  const membership = context.orgs.get(golden.org_id);
  const isAdmin = membership?.role === "admin";
  const row = goldenRowState(golden, context.all, { id: context.viewerId, isAdmin });
  const label = PROVIDER_LABELS[golden.provider];
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
  const owner = displayUser(context.directory, golden.owner_id, context.viewerId);
  const age = relativeAge(golden.created_at, now);
  const meta = [label, owner === "You" ? "yours" : `by ${owner}`, age].filter(Boolean).join(" · ");
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
      <LaunchDialog
        golden={golden.name}
        provider={golden.provider}
        orgId={golden.org_id}
        catalog={MODEL_CATALOG}
        repositories={directories}
        connections={context.connections}
        accounts={context.accounts}
        templates={context.templates.filter((template) => template.definition.goldenId === golden.id)}
        {...(sizing.kind === "ready" ? { sizing: { policy: sizing.policy } } : {})}
      />
    ) : state.action === "snapshot" ? (
      <SelectItem item={golden.id} size="sm" aria-label={`Snapshot ${twinLabel}`}>
        Snapshot
      </SelectItem>
    ) : state.action === "connect" ? (
      <Button variant="outline" size="sm" asChild>
        <Link href={PROVIDER_SETTINGS_PATH} aria-label={`Connect ${label} to launch ${golden.name}`}>
          Connect {label}
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
            <code className="text-xs">{warning.reason}</code>
          </AlertDescription>
        </Alert>
      ))}
      <PanelSection title="Repositories">
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository recorded in this golden.</p>
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
        <PanelSection title="Init commands">
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {goldenInit(golden.config).join("\n")}
          </pre>
        </PanelSection>
      )}
      <PanelSection title="Details">
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
      </PanelSection>
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
              (row.duplicateName ? "Rename one of the same-name goldens to change its size defaults." : null)
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
            {row.reason ?? "Rebuilding is not available for this golden."}
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
    key: golden.id,
    name: golden.name,
    tie: golden.provider,
    bucket: state.bucket,
    provider: golden.provider,
    status: state,
    rebuildable,
    search: [
      golden.name,
      label,
      golden.visibility === "private" ? "private" : "org",
      ...repos.map((r) => r.slug ?? r.url),
    ].join(" "),
    mark: (
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background [&_svg]:size-4"
      >
        <ProviderMark provider={golden.provider} />
      </span>
    ),
    tags: (
      <>
        <RowTag>
          {golden.visibility === "private" ? <LockIcon aria-hidden /> : <GlobeIcon aria-hidden />}
          {golden.visibility === "private" ? "Private" : "Org"}
        </RowTag>
        {buildWarnings.map((warning) => (
          <RowTag key={warning.reason} className="border-warning/40 text-warning" title={warning.message}>
            <TriangleAlertIcon aria-hidden /> {warning.label}
          </RowTag>
        ))}
        {row.duplicateName && (
          <RowTag className="border-warning/40 text-warning">
            <TriangleAlertIcon aria-hidden /> Name shared by another golden
          </RowTag>
        )}
      </>
    ),
    meta,
    subtitle: meta,
    state: (
      <StateCell
        tone={state.tone}
        label={state.label}
        detail={state.detail}
        {...(readiness.kind === "ready" ? {} : { "data-launch-paused": readiness.kind })}
      />
    ),
    fact:
      repos.length === 0 ? (
        <span className="text-muted-foreground">No repository</span>
      ) : (
        <span className="font-mono text-xs" title={repos.map((r) => r.slug ?? r.url).join(", ")}>
          {repos.map((r) => r.slug ?? r.url).join(", ")}
        </span>
      ),
    action,
    detail,
    attrs: { "data-golden": golden.name, "data-golden-provider": golden.provider },
    panelAttrs: { "data-golden-panel": golden.name, "data-golden-provider": golden.provider },
  };
}

/** Share with the org or make private, for whoever may; otherwise who can. */
function VisibilityControl({ golden, viewerId, isAdmin }: { golden: Golden; viewerId: string; isAdmin: boolean }) {
  const next = golden.visibility === "private" ? "org" : "private";
  const now = golden.visibility === "private" ? "Only you see it." : "Every member of the organization sees it.";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">{now}</p>
      {golden.owner_id !== viewerId ? (
        <span className="text-xs text-muted-foreground">Only its owner changes sharing</span>
      ) : next === "org" && !isAdmin ? (
        <span className="text-xs text-muted-foreground">Org admins share goldens</span>
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
