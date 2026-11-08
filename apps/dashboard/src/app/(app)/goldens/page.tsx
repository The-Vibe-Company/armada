import { type Golden, MODEL_CATALOG } from "@armada/core";
import {
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
import { setGoldenVisibility } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Disclosure } from "@/components/disclosure";
import { GoldenForm } from "@/components/golden-form";
import { LaunchDialog } from "@/components/launch-dialog";
import { Empty, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CAPABILITIES_TIMEOUT_MS,
  createControlClient,
  type GoldenCapabilities,
  readGoldenCapabilities,
} from "@/lib/control";
import { getGitHubConnection } from "@/lib/data/github";
import { listGoldens } from "@/lib/data/goldens";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, type Membership, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  boatCapacity,
  type CapacityState,
  editDefaults,
  goldenInit,
  goldenRepos,
  goldenRowState,
  launchRepoOptions,
} from "@/lib/golden-form";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Goldens" };
export const dynamic = "force-dynamic";
// The create and rebuild server actions run in this route's function and wait for the server's build (up to
// GOLDEN_BUILD_TIMEOUT_MS). This is the same bound as `/api/v1/*`, so the fetch times out before the function.
export const maxDuration = 800;

export default async function GoldensPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const serverUrl = mcpUrl();
  const [goldens, memberships, directory, github, capabilities] = await Promise.all([
    listGoldens(supabase),
    pending,
    pending.then((items) =>
      memberDirectory(
        supabase,
        items.map((item) => item.org.id),
      ),
    ),
    getGitHubConnection(supabase).catch(() => null),
    selected ? goldenCapabilities(serverUrl, viewer.token, selected.org.id) : null,
  ]);
  const orgs = new Map(memberships.map((item) => [item.org.id, item]));
  const mine = goldens.filter((golden) => golden.visibility === "private");
  const shared = goldens.filter((golden) => golden.visibility === "org");
  // Read on the server with the session; only the resulting number (or why it is missing) reaches the page.
  const capacity = capabilities ? boatCapacity(goldens, capabilities) : null;
  const serverReady = serverUrl !== null;
  const githubConnected = Boolean(github && !github.revoked_at);
  const context: RowContext = {
    orgs,
    directory,
    viewerId: viewer.id,
    all: goldens,
    serverReady,
  };

  return (
    <>
      <PageHeader
        title="Goldens"
        description="A golden is a saved snapshot of your repositories, built once on the Armada server. Every sandbox starts from one."
      />
      {selected && capacity ? (
        <>
          <CapacityCard state={capacity} />
          {capacity.kind === "legacy" && <LegacyConflict goldens={goldens.filter((g) => g.provider === "boat")} />}
          <CreateCard org={selected} capacity={capacity} serverReady={serverReady} githubConnected={githubConnected} />
        </>
      ) : (
        <Empty title="No organization">
          <Link className="underline underline-offset-4" href="/orgs">
            Create or join an organization
          </Link>{" "}
          to build goldens.
        </Empty>
      )}
      <Section
        id="private-goldens"
        title="Private"
        description="Only you see these."
        goldens={mine}
        context={context}
      />
      <Section
        id="org-goldens"
        title="Shared with your orgs"
        description="Every member of the org sees these. Only an org admin changes them."
        goldens={shared}
        context={context}
      />
    </>
  );
}

/** The selected org's Boat golden limit, from the Armada server's `golden/capabilities`. Never retried. */
async function goldenCapabilities(
  serverUrl: string | null,
  token: string | null,
  org: string,
): Promise<GoldenCapabilities> {
  if (!serverUrl || !token) return { ok: false, reason: "The Armada server is not configured for this dashboard." };
  return readGoldenCapabilities(createControlClient({ serverUrl, token, timeoutMs: CAPABILITIES_TIMEOUT_MS }), org);
}

