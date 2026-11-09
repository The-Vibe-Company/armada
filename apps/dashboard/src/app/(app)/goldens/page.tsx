import { type Golden, MODEL_CATALOG, type SandboxProviderId } from "@armada/core";
import {
  CircleCheckIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { setGoldenVisibility } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Disclosure } from "@/components/disclosure";
import { GoldenForm } from "@/components/golden-form";
import { type LaunchConnections, LaunchDialog } from "@/components/launch-dialog";
import { Empty, PageHeader, SectionHeader } from "@/components/page-header";
import { RemoveGolden } from "@/components/remove-golden";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, type Membership, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  type CapacityState,
  editDefaults,
  GOLDEN_PROVIDERS,
  goldenInit,
  goldenRemoveBlocker,
  goldenRepos,
  goldenRowState,
  PROVIDER_LABELS,
  providerCapacity,
} from "@/lib/golden-form";
import { goldenRepositoryDirs } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Goldens" };
export const dynamic = "force-dynamic";
// The create and rebuild server actions run in this route's function and wait for the server's build (up to
// GOLDEN_BUILD_TIMEOUT_MS). This is the same bound as `/api/v1/*`, so the fetch times out before the function.
export const maxDuration = 800;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function GoldensPage({ searchParams }: Props) {
  const removedParam = (await searchParams).removed;
  const viewer = await requireViewer();
  const supabase = await createClient();
  // The confirmation after a removal: only for a golden of this org the database records as removed, named from it.
  const removed =
    typeof removedParam === "string" && isUuid(removedParam) ? await findRemovedGolden(supabase, removedParam) : null;
  const selected = await selectedOrganization();
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const serverUrl = mcpUrl();
  const [goldens, history, memberships, directory, github, capabilities, listed] = await Promise.all([
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
    selected ? allCapabilities(serverUrl, viewer.token, selected.org.id) : null,
    listSelectedConnections(),
  ]);
  const connections: LaunchConnections =
    listed.state === "ready"
      ? { connections: listed.connections }
      : { unavailable: listed.state === "error" ? listed.message : "The Armada server is not configured." };
  const orgs = new Map(memberships.map((item) => [item.org.id, item]));
  const mine = goldens.filter((golden) => golden.visibility === "private");
  const shared = goldens.filter((golden) => golden.visibility === "org");
  // Read on the server with the session; only the resulting number (or why it is missing) reaches the page. A removed
  // golden keeps its provider slot (#566), so the count is of every golden this viewer can read, removed ones included;
  // the lists, launch and actions below use the live goldens only.
  const capacities = capabilities
    ? (Object.fromEntries(
        GOLDEN_PROVIDERS.map((provider) => [provider, providerCapacity(history, capabilities[provider], provider)]),
      ) as Record<SandboxProviderId, CapacityState>)
    : null;
  const counts = Object.fromEntries(
    GOLDEN_PROVIDERS.map((provider) => {
      const rows = history.filter((golden) => golden.provider === provider);
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
    connections,
  };

  const build =
    selected && capacities ? (
      <section className="space-y-3" aria-labelledby="build-golden-title">
        <SectionHeader
          id="build-golden-title"
          title="Build a golden"
          description={`Goldens are built on the Armada server for ${selected.org.name}, one provider at a time.`}
        />
        <div className="grid gap-3 md:grid-cols-2">
          {GOLDEN_PROVIDERS.map((provider) => (
            <CapacityCard key={provider} provider={provider} state={capacities[provider]} counts={counts[provider]} />
          ))}
        </div>
        <CreateCard
          org={selected}
          capacities={capacities}
          boatLive={counts.boat.live}
          serverReady={serverReady}
          githubConnected={githubConnected}
        />
      </section>
    ) : (
      <Empty title="No organization">
        <Link className="underline underline-offset-4" href="/orgs">
          Create or join an organization
        </Link>{" "}
        to build goldens.
      </Empty>
    );
  const lists = (
    <>
      <Section
        id="private-goldens"
        title="Private goldens"
        description="Only you see these."
        empty="No private goldens. A golden you build as Only me appears here."
        goldens={mine}
        context={context}
      />
      <Section
        id="org-goldens"
        title={selected ? `Shared with ${selected.org.name}` : "Shared with your orgs"}
        description="Every member sees these. Only an org admin changes them."
        empty="No shared goldens yet."
        goldens={shared}
        context={context}
      />
    </>
  );

  return (
    <>
      <PageHeader
        title="Goldens"
        description="A golden is a saved snapshot of your repositories. Every sandbox starts from one: pick a golden and launch an agent on it."
      />
      {removed && (
        <Alert role="status" data-golden-removed className="border-success/40">
          <CircleCheckIcon className="text-success" />
          <AlertTitle>Removed {removed.name}</AlertTitle>
          <AlertDescription>
            New sandboxes can no longer start from it. The sandboxes it started, with their conversations and logs, are
            still on the Sandboxes page. It still counts toward the provider&apos;s golden limit.
          </AlertDescription>
        </Alert>
      )}
      {selected &&
        capacities &&
        GOLDEN_PROVIDERS.map((provider) => {
          const state = capacities[provider];
          return state.kind === "legacy" ? (
            <LegacyConflict
              key={provider}
              provider={provider}
              capacity={state.capacity}
              goldens={history.filter((g) => g.provider === provider)}
            />
          ) : null;
        })}
      {/* Keyed, so the first golden moving the build section below the lists keeps the create form's build state. */}
      {(goldens.length === 0 ? ["build", "lists"] : ["lists", "build"]).map((part) => (
        <Fragment key={part}>{part === "build" ? build : lists}</Fragment>
      ))}
    </>
  );
}

/**
 * The selected org's golden limit on each provider, from the Armada server's `golden/capabilities {org, provider}`.
 * One read per provider, in parallel, never retried; one provider's failure does not hide the other's answer.
 */
async function allCapabilities(
  serverUrl: string | null,
  token: string | null,
  org: string,
): Promise<Record<SandboxProviderId, GoldenCapabilities>> {
  const read = (provider: SandboxProviderId): Promise<GoldenCapabilities> =>
    !serverUrl || !token
      ? Promise.resolve({ ok: false, reason: "The Armada server is not configured for this dashboard." })
      : readGoldenCapabilities(
          createControlClient({ serverUrl, token, timeoutMs: CAPABILITIES_TIMEOUT_MS }),
          org,
          provider,
        );
  const [boat, modal] = await Promise.all([read("boat"), read("modal")]);
  return { boat, modal };
}

/** Visible goldens of one provider holding a slot: live ones, and removed ones, which keep theirs (#566). */
type SlotCounts = { live: number; removed: number };

function CapacityCard({
  provider,
  state,
  counts,
}: {
  provider: SandboxProviderId;
  state: CapacityState;
  counts: SlotCounts;
}) {
  const label = PROVIDER_LABELS[provider];
  const counted = state.kind !== "unavailable" && state.kind !== "unknown";
  return (
    <Card
      className="gap-2 py-4 shadow-none"
      aria-labelledby={`${provider}-capacity-title`}
      data-capacity={state.kind}
      data-capacity-provider={provider}
      data-capacity-removed={counts.removed}
    >
      <CardHeader className="px-4">
        <CardTitle
          id={`${provider}-capacity-title`}
          role="heading"
          aria-level={3}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" aria-hidden /> {label} golden capacity
          </span>
          {counted && (
            <span className={state.kind === "available" ? "text-success" : "text-warning"}>
              {state.used} of {state.capacity}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 px-4 text-sm">
        {counted && (
          <p>
            {state.kind === "available"
              ? "You can build a golden."
              : state.kind === "full"
                ? counts.live > 0
                  ? "Edit and rebuild the existing golden rather than creating another."
                  : "The slot is held by a removed golden."
                : "More rows than the limit: these predate it. See above."}{" "}
            <span className="text-muted-foreground">
              Counted from the goldens visible to you in this organization
              {counts.removed > 0
                ? `, including ${counts.removed === 1 ? "one removed golden" : `${counts.removed} removed goldens`}: removing a golden does not free its slot.`
                : "."}
            </span>
          </p>
        )}
        <p className="text-muted-foreground">
          {state.kind === "unavailable"
            ? `Capacity unavailable: the Armada server could not report this organization's ${label} golden limit. The server still checks it when it builds.`
            : state.kind === "unknown"
              ? `The Armada server reports no golden limit for this organization's ${label} backend.`
              : `The Armada server reports that this organization's ${label} backend holds ${state.capacity === 1 ? "one golden" : `${state.capacity} goldens`}. The server checks that limit when it builds; this page only reflects it.`}
        </p>
        {state.kind === "unavailable" && (
          <p className="text-muted-foreground" data-capacity-reason>
            {state.reason}
          </p>
        )}
        {counted && (
          <p className="text-xs text-muted-foreground">
            Private goldens of other members and goldens of other organizations sharing the {label} account are not
            counted here, so the server may still refuse a new build.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LegacyConflict({
  provider,
  capacity,
  goldens,
}: {
  provider: SandboxProviderId;
  capacity: number;
  goldens: GoldenRow[];
}) {
  const label = PROVIDER_LABELS[provider];
  return (
    <Alert data-legacy-conflict={provider}>
      <TriangleAlertIcon />
      <AlertTitle>
        {goldens.length} {label} goldens predate the {capacity === 1 ? "one" : String(capacity)}-golden limit
      </AlertTitle>
      <AlertDescription>
        <p>
          Armada keeps every one of these rows and their access rules. This dashboard does not choose, merge or delete
          any of them, and it does not mark one as active.
        </p>
        <ul className="list-inside list-disc">
          {goldens.map((golden) => (
            <li key={golden.id}>
              <span className="font-mono text-xs">{golden.name}</span> ({golden.visibility}
              {golden.removed_at ? ", removed: still holds its slot" : ""})
            </li>
          ))}
        </ul>
        <p>
          Rebuild the golden you want to keep. The server may refuse a rebuild or a new build while the {label}{" "}
          account's slot is held by another row; resolving that needs the server's operators.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function CreateCard({
  org,
  capacities,
  boatLive,
  serverReady,
  githubConnected,
}: {
  org: Membership;
  capacities: Record<SandboxProviderId, CapacityState>;
  /** Live Boat goldens visible here; the Boat slot may instead be held by a removed one. */
  boatLive: number;
  serverReady: boolean;
  githubConnected: boolean;
}) {
  // The form starts on Boat, whose account holds a limited number of goldens.
  const boat = capacities.boat;
  const discouraged = boat.kind === "full" || boat.kind === "legacy";
  const modalOpen = capacities.modal.kind !== "unavailable";
  const body = (
    <div className="space-y-4">
      {!githubConnected && (
        <Alert>
          <InfoIcon />
          <AlertTitle>GitHub is not connected</AlertTitle>
          <AlertDescription>
            <p>
              The server clones with your own GitHub connection.{" "}
              <Link className="underline underline-offset-4" href="/settings">
                Connect GitHub in Settings
              </Link>{" "}
              first, or the build is refused.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {discouraged &&
        (boatLive > 0 ? (
          <p className="text-sm text-muted-foreground">
            A Boat golden already exists here. Creating another Boat golden is likely to be refused by the server;
            prefer <span className="font-medium text-foreground">Edit and rebuild</span> on the existing golden above
            {modalOpen ? ", or choose Modal as the provider." : "."}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            A removed Boat golden still holds this organization&apos;s Boat slot: removing a golden does not free it.
            Creating another Boat golden is likely to be refused by the server
            {modalOpen ? "; choose Modal as the provider instead." : "."}
          </p>
        ))}
      <GoldenForm
        mode="create"
        orgId={org.org.id}
        orgName={org.org.name}
        isAdmin={org.role === "admin"}
        capacities={capacities}
      />
    </div>
  );
  return (
    <Card className="gap-4" aria-labelledby="create-golden-title">
      <CardHeader>
        <CardTitle id="create-golden-title" role="heading" aria-level={3}>
          {discouraged ? "Create another golden" : "Create a golden"}
        </CardTitle>
        <CardDescription>
          The Armada server clones each repository over your GitHub connection in a disposable builder, scans it for
          leaked tokens and saves a snapshot. No token reaches this browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!serverReady ? (
          <p className="text-sm text-muted-foreground">
            The Armada server is not configured for this dashboard (ARMADA_MCP_URL), so goldens cannot be built here.
          </p>
        ) : (
          <Disclosure summary="Show the create form" defaultOpen={!discouraged}>
            {body}
          </Disclosure>
        )}
      </CardContent>
    </Card>
  );
}

type RowContext = {
  orgs: Map<string, Membership>;
  directory: Map<string, string>;
  viewerId: string;
  all: Golden[];
  serverReady: boolean;
  connections: LaunchConnections;
};

function Section({
  id,
  title,
  description,
  empty,
  goldens,
  context,
}: {
  id: string;
  title: string;
  description: string;
  empty: string;
  goldens: Golden[];
  context: RowContext;
}) {
  return (
    <section className="space-y-3" aria-labelledby={`${id}-title`}>
      <SectionHeader id={`${id}-title`} title={title} description={description} />
      {goldens.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        // One group per provider: a golden lives on one provider for good, and a name may exist on each.
        GOLDEN_PROVIDERS.map((provider) => {
          const group = goldens.filter((golden) => golden.provider === provider);
          if (group.length === 0) return null;
          return (
            <div key={provider} className="space-y-2" data-golden-group={provider}>
              <h3 id={`${id}-${provider}`} className="text-xs font-medium text-muted-foreground">
                On {PROVIDER_LABELS[provider]}
              </h3>
              <ul className="space-y-3" aria-labelledby={`${id}-${provider}`}>
                {group.map((golden) => (
                  <GoldenCard key={golden.id} golden={golden} context={context} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function GoldenCard({ golden, context }: { golden: Golden; context: RowContext }) {
  const membership = context.orgs.get(golden.org_id);
  const isOwner = golden.owner_id === context.viewerId;
  const isAdmin = membership?.role === "admin";
  const next = golden.visibility === "private" ? "org" : "private";
  const repos = goldenRepos(golden.config);
  const init = goldenInit(golden.config);
  const state = goldenRowState(golden, context.all, { id: context.viewerId, isAdmin });
  const removeBlocker = goldenRemoveBlocker(golden, { id: context.viewerId, isAdmin });
  const titleId = `golden-${golden.id}`;
  return (
    <li
      data-golden={golden.name}
      data-golden-provider={golden.provider}
      aria-labelledby={titleId}
      className="rounded-lg border bg-card shadow-xs"
    >
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id={titleId} className="font-semibold">
              {golden.name}
            </h4>
            <Badge variant={golden.visibility === "private" ? "secondary" : "outline"} className="gap-1">
              {golden.visibility === "private" ? <LockIcon className="size-3" /> : <GlobeIcon className="size-3" />}
              {golden.visibility === "private" ? "Private" : "Org"}
            </Badge>
            <Badge variant="outline">{PROVIDER_LABELS[golden.provider]}</Badge>
            {state.duplicateName && (
              <Badge variant="outline" className="gap-1 border-warning text-warning">
                <TriangleAlertIcon className="size-3" /> Name shared by another golden
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Snapshot</dt>
            <dd className="min-w-0 truncate">
              {golden.provider_snapshot_id ? (
                <span className="font-mono text-xs" title={`${golden.provider} snapshot`}>
                  {golden.provider}: {golden.provider_snapshot_id}
                </span>
              ) : (
                <span className="text-muted-foreground">Not snapshotted</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Organization</dt>
            <dd>{membership?.org.name ?? "Unknown"}</dd>
            <dt className="text-muted-foreground">Owner</dt>
            <dd>{displayUser(context.directory, golden.owner_id, context.viewerId)}</dd>
          </dl>
        </div>
        <div className="flex flex-wrap items-start gap-2 lg:justify-end">
          {golden.provider_snapshot_id && context.serverReady ? (
            <LaunchDialog
              golden={golden.name}
              provider={golden.provider}
              orgId={golden.org_id}
              catalog={MODEL_CATALOG}
              repositories={goldenRepositoryDirs(golden.config)}
              goldenVisibility={golden.visibility}
              connections={context.connections}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {golden.provider_snapshot_id
                ? "Launch needs the Armada server"
                : "Launch needs a snapshot: build it first"}
            </span>
          )}
          {!isOwner ? (
            <span className="text-xs text-muted-foreground">Only its owner changes sharing</span>
          ) : next === "org" && !isAdmin ? (
            <span className="text-xs text-muted-foreground">Org admins share goldens</span>
          ) : (
            <ActionForm action={setGoldenVisibility} className="flex flex-col items-end gap-1">
              <input type="hidden" name="golden" value={golden.id} />
              <input type="hidden" name="visibility" value={next} />
              <SubmitButton variant="outline" size="sm">
                {next === "org" ? "Share with org" : "Make private"}
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
      <div className="space-y-2 border-t px-4 py-3">
        <h5 className="text-sm font-medium">Repositories</h5>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository recorded in this golden.</p>
        ) : (
          <ul
            className="space-y-1 text-sm"
            aria-label={`Repositories of ${golden.name} on ${PROVIDER_LABELS[golden.provider]}`}
          >
            {repos.map((repo) => (
              <li key={`${repo.url}-${repo.dir}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1 font-mono text-xs">
                  <FolderGit2Icon className="size-3.5" />
                  {repo.slug ?? repo.url}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranchIcon className="size-3.5" />
                  {repo.branch}
                </span>
                {repo.dir && <span className="font-mono text-xs text-muted-foreground">/home/user/{repo.dir}</span>}
              </li>
            ))}
          </ul>
        )}
        {init.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {init.length} init command{init.length === 1 ? "" : "s"} recorded.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          {!context.serverReady ? (
            <p className="text-xs text-muted-foreground">Rebuilding needs the Armada server.</p>
          ) : state.canRebuild && membership ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                Edit and rebuild
              </summary>
              <div className="pt-4">
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
                />
              </div>
            </details>
          ) : (
            <p className="text-xs text-muted-foreground" data-rebuild-blocked>
              {state.reason ?? "Rebuilding is not available for this golden."}
            </p>
          )}
        </div>
        {context.serverReady && membership && removeBlocker === null && (
          <div className="-ml-3 self-start sm:ml-0">
            <RemoveGolden
              goldenId={golden.id}
              orgId={golden.org_id}
              name={golden.name}
              providerLabel={PROVIDER_LABELS[golden.provider]}
            />
          </div>
        )}
      </div>
    </li>
  );
}
