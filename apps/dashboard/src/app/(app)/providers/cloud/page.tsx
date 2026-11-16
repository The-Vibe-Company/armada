import { type DockerSnapshotRecord, dockerHostResourceDisplay, type Harness } from "@armada/core";
import { CircleAlertIcon, RotateCwIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CatalogBrowser } from "@/components/catalog-browser";
import { CopyButton } from "@/components/copy-button";
import { CreatedAt } from "@/components/created-at";
import { AddHostDialog, HostLimitsDialog, HostMark, HostRetention, RevokeHost } from "@/components/docker-hosts";
import { DockerLaunchDialog } from "@/components/docker-launch";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderConnection, type ProviderRowState } from "@/components/provider-connection";
import type { ResourceRow } from "@/components/resource-browser";
import { PanelSection, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readSelectedDockerSnapshots } from "@/lib/data/docker-snapshots";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { type ProviderSetup, readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import type { Membership } from "@/lib/data/viewer";
import { type DockerHost, HOSTS_PATH, hostFact, hostState, sandboxCount } from "@/lib/docker-hosts";
import { type DockerLaunchOption, dockerHarnesses, dockerLaunchBlocker, dockerUnavailable } from "@/lib/docker-launch";
import type { LaunchAccounts } from "@/lib/model-accounts";
import { CLOUD_PROVIDERS_PATH, isConfigured, SETUP_PROVIDERS } from "@/lib/provider-setup";
import { relativeAge } from "@/lib/relative-time";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { createClient } from "@/lib/supabase/server";
export const metadata: Metadata = { title: "Machines" };
export const dynamic = "force-dynamic";

const DESCRIPTION = "Where your sandboxes run: cloud accounts and your own servers.";

/** Cloud accounts and own servers share one Machines surface; personal keys stay in Your connections. */
export default async function CloudProvidersPage({ searchParams }: Props) {
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [setup, admins, hosts] = await Promise.all([
    selected ? readProviderSetup(selected.org.id) : null,
    // A member is told whom to ask; an admin manages the providers here.
    selected && selected.role !== "admin"
      ? supabase
          .rpc("org_members", { target_org: selected.org.id })
          .then(({ data }) => (data ?? []).filter((member) => member.role === "admin").map((member) => member.email))
      : [],
    readSelectedDockerHosts(),
  ]);
  const cloud = <SandboxProviders selected={selected} setup={setup} admins={admins} />;
  if (selected && hosts.state === "ready") {
    return OwnServers({ selected, hosts, query: await searchParams, cloud });
  }
  return (
    <>
      <PageHeader title="Machines" description={DESCRIPTION} />
      {cloud}
      {hosts.state === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Servers could not be loaded</AlertTitle>
          <AlertDescription>Reload Machines to try again.</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function SandboxProviders({
  selected,
  setup,
  admins,
}: {
  selected: Membership | null;
  setup: ProviderSetup | null;
  admins: string[];
}) {
  const isAdmin = selected?.role === "admin";
  return (
    <Card data-settings="providers" aria-labelledby="sandbox-providers-title" id="sandbox-providers">
      <CardHeader>
        <CardTitle id="sandbox-providers-title" role="heading" aria-level={2} className="flex items-center gap-2">
          Cloud
        </CardTitle>
        {selected && (
          <CardDescription>
            Accounts shared with {selected.org.name}. Only administrators change cloud connections.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!selected || !setup ? (
          <Empty
            title="Choose an organization"
            action={
              <Button asChild variant="outline">
                <Link href="/orgs">Create or join an organization</Link>
              </Button>
            }
          >
            Connect provider accounts and machines for the organization you work in.
          </Empty>
        ) : (
          <>
            {setup.state === "unavailable" && (
              <Alert variant="destructive" data-setup-state="unavailable">
                <TriangleAlertIcon />
                <AlertTitle>Provider status unavailable</AlertTitle>
                <AlertDescription>
                  <p>
                    Cloud account status could not be checked. Try again; your saved accounts have not been changed.
                  </p>
                  {/* A document request, not a client navigation: the router would reuse its cached render (staleTimes). */}
                  <a
                    className="inline-flex items-center gap-1 underline underline-offset-4"
                    href={CLOUD_PROVIDERS_PATH}
                  >
                    <RotateCwIcon className="size-3" aria-hidden />
                    Check again
                  </a>
                </AlertDescription>
              </Alert>
            )}
            <ul
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,310px),1fr))] gap-3"
              data-setup-state={setup.state}
              aria-label="Cloud accounts"
            >
              {SETUP_PROVIDERS.map((provider) => {
                const state: ProviderRowState =
                  setup.state === "unavailable"
                    ? "unavailable"
                    : isConfigured(setup.status, provider)
                      ? "connected"
                      : "not-connected";
                return (
                  <ProviderConnection
                    // A switched organization mounts a fresh row: no open form or message carries over.
                    key={`${selected.org.id}.${provider}`}
                    orgId={selected.org.id}
                    orgName={selected.org.name}
                    provider={provider}
                    state={state}
                    canManage={isAdmin}
                  />
                );
              })}
            </ul>
            {!isAdmin && setup.state === "pending" && admins.length > 0 && (
              <p className="text-sm text-muted-foreground" data-provider-admins>
                Ask an admin to connect one:{" "}
                {admins.map((email, index) => (
                  <span key={email}>
                    {index > 0 && ", "}
                    <a className="text-foreground underline underline-offset-4" href={`mailto:${email}`}>
                      {email}
                    </a>
                  </span>
                ))}
                .
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Machines";
async function OwnServers({
  selected,
  hosts,
  query,
  cloud,
}: {
  selected: Membership;
  hosts: Extract<Awaited<ReturnType<typeof readSelectedDockerHosts>>, { state: "ready" }>;
  query: Record<string, string | string[] | undefined>;
  cloud: ReactNode;
}) {
  const isAdmin = selected.role === "admin";
  const orgId = selected.org.id;
  const now = Date.now();
  // The launch options say why a launch is unavailable, so they are read whenever a host is listed that is not
  // revoked; the accounts only when some host could take a launch now.
  const live = hosts.list.hosts.some((host) => host.state !== "revoked");
  const launchable = hosts.list.placement && hosts.list.hosts.some((host) => host.state === "online");
  const [option, accountList, snapshots] = await Promise.all([
    live ? readDockerLaunchOption() : null,
    launchable ? listSelectedAccounts() : null,
    readSelectedDockerSnapshots(),
  ]);
  const launch: Launch = {
    option,
    placement: hosts.list.placement,
    accounts: accountList ? launchAccounts(accountList, now) : { state: "unavailable", reason: "Not read." },
    unavailable: option ? dockerUnavailable(option) : [],
    harnesses: dockerHarnesses(option),
  };
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;
  const unfinished = hosts.list.hosts.filter((host) => host.state === "pending");
  // Old links to an unfinished registration still open its cleanup controls.
  const showSetup = query.setup === "unfinished" || unfinished.some((host) => host.id === requested);
  const visible = hosts.list.hosts.filter((host) => (host.state === "pending") === showSetup);
  const rows = sortResources(
    visible.map((host) =>
      row(host, orgId, isAdmin, now, launch, snapshots.state === "ready" ? snapshots.snapshots : null),
    ),
  );

  return (
    <CatalogBrowser
      title={TITLE}
      description={DESCRIPTION}
      label="Your own servers"
      rows={rows}
      blockers={[]}
      notices={
        <div className="space-y-3">
          {cloud}
          {!hosts.list.placement && (
            <p className="text-sm text-muted-foreground">
              Launching on your own servers is not enabled here yet. You can still view their connections.
            </p>
          )}
          <h2 className="pt-4 text-sm font-medium">Your own servers</h2>
          {(unfinished.length > 0 || showSetup) && (
            <nav aria-label="Host setup" className="flex flex-wrap gap-2">
              <Button asChild variant={showSetup ? "outline" : "secondary"} size="sm">
                <Link href={HOSTS_PATH} aria-current={!showSetup ? "page" : undefined}>
                  Machines
                </Link>
              </Button>
              <Button asChild variant={showSetup ? "secondary" : "outline"} size="sm">
                <Link href={`${HOSTS_PATH}?setup=unfinished`} aria-current={showSetup ? "page" : undefined}>
                  Unfinished setup ({unfinished.length})
                </Link>
              </Button>
            </nav>
          )}
          {showSetup && (
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? "These machines have not connected yet. If you no longer have the install command, unlink the entry and add the server again to get a new one. Unlinking an entry does not uninstall anything on your machine."
                : "These machines have not connected yet. Ask an organization admin to finish setup or remove unused entries."}
            </p>
          )}
          {hosts.list.skipped > 0 && (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>Some machines could not be shown</AlertTitle>
              <AlertDescription>
                <p>
                  Your machine list is incomplete. Reload to try again. If this continues, ask an organization admin for
                  help.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-2">
                  <a href={HOSTS_PATH}>Reload Machines</a>
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      }
      initial={requested}
      actions={isAdmin ? <AddHostDialog orgId={orgId} /> : undefined}
      footer={
        <p className="text-xs text-pretty text-muted-foreground">
          Hosts are shared with every member of {selected.org.name};{" "}
          {isAdmin ? "you add and unlink them." : "only an admin adds or unlinks them."}
        </p>
      }
      empty={
        <Empty
          title={
            hosts.list.skipped > 0
              ? "Machines are not fully loaded"
              : showSetup
                ? "No unfinished setup"
                : "No machines connected yet"
          }
          icon={<ServerIcon />}
        >
          {hosts.list.skipped > 0
            ? "Some machines could not be read. Reload the list before adding a machine or checking setup."
            : showSetup
              ? "Your machines have completed setup or their entries have been unlinked. Choose Machines to see them."
              : isAdmin
                ? "Choose Add your own server to connect a Linux machine running Docker. After you run its install command, it appears here."
                : "Ask an organization admin to add a server. It appears here after its install command runs."}
        </Empty>
      }
    />
  );
}

type Launch = {
  option: DockerLaunchOption | null;
  placement: boolean;
  accounts: LaunchAccounts;
  unavailable: { name: string; reason: string }[];
  /** The agents the server launches on Docker. */
  harnesses: { offered: Harness[]; initial: Harness | null };
};

function row(
  host: DockerHost,
  orgId: string,
  isAdmin: boolean,
  now: number,
  launch: Launch,
  snapshots: DockerSnapshotRecord[] | null,
): ResourceRow & { bucket: Bucket } {
  const resources = dockerHostResourceDisplay(host);
  const name = host.name ?? "Unnamed machine";
  const blocker = dockerLaunchBlocker(launch.option, launch.placement, host);
  const state = hostState(host, now);
  const meta = host.canManageLimits ? "Added by you" : "Added by a teammate";
  const seen = host.lastSeenAt ? relativeAge(host.lastSeenAt, now) : null;
  return {
    key: host.id,
    name,
    bucket: state.bucket,
    search: [name, host.id, host.state, host.version ?? ""].join(" "),
    mark: <HostMark />,
    meta,
    subtitle: meta,
    state: (
      <div className="space-y-1">
        <StateCell tone={state.tone} label={state.label} data-host-state={host.state} />
        <p className="text-xs text-muted-foreground">{state.detail}</p>
        <p className="text-xs text-muted-foreground @3xl:hidden">{hostFact(host)}</p>
      </div>
    ),
    fact: hostFact(host),
    action: !blocker ? (
      <DockerLaunchDialog
        orgId={orgId}
        hostId={host.id}
        hostName={name}
        accounts={launch.accounts}
        unavailable={launch.unavailable}
        harnesses={launch.harnesses.offered}
        initialHarness={launch.harnesses.initial ?? "codex"}
      />
    ) : undefined,
    detail: (
      <div className="space-y-4">
        <PanelSection title="State">
          <p id={`host-${host.id}-title`} tabIndex={-1} className="text-sm outline-none">
            {state.detail}
          </p>
        </PanelSection>
        <PanelSection title="Launch">
          {blocker ? (
            <p className="text-sm text-muted-foreground" data-docker-launch-blocker>
              {blocker}
            </p>
          ) : (
            <DockerLaunchDialog
              orgId={orgId}
              hostId={host.id}
              hostName={name}
              accounts={launch.accounts}
              unavailable={launch.unavailable}
              harnesses={launch.harnesses.offered}
              initialHarness={launch.harnesses.initial ?? "codex"}
            />
          )}
        </PanelSection>
        <PanelSection title="Cleanup retention">
          <HostRetention orgId={orgId} host={host} />
        </PanelSection>
        <PanelSection title="Per sandbox and at the same time">
          <HostLimitsDialog orgId={orgId} host={host} />
        </PanelSection>
        <PanelSection title="Limits and usage">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Added</dt>
            <dd>
              <CreatedAt iso={host.createdAt} now={now} />
            </dd>
            <dt className="text-muted-foreground">Last check-in</dt>
            <dd>{seen ?? "Never"}</dd>
            <dt className="text-muted-foreground">Machine</dt>
            <dd>{resources.machine}</dd>
            <dt className="text-muted-foreground">Per sandbox</dt>
            <dd>{resources.limits}</dd>
            <dt className="text-muted-foreground">Running / capacity</dt>
            <dd className="tabular-nums">{resources.usage}</dd>
            <dt className="text-muted-foreground">Retained sandboxes</dt>
            <dd>{sandboxCount(host.sandboxes)}</dd>
          </dl>
        </PanelSection>
        <PanelSection title="Snapshots on it">
          <p className="text-sm text-muted-foreground">
            {snapshots === null
              ? "Snapshots could not be loaded."
              : snapshots
                  .filter((snapshot) => snapshot.hostId === host.id)
                  .map((snapshot) => snapshot.name)
                  .join(", ") || "No snapshots yet"}
          </p>
          <Link className="text-sm underline underline-offset-4" href="/snapshots">
            See in Snapshots
          </Link>
        </PanelSection>
        <Collapsible className="border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">Technical details</h3>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Show
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="pt-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {" "}
              <dt className="text-muted-foreground">Host ID</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <code className="truncate font-mono text-xs">{host.id}</code>
                <CopyButton value={host.id} label="Copy host ID" />
              </dd>
              <dt className="text-muted-foreground">Daemon version</dt>
              <dd>{host.version ?? "Unknown"}</dd>
            </dl>
          </CollapsibleContent>
        </Collapsible>
        {isAdmin && host.state !== "revoked" && (
          <PanelSection title="Unlink this server">
            <RevokeHost orgId={orgId} hostId={host.id} name={name} sandboxes={host.sandboxes} />
          </PanelSection>
        )}
      </div>
    ),
    attrs: { "data-host": host.id },
  };
}
