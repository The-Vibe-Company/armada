import { dockerHostResourceDisplay, type Harness } from "@armada/core";
import { CircleAlertIcon, ServerIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { CreatedAt } from "@/components/created-at";
import { AddHostDialog, HostLimitsDialog, HostMark, RevokeHost } from "@/components/docker-hosts";
import { DockerLaunchDialog } from "@/components/docker-launch";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { PanelSection, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { readDockerLaunchOption, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { type DockerHost, HOSTS_PATH, hostFact, hostState, sandboxCount } from "@/lib/docker-hosts";
import { type DockerLaunchOption, dockerHarnesses, dockerLaunchBlocker, dockerUnavailable } from "@/lib/docker-launch";
import type { LaunchAccounts } from "@/lib/model-accounts";
import { relativeAge } from "@/lib/relative-time";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";

export const metadata: Metadata = { title: "Hosts" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Hosts";
const DESCRIPTION = "Machines you own that run sandboxes in Docker.";

export default async function HostsPage({ searchParams }: Props) {
  const [selected, hosts, query] = await Promise.all([selectedOrganization(), readSelectedDockerHosts(), searchParams]);
  // Behind the server's opt-in (and an organization): otherwise there is no page, as there is no menu entry.
  if (!selected || hosts.state === "disabled") notFound();
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

  if (hosts.state === "error") {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Hosts could not be loaded</AlertTitle>
          <AlertDescription>
            <p>
              Check your connection and try again. If this continues, ask an organization admin to check the Armada
              connection.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href={HOSTS_PATH}>Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const isAdmin = selected.role === "admin";
  const orgId = selected.org.id;
  const now = Date.now();
  // The launch options say why a launch is unavailable, so they are read whenever a host is listed that is not
  // revoked; the accounts only when some host could take a launch now.
  const live = hosts.list.hosts.some((host) => host.state !== "revoked");
  const launchable = hosts.list.placement && hosts.list.hosts.some((host) => host.state === "online");
  const [option, accountList] = await Promise.all([
    live ? readDockerLaunchOption() : null,
    launchable ? listSelectedAccounts() : null,
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
  const rows = sortResources(visible.map((host) => row(host, orgId, isAdmin, now, launch)));

  return (
    <ResourceBrowser
      title={TITLE}
      description={DESCRIPTION}
      meta={rows.length > 0 ? rows.length : undefined}
      label="Docker hosts"
      rows={rows}
      blockers={[]}
      notices={
        <div className="space-y-3">
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
                ? "These machines have not connected yet. If you no longer have the install command, revoke the entry and add the host again to get a new one. Revoking an entry does not uninstall anything on your machine."
                : "These machines have not connected yet. Ask an organization admin to finish setup or remove unused entries."}
            </p>
          )}
          {hosts.list.skipped > 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              {hosts.list.skipped} {hosts.list.skipped === 1 ? "host" : "hosts"} could not be shown.
            </p>
          )}
        </div>
      }
      initial={requested}
      actions={isAdmin ? <AddHostDialog orgId={orgId} /> : undefined}
      footer={
        <p className="text-xs text-pretty text-muted-foreground">
          Hosts are shared with every member of {selected.org.name};{" "}
          {isAdmin ? "you add and revoke them." : "only an admin adds or revokes them."}
        </p>
      }
      empty={
        <Empty title={showSetup ? "No unfinished setup" : "No machines connected yet"} icon={<ServerIcon />}>
          {showSetup
            ? "Your machines have completed setup or their entries have been revoked. Choose Machines to see them."
            : isAdmin
              ? "Choose Add host to connect a Linux machine running Docker. After you run its install command, it appears here."
              : "Ask an organization admin to add a Docker host. It appears here after its install command runs."}
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
): ResourceRow & { bucket: Bucket } {
  const resources = dockerHostResourceDisplay(host);
  const name = host.name ?? "Unnamed machine";
  const blocker = dockerLaunchBlocker(launch.option, launch.placement, host);
  const state = hostState(host, now);
  const added = relativeAge(host.createdAt, now);
  const meta = `Docker${added ? ` · added ${added}` : ""}`;
  const seen = host.lastSeenAt ? relativeAge(host.lastSeenAt, now) : null;
  return {
    key: host.id,
    name,
    bucket: state.bucket,
    search: [name, host.id, host.state, host.version ?? ""].join(" "),
    mark: <HostMark />,
    meta,
    subtitle: meta,
    state: <StateCell tone={state.tone} label={state.label} detail={state.detail} data-host-state={host.state} />,
    fact: hostFact(host),
    action:
      isAdmin && host.state !== "revoked" ? (
        <RevokeHost orgId={orgId} hostId={host.id} name={name} sandboxes={host.sandboxes} />
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
        <PanelSection title="Resource limits">
          <HostLimitsDialog orgId={orgId} host={host} />
        </PanelSection>
        <PanelSection title="Facts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Host ID</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono text-xs">{host.id}</code>
              <CopyButton value={host.id} label="Copy host ID" />
            </dd>
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
            <dt className="text-muted-foreground">Daemon version</dt>
            <dd>{host.version ?? "Unknown"}</dd>
          </dl>
        </PanelSection>
      </div>
    ),
    attrs: { "data-host": host.id },
  };
}
