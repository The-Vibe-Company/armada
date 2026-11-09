import { CircleAlertIcon, CircleCheckIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AddConnectionDialog, ConnectionCard, ServiceCatalog } from "@/components/connections";
import { Empty, PageHeader, SectionHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  type McpCatalogService,
  type McpConnection,
  type OAuthReturn,
  oauthReturn,
  STATUS_INFO,
} from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedCatalog, listSelectedConnections, viewerControl } from "@/lib/data/connections";
import { selectedOrganization } from "@/lib/data/selected-org";

export const metadata: Metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ConnectionsPage({ searchParams }: Props) {
  const selected = await selectedOrganization();
  const list = await listSelectedConnections();
  const returned = oauthReturn(await searchParams);

  const header = (
    <PageHeader title="Connections">
      {selected && list.state === "ready" && (
        <AddConnectionDialog orgId={selected.org.id} orgName={selected.org.name} isAdmin={selected.role === "admin"} />
      )}
    </PageHeader>
  );

  if (!selected || list.state === "no-org") {
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>{" "}
          to add connections.
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
          <AlertDescription>The Armada server is not configured: connections cannot be managed here.</AlertDescription>
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
          <AlertTitle>Connections could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{list.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/connections">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const isAdmin = selected.role === "admin";
  const personal = list.connections.filter((item) => item.scope === "personal");
  const shared = list.connections.filter((item) => item.scope === "org");
  const [notice, catalog] = await Promise.all([
    returned ? returnNotice(returned, selected.org.id) : null,
    listSelectedCatalog(selected.org.id),
  ]);
  const services = catalog.state === "ready" ? catalog.services : [];

  return (
    <>
      {header}
      {notice}
      <section className="space-y-3" aria-label="Services">
        <SectionHeader title="Services" description="Sign in once, then pick it when you launch." />
        {catalog.state === "ready" ? (
          services.length > 0 ? (
            <ServiceCatalog
              services={services}
              connections={list.connections}
              orgId={selected.org.id}
              orgName={selected.org.name}
              isAdmin={isAdmin}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No services offered. Add a custom server instead.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground" data-catalog-unavailable>
            Services are not available: {catalog.message} You can still add a custom server.
          </p>
        )}
      </section>
      <ConnectionSection
        title="Your connections"
        icon={<UserIcon />}
        description="Only in the sandboxes you launch."
        connections={personal}
        services={services}
        canManage
        empty="No personal connections."
      />
      <ConnectionSection
        title={`${selected.org.name} connections`}
        icon={<UsersIcon />}
        description={isAdmin ? "Every member. You manage them." : "Every member. Only an admin changes them."}
        connections={shared}
        services={services}
        canManage={isAdmin}
        empty="No org connections."
      />
    </>
  );
}

function ConnectionSection({
  title,
  icon,
  description,
  connections,
  services,
  canManage,
  empty,
}: {
  title: string;
  icon: ReactNode;
  description: string;
  connections: McpConnection[];
  services: readonly McpCatalogService[];
  canManage: boolean;
  empty: string;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <SectionHeader
        title={title}
        description={
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
            {icon}
            {description}
          </span>
        }
      />
      {connections.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              canManage={canManage}
              serviceLabel={services.find((service) => service.id === connection.catalogId)?.label}
            />
          ))}
        </ul>
      )}
    </section>
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
