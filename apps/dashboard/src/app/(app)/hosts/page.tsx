import { CircleAlertIcon, ServerIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { CreatedAt } from "@/components/created-at";
import { AddHostDialog, HostMark, RevokeHost } from "@/components/docker-hosts";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { PanelSection, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { type DockerHost, HOSTS_PATH, hostName, hostState, sandboxCount } from "@/lib/docker-hosts";
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
            <p>{hosts.message}</p>
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
  const rows = sortResources(hosts.list.hosts.map((host) => row(host, orgId, isAdmin, now)));
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;

  return (
    <ResourceBrowser
      title={TITLE}
      description={DESCRIPTION}
      meta={rows.length > 0 ? rows.length : undefined}
      label="Docker hosts"
      rows={rows}
      blockers={[]}
      notices={
        hosts.list.skipped > 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {hosts.list.skipped} {hosts.list.skipped === 1 ? "host" : "hosts"} could not be shown.
          </p>
        ) : undefined
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
        <Empty title="No hosts yet" icon={<ServerIcon />}>
          A host is a machine you own, running Docker, where Armada starts sandboxes instead of a cloud provider.
        </Empty>
      }
    />
  );
}

function row(host: DockerHost, orgId: string, isAdmin: boolean, now: number): ResourceRow & { bucket: Bucket } {
  const name = hostName(host);
  const state = hostState(host, now);
  const added = relativeAge(host.createdAt, now);
  const meta = `Docker${added ? ` · added ${added}` : ""}`;
  const seen = host.lastSeenAt ? relativeAge(host.lastSeenAt, now) : null;
  return {
    key: host.id,
    name,
    bucket: state.bucket,
    search: [name, host.id, host.state].join(" "),
    mark: <HostMark />,
    meta,
    subtitle: meta,
    state: <StateCell tone={state.tone} label={state.label} detail={state.detail} data-host-state={host.state} />,
    fact: sandboxCount(host.sandboxes),
    detail: (
      <div className="space-y-4">
        <PanelSection title="State">
          <p id={`host-${host.id}-title`} tabIndex={-1} className="text-sm outline-none">
            {state.detail}
          </p>
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
            <dt className="text-muted-foreground">Sandboxes</dt>
            <dd>{sandboxCount(host.sandboxes)}</dd>
          </dl>
        </PanelSection>
        {isAdmin && host.state !== "revoked" && (
          <PanelSection title="Manage">
            <RevokeHost orgId={orgId} hostId={host.id} name={name} sandboxes={host.sandboxes} />
          </PanelSection>
        )}
      </div>
    ),
    attrs: { "data-host": host.id },
  };
}