function CapacityCard({ state }: { state: CapacityState }) {
  return (
    <Card className="gap-3 py-4" aria-labelledby="boat-capacity-title" data-capacity={state.kind}>
      <CardHeader className="px-4">
        <CardTitle id="boat-capacity-title" role="heading" aria-level={2} className="flex items-center gap-2 text-base">
          <ServerIcon className="size-4" /> Boat golden capacity
        </CardTitle>
        <CardDescription>
          {state.kind === "unavailable"
            ? "Capacity unavailable: the Armada server could not report this organization's Boat golden limit. The server still checks it when it builds."
            : state.kind === "unknown"
              ? "The Armada server reports no golden limit for this organization's Boat backend."
              : `The Armada server reports that this organization's Boat backend holds ${state.capacity === 1 ? "one golden" : `${state.capacity} goldens`}. The server checks that limit when it builds; this page only reflects it.`}
        </CardDescription>
      </CardHeader>
      {state.kind === "unavailable" && (
        <CardContent className="px-4 text-sm">
          <p className="text-muted-foreground" data-capacity-reason>
            {state.reason}
          </p>
        </CardContent>
      )}
      {state.kind !== "unavailable" && state.kind !== "unknown" && (
        <CardContent className="px-4 text-sm">
          <p>
            <span className="font-medium">
              {state.used} of {state.capacity}
            </span>{" "}
            visible to you in this organization.{" "}
            <span className="text-muted-foreground">
              {state.kind === "available"
                ? "You can build a golden."
                : state.kind === "full"
                  ? "Edit and rebuild the existing golden rather than creating another."
                  : "More rows than the limit: these predate it. See below."}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Private goldens of other members and goldens of other organizations sharing the Boat account are not counted
            here, so the server may still refuse a new build.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function LegacyConflict({ goldens }: { goldens: Golden[] }) {
  return (
    <Alert data-legacy-conflict>
      <TriangleAlertIcon />
      <AlertTitle>{goldens.length} Boat goldens predate the one-golden limit</AlertTitle>
      <AlertDescription>
        <p>
          Armada keeps every one of these rows and their access rules. This dashboard does not choose, merge or delete
          any of them, and it does not mark one as active.
        </p>
        <ul className="list-inside list-disc">
          {goldens.map((golden) => (
            <li key={golden.id}>
              <span className="font-mono text-xs">{golden.name}</span> ({golden.visibility})
            </li>
          ))}
        </ul>
        <p>
          Rebuild the golden you want to keep. The server may refuse a rebuild or a new build while the Boat account's
          slot is held by another row; resolving that needs the server's operators.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function CreateCard({
  org,
  capacity,
  serverReady,
  githubConnected,
}: {
  org: Membership;
  capacity: CapacityState;
  serverReady: boolean;
  githubConnected: boolean;
}) {
  const discouraged = capacity.kind === "full" || capacity.kind === "legacy";
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
      {discouraged && (
        <p className="text-sm text-muted-foreground">
          A Boat golden already exists here. Creating another is likely to be refused by the server; prefer{" "}
          <span className="font-medium text-foreground">Edit and rebuild</span> on the existing golden below.
        </p>
      )}
      <GoldenForm mode="create" orgId={org.org.id} orgName={org.org.name} isAdmin={org.role === "admin"} />
    </div>
  );
  return (
    <Card className="gap-4" aria-labelledby="create-golden-title">
      <CardHeader>
        <CardTitle id="create-golden-title" role="heading" aria-level={2}>
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
};

function Section({
  id,
  title,
  description,
  goldens,
  context,
}: {
  id: string;
  title: string;
  description: string;
  goldens: Golden[];
  context: RowContext;
}) {
  return (
    <section className="space-y-3" aria-labelledby={`${id}-title`}>
      <div>
        <h2 id={`${id}-title`} className="text-lg font-medium">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {goldens.length === 0 ? (
        <Empty title={`No ${title.toLowerCase()} goldens`} />
      ) : (
        <ul className="space-y-3">
          {goldens.map((golden) => (
            <GoldenCard key={golden.id} golden={golden} context={context} />
          ))}
        </ul>
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
  const titleId = `golden-${golden.id}`;
  return (
    <li data-golden={golden.name} aria-labelledby={titleId} className="rounded-lg border bg-card">
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="font-medium">
              {golden.name}
            </h3>
            <Badge variant={golden.visibility === "private" ? "secondary" : "outline"} className="gap-1">
              {golden.visibility === "private" ? <LockIcon className="size-3" /> : <GlobeIcon className="size-3" />}
              {golden.visibility === "private" ? "Private" : "Org"}
            </Badge>
            <Badge variant="outline" className="capitalize">
              {golden.provider}
            </Badge>
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
              repos={launchRepoOptions(golden.config)}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {golden.provider_snapshot_id ? "Server not set" : "Snapshot first"}
            </span>
          )}
          {!isOwner ? (
            <span className="text-xs text-muted-foreground">Owner only</span>
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
        <h4 className="text-sm font-medium">Repositories</h4>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository recorded in this golden.</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label={`Repositories of ${golden.name}`}>
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
      <div className="border-t px-4 py-3">
        {!context.serverReady ? (
          <p className="text-xs text-muted-foreground">Rebuilding needs the Armada server.</p>
        ) : state.canRebuild && membership ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Edit and rebuild</summary>
            <div className="pt-4">
              <GoldenForm
                mode="update"
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
    </li>
  );
}
