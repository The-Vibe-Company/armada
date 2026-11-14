import { CircleAlertIcon, CircleCheckIcon, InfoIcon, PlugIcon, StarIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AddServerDialog, ServiceCatalog, ServiceMark, ToolPanel, ToolRowAction } from "@/components/connections";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { RowTag, StateCell } from "@/components/state-cell";
import { TemplateUsage } from "@/components/template-usage";
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
import { listSelectedTemplates, type TemplateList } from "@/lib/data/templates";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { type ToolState, toolBlockers, toolFact, toolState } from "@/lib/tools";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Tools" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Tools";
const DESCRIPTION = "Connect external tools and services for your agents.";

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
        <Empty
          title="No organization yet"
          action={
            <Button asChild>
              <Link href="/orgs">Choose an organization</Link>
            </Button>
          }
        >
          Create or join an organization before connecting tools.
        </Empty>
      </>
    );
  }
  if (list.state === "not-configured") {
    return (
      <>
        {header}
        <Alert role="status">
          <InfoIcon />
          <AlertTitle>Tool setup is not ready here</AlertTitle>
          <AlertDescription>
            <p>Ask an Armada administrator to finish setup, then reload Tools.</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href="/tools">Reload Tools</a>
            </Button>
          </AlertDescription>
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
            <p>
              Check your connection and reload Tools. If this continues, ask an Armada administrator to check tool
              setup.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href="/tools">Reload Tools</a>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const isAdmin = selected.role === "admin";
  const [notice, catalog, templates] = await Promise.all([
    returned ? returnNotice(returned, selected.org.id) : null,
    listSelectedCatalog(selected.org.id),
    listSelectedTemplates(),
  ]);
  const services = catalog.state === "ready" ? catalog.services : [];
  const org = { orgId: selected.org.id, orgName: selected.org.name, isAdmin };

  const connectionRows = list.connections.map((connection) => {
    const canManage = connection.scope === "personal" || isAdmin;
    const serviceLabel = services.find((service) => service.id === connection.catalogId)?.label;
    const state = toolState(connection, canManage);
    return { ...connectionRow(connection, state, canManage, serviceLabel, templates), status: state, connection };
  });
  const rows = sortResources<ResourceRow & { bucket: Bucket }>(connectionRows);
  const blockers = toolBlockers(connectionRows.map((row) => ({ ...row, state: row.status })));
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;
  // OAuth returns carry an explicit item too; notices alone must not reopen
  // a dismissed panel when the list is reloaded.
  const initial = requested;

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
                  No ready-to-connect services are offered here. Use Add server to connect another tool.
                </p>
              )
            ) : (
              <p
                className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
                data-catalog-unavailable
              >
                Services could not be loaded here. You can still use Add server to connect a custom tool.
              </p>
            )}
          </section>
        </>
      }
      empty={
        <Empty title="No tools yet" icon={<PlugIcon />}>
          Connect a service below or use Add server to connect another tool for your agents.
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
  templates: TemplateList,
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
    detail: (
      <div className="space-y-4">
        <ToolPanel connection={connection} canManage={canManage} serviceLabel={serviceLabel} />
        <TemplateUsage list={templates} uses={(definition) => definition.connections.includes(connection.id)} />
      </div>
    ),
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
            ? "Review your tool list before trying sign-in again."
            : "Review your tool list, then use Connect if sign-in is still needed."}
        </AlertDescription>
      </Alert>
    );
  }
  let connection: McpConnection;
  try {
    const control = await viewerControl();
    if (!control) return unverifiedReturnNotice();
    connection = await control.status({ org, id: returned.id });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return unverifiedReturnNotice();
  }
  if (connection.status === "connected") {
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
  const title = returned.outcome === "denied" ? "Sign-in was cancelled" : `${connection.name} is not connected`;
  const detail = `${STATUS_INFO[connection.status].label}. Review this tool below for the next step.`;
  return (
    <Alert variant="destructive" data-oauth-return="failed">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}

/** A failed lookup is not evidence that the sign-in failed or that its connection was never saved. */
function unverifiedReturnNotice() {
  return (
    <Alert variant="destructive" data-oauth-return="failed">
      <CircleAlertIcon />
      <AlertTitle>Sign-in status could not be checked</AlertTitle>
      <AlertDescription>
        <p>
          The connection may already have been saved. Reload Tools to check its current state before signing in again.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-2">
          <a href="/tools">Reload Tools</a>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
