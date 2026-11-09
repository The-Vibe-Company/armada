import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AddConnectionDialog, ConnectionCard } from "@/components/connections";
import { Empty, PageHeader, SectionHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type McpConnection, type OAuthReturn, oauthReturn, STATUS_INFO } from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedConnections, viewerControl } from "@/lib/data/connections";
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
  const notice = returned ? await returnNotice(returned, selected.org.id) : null;

  return (
    <>
      {header}
      {notice}
      <ConnectionSection
        title="Your connections"
        description="Only you. Private sandboxes only."
        connections={personal}
        canManage
        empty="No personal connections."
      />
      <ConnectionSection
        title={`${selected.org.name} connections`}
        description={isAdmin ? "Every member. You manage them." : "Every member. Only an admin adds or changes them."}
        connections={shared}
        canManage={isAdmin}
        empty="No org connections."
      />
    </>
  );
}

function ConnectionSection({
  title,
  description,
  connections,
  canManage,
  empty,
}: {
  title: string;
  description: string;
  connections: McpConnection[];
  canManage: boolean;
  empty: string;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <SectionHeader title={title} description={description} />
      {connections.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} canManage={canManage} />
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
