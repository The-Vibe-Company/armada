import { CircleAlertIcon, CircleCheckIcon, PlugIcon, StarIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AddServerDialog, ServiceCatalog, ServiceMark, ToolPanel, ToolRowAction } from "@/components/connections";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { RowTag, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  authLabel,
  hostOf,
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
import { type ToolState, toolBlockers, toolFact, toolState } from "@/lib/tools";
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
  const org = { orgId: selected.org.id, orgName: selected.org.name, isAdmin };

  const connectionRows = list.connections.map((connection) => {
    const canManage = connection.scope === "personal" || isAdmin;
    const serviceLabel = services.find((service) => service.id === connection.catalogId)?.label;
    const state = toolState(connection, canManage);
    return { ...connectionRow(connection, state, canManage, serviceLabel), status: state, connection };
  });
  const rows = sortResources<ResourceRow & { bucket: Bucket }>(connectionRows);
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
      actions={<AddServerDialog {...org} />}
      footer={
        <>
          <p className="text-xs text-muted-foreground">
            Personal tools reach only the sandboxes you launch. Org tools reach every member's;{" "}
            {isAdmin ? "you manage them." : "only an admin changes them."}
          </p>
          <section aria-labelledby="services-title" className="space-y-3 pt-5">
            <div className="space-y-0.5">
              <h2 id="services-title" className="text-base font-semibold tracking-tight">
                Services
              </h2>
              <p className="text-sm text-muted-foreground">
                Sign in once with the account Armada should use. For anything else, use Add server.
              </p>
            </div>
            {catalog.state === "ready" ? (
              services.length > 0 ? (
                <ServiceCatalog services={services} connections={list.connections} {...org} />
              ) : (
                <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  This Armada server offers no services. Add any MCP server with Add server.
                </p>
              )
            ) : (
              <p
                className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
                data-catalog-unavailable
              >
                Services are not available: {catalog.message} You can still add a custom server.
              </p>
            )}
          </section>
        </>
      }
      empty={
        <Empty title="No tools yet" icon={<PlugIcon />}>
          Connect a service below or add any MCP server; agents pick it when they launch.
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
