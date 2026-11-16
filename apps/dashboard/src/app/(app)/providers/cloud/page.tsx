import { type DockerSnapshotRecord, dockerHostResourceDisplay, type Harness } from "@armada/core";
import { CircleAlertIcon, ServerIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { CreatedAt } from "@/components/created-at";
import { AddHostDialog, HostLimitsDialog, HostMark, HostRetention, RevokeHost } from "@/components/docker-hosts";
import { DockerLaunchDialog } from "@/components/docker-launch";
import { MachinesSection } from "@/components/machines-catalog";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderConnection, type ProviderRowState } from "@/components/provider-connection";
import { ProviderMark } from "@/components/provider-mark";
import type { ResourceRow } from "@/components/resource-browser";
import { PanelSection, StateCell } from "@/components/state-cell";
import { ConnectionBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readSelectedDockerSnapshots } from "@/lib/data/docker-snapshots";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { type ProviderSetup, readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import type { Membership } from "@/lib/data/viewer";
import { type DockerHost, HOSTS_PATH, hostState, sandboxCount } from "@/lib/docker-hosts";
import { type DockerLaunchOption, dockerHarnesses, dockerLaunchBlocker, dockerUnavailable } from "@/lib/docker-launch";
import type { LaunchAccounts } from "@/lib/model-accounts";
import { CLOUD_PROVIDERS_PATH, isConfigured, SETUP_PROVIDERS } from "@/lib/provider-setup";
import { relativeAge } from "@/lib/relative-time";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { createClient } from "@/lib/supabase/server";
export const metadata: Metadata = { title: "Machines" };
export const dynamic = "force-dynamic";

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
  const query = await searchParams;
  const cloud = (
    <SandboxProviders
      selected={selected}
      setup={setup}
      admins={admins}
      initial={typeof query.item === "string" ? query.item : null}
    />
  );
  if (selected && hosts.state === "ready") {
    return OwnServers({ selected, hosts, query, cloud });
  }
  return (
    <>
      <PageHeader title="Machines" />
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
  initial,
}: {
  selected: Membership | null;
  setup: ProviderSetup | null;
  admins: string[];
  initial: string | null;
}) {
  const isAdmin = selected?.role === "admin";
  return (
    <div className="space-y-3" data-settings="providers" id="sandbox-providers">
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
            <Alert variant="destructive">
              <AlertTitle>Provider status unavailable</AlertTitle>
              <AlertDescription>
                Cloud account status could not be checked.{" "}
                <a href={CLOUD_PROVIDERS_PATH} className="underline">
                  Check again
                </a>
              </AlertDescription>
            </Alert>
          )}
          <MachinesSection
            initial={initial}
            label="Cloud providers"
            rows={SETUP_PROVIDERS.map((provider) => {
              const state: ProviderRowState =
                setup.state === "unavailable"
                  ? "unavailable"
                  : isConfigured(setup.status, provider)
                    ? "connected"
                    : "not-connected";
              const name = provider === "boat" ? "Boat" : "Modal";
              return {
                key: provider,
                name,
                search: name,
                actionLabel: isAdmin ? (state === "connected" ? "Replace key" : "Connect") : "Details",
                mark: <ProviderMark provider={provider} />,
                meta: "Organization key",
                state: <ConnectionBadge state={state} />,
                subtitle: selected.org.name,
                detail: (
                  <ul aria-label={`${name} connection`}>
                    <ProviderConnection
                      key={`${selected.org.id}.${provider}`}
                      orgId={selected.org.id}
                      orgName={selected.org.name}
                      provider={provider}
                      state={state}
                      canManage={isAdmin}
                    />
                  </ul>
                ),
              };
            })}
          />
          {!isAdmin && admins.length > 0 && (
            <p className="text-xs text-muted-foreground" data-provider-admins>
              Ask an admin to manage connections: {admins.join(", ")}.
            </p>
          )}
        </>
      )}
    </div>
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
    <>
      <PageHeader title={TITLE}>{isAdmin ? <AddHostDialog orgId={orgId} /> : undefined}</PageHeader>
      {cloud}
      <MachinesSection
        label="Docker hosts"
        rows={rows}
        initial={requested}
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
                  ? "Choose Register a Docker host to connect a Linux machine running Docker. After you run its install command, it appears here."
                  : "Ask an organization admin to add a server. It appears here after its install command runs."}
          </Empty>
        }
      />
      <div className="space-y-3">
        {!hosts.list.placement && (
          <p className="text-sm text-muted-foreground">
            Launching on your own servers is not enabled here yet. You can still view their connections.
          </p>
        )}

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
    </>
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
): ResourceRow & { bucket: Bucket; actionLabel: string } {
  const resources = dockerHostResourceDisplay(host);
  const name = host.name ?? "Unnamed machine";
  const blocker = dockerLaunchBlocker(launch.option, launch.placement, host);
  const state = hostState(host, now);
  const seen = host.lastSeenAt ? relativeAge(host.lastSeenAt, now) : null;
  return {
    key: host.id,
    name,
    bucket: state.bucket,
    search: [name, host.id, host.state, host.version ?? ""].join(" "),
    mark: <HostMark />,
    meta: host.version ? `Docker · ${host.version}` : "Docker host",
    subtitle: seen ? `Seen ${seen} ago` : "Never seen",
    state: (
      <div className="space-y-1">
        <StateCell tone={state.tone} label={state.label} data-host-state={host.state} />
      </div>
    ),
    fact: (
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded border bg-background px-2 py-0.5">{resources.usage}</span>
        <span className="rounded border bg-background px-2 py-0.5">Each {resources.limits}</span>
      </div>
    ),
    actionLabel: "Edit",
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
