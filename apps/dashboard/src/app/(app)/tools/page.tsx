import { CircleAlertIcon, CircleCheckIcon, PlugIcon, StarIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  AddConnectionForm,
  ConnectServiceDialog,
  ServiceCatalog,
  ServiceMark,
  ToolPanel,
  ToolRowAction,
} from "@/components/connections";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  authLabel,
  hostOf,
  type McpCatalogService,
  type McpConnection,
  type OAuthReturn,
  oauthReturn,
  STATUS_INFO,
  transportLabel,
} from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedCatalog, listSelectedConnections, viewerControl } from "@/lib/data/connections";
import { selectedOrganization } from "@/lib/data/selected-org";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { serviceState, type ToolState, toolBlockers, toolFact, toolState, unaddedServices } from "@/lib/tools";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Tools" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Tools";
const DESCRIPTION = "MCP connections your agents can use.";

export default async function ToolsPage({ searchParams }: Props) {
  const selected = await selectedOrganization();
  const list = await listSelectedConnections();
  const query = await searchParams;
  const returned = oauthReturn(query);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

  if (!selected || list.state === "no-org") {
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>{" "}
          to add tools.
        </Empty>
      </>
    );
  }
  if (list.state === "not-configured") {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>The Armada server is not configured: tools cannot be managed here.</AlertDescription>
        </Alert>
      </>
    );
  }
  if (list.state === "error") {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Tools could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{list.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/tools">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const isAdmin = selected.role === "admin";
  const [notice, catalog] = await Promise.all([
    returned ? returnNotice(returned, selected.org.id) : null,
    listSelectedCatalog(selected.org.id),
  ]);
  const services = catalog.state === "ready" ? catalog.services : [];
  const taken = list.connections.map((connection) => connection.name);
  const org = { orgId: selected.org.id, orgName: selected.org.name, isAdmin };

  const connectionRows = list.connections.map((connection) => {
    const canManage = connection.scope === "personal" || isAdmin;
    const serviceLabel = services.find((service) => service.id === connection.catalogId)?.label;
    const state = toolState(connection, canManage);
    return { ...connectionRow(connection, state, canManage, serviceLabel), status: state, connection };
  });
  const serviceRows = unaddedServices(services, list.connections).map((service) =>
    serviceRow(service, { ...org, taken }),
  );
  const rows = sortResources<ResourceRow & { bucket: Bucket }>([...connectionRows, ...serviceRows]);
  const blockers = toolBlockers(connectionRows.map((row) => ({ ...row, state: row.status })));
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;
  // Back from a sign-in, the connection it was for is the one to look at.
  const initial = requested ?? (returned?.id && rows.some((row) => row.key === returned.id) ? returned.id : null);

  return (
    <ResourceBrowser
      title={TITLE}
      description={DESCRIPTION}
      meta={list.connections.length > 0 ? list.connections.length : undefined}
      label="Tools"
      rows={rows}
      blockers={blockers}
      notices={notice}
      initial={initial}
      create={{
        label: "New",
        title: "Add a tool",
        subtitle: "A service to sign in to, or any MCP server.",
        content: (
          <div className="space-y-6">
            <PanelSection title="Services" aria-label="Services">
              {catalog.state === "ready" ? (
                services.length > 0 ? (
                  <ServiceCatalog services={services} connections={list.connections} {...org} />
                ) : (
                  <p className="text-sm text-muted-foreground">No services offered. Add a custom server instead.</p>
                )
              ) : (
                <p className="text-sm text-muted-foreground" data-catalog-unavailable>
                  Services are not available: {catalog.message} You can still add a custom server.
                </p>
              )}
            </PanelSection>
            <PanelSection title="Custom server">
              <p className="text-sm text-muted-foreground">
                Any MCP server by URL, or a command that runs in the sandbox.
              </p>
              <AddConnectionForm {...org} />
            </PanelSection>
          </div>
        ),
      }}
      footer={
        <p className="text-xs text-muted-foreground">
          Personal tools reach only the sandboxes you launch. Org tools reach every member's;{" "}
          {isAdmin ? "you manage them." : "only an admin changes them."}
        </p>
      }
      empty={
        <Empty title="No tools yet" icon={<PlugIcon />}>
          Use New to sign in to a service or add an MCP server; agents pick it when they launch.
        </Empty>
      }
    />
  );
}

/** One connection as a row: who uses it, its state, its identity and tool count, and the fix it needs. */
function connectionRow(
  connection: McpConnection,
  state: ToolState,
  canManage: boolean,
  serviceLabel: string | undefined,
): ResourceRow & { bucket: Bucket } {
  const remote = connection.transport !== "stdio";
  const where =
    serviceLabel ?? (remote ? (connection.url ? hostOf(connection.url) : "URL hidden") : connection.command);
  const meta = [where, remote ? authLabel(connection.authType) : transportLabel(connection.transport)]
    .filter(Boolean)
    .join(" · ");
  return {
    key: connection.id,
    name: connection.name,
    bucket: state.bucket,
    search: [
      connection.name,
      serviceLabel,
      connection.url,
      connection.command,
      connection.accountLabel,
      connection.scope,
    ]
      .filter(Boolean)
      .join(" "),
    mark: (
      <ServiceMark
        label={serviceLabel ?? connection.name}
        className={cn(!serviceLabel && "font-normal", !remote && "font-mono")}
      />
    ),
    tags: (
      <>
        <ScopeTag scope={connection.scope} />
        {connection.defaultForLaunch && (
          <RowTag title="Included in new launches by default" data-default-for-launch>
            <StarIcon aria-hidden /> Default
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
        detail={connection.lastError}
        data-connection-status={connection.status}
      />
    ),
    fact: toolFact(connection),
    action: canManage ? <ToolRowAction connection={connection} /> : null,
    detail: <ToolPanel connection={connection} canManage={canManage} serviceLabel={serviceLabel} />,
    attrs: { "data-connection": connection.name },
  };
}

/** A catalog service nobody connected yet, at the end of the list: Connect, or the setup the server still needs. */
function serviceRow(
  service: McpCatalogService,
  org: { orgId: string; orgName: string; isAdmin: boolean; taken: string[] },
): ResourceRow & { bucket: Bucket } {
  const state = serviceState(service);
  const ready = service.availability === "available";
  const meta = ready ? hostOf(service.url) : (service.setupMessage ?? "Needs setup on this Armada server.");
  const action = ready ? (
    <ConnectServiceDialog service={service} another={false} {...org} />
  ) : service.docsUrl ? (
    <Button variant="outline" size="sm" asChild>
      <a href={service.docsUrl} target="_blank" rel="noreferrer noopener">
        Setup guide
      </a>
    </Button>
  ) : null;
  return {
    key: `service:${service.id}`,
    name: service.label,
    bucket: state.bucket,
    search: `${service.label} ${service.url}`,
    mark: <ServiceMark label={service.label} />,
    meta,
    subtitle: ready ? "Available to connect" : "Not available yet",
    state: <StateCell tone={state.tone} label={state.label} {...(ready ? {} : { "data-service-setup": "" })} />,
    action,
    detail: (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {ready
            ? `Sign in once at ${service.label}; your agents can then use it in every sandbox you launch.`
            : (service.setupMessage ?? "This Armada server needs setup before anyone can connect it.")}
        </p>
        {ready && <p className="font-mono text-xs break-all">{service.url}</p>}
        {action}
      </div>
    ),
    attrs: { "data-service-row": service.id },
  };
}

function ScopeTag({ scope }: { scope: McpConnection["scope"] }) {
  return (
    <RowTag>
      {scope === "personal" ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />}
      {scope === "personal" ? "Personal" : "Org"}
    </RowTag>
  );
}

/**
 * Feedback after the server's OAuth callback sent the browser back here. The page asks the control API for the
 * connection's status instead of trusting the URL, so the notice reflects what the server actually stored.
 */
async function returnNotice(returned: OAuthReturn, org: string) {
  if (returned.id === null) {
    return (
      <Alert variant="destructive" data-oauth-return="failed">
        <CircleAlertIcon />
        <AlertTitle>
          {returned.outcome === "denied" ? "Sign-in was cancelled" : "Sign-in could not be completed"}
        </AlertTitle>
        <AlertDescription>
          {returned.outcome === "denied"
            ? "Nothing was stored. Connect again when you are ready."
            : "The authorization expired or was refused, and nothing was stored. Use Connect to try again."}
        </AlertDescription>
      </Alert>
    );
  }
  const control = await viewerControl();
  let connection: McpConnection | null = null;
  let problem: string | null = null;
  try {
    connection = control ? await control.status({ org, id: returned.id }) : null;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    problem = error.message;
  }
  if (connection?.status === "connected") {
    return (
      <Alert role="status" data-oauth-return="connected" className="border-success/40">
        <CircleCheckIcon className="text-success" />
        <AlertTitle>{connection.name} is connected</AlertTitle>
        <AlertDescription>
          {connection.accountLabel ? `Signed in as ${connection.accountLabel}. ` : ""}You can select it when you launch
          a sandbox.
        </AlertDescription>
      </Alert>
    );
  }
  const title =
    returned.outcome === "denied"
      ? "Sign-in was cancelled"
      : connection
        ? `${connection.name} is not connected`
        : "That connection could not be found";
  const detail =
    problem ??
    (connection
      ? `${STATUS_INFO[connection.status].label}.${connection.lastError ? ` ${connection.lastError}` : ""} Try Connect again.`
      : "It may have been deleted, or belong to another organization.");
  return (
    <Alert variant="destructive" data-oauth-return="failed">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}
