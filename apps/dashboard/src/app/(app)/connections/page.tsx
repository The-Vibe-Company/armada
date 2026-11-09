import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AddConnectionDialog, ConnectionCard } from "@/components/connections";
import { Empty, PageHeader } from "@/components/page-header";
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
    <PageHeader
      title="Connections"
      description="MCP servers connected once, then selected when you launch a sandbox. Claude Code and Codex both get them."
    >
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
          <AlertDescription>
            The Armada server is not configured for this dashboard (ARMADA_MCP_URL), so connections cannot be managed.
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
      <Alert role="note">
        <InfoIcon />
        <AlertDescription>
          <p>
            <span className="font-medium text-foreground">Personal</span> connections use your own account and only
            reach your private sandboxes, including private launches from a shared golden.{" "}
            <span className="font-medium text-foreground">Org</span> connections are added by an admin with an account
            meant for sharing; they are the only ones an org-visible sandbox can use. Sharing never hands out your
            personal sign-in.
          </p>
        </AlertDescription>
      </Alert>

      <ConnectionSection
        title="Your connections"
        description={`Personal, in ${selected.org.name}. Nobody else sees or uses them.`}
        connections={personal}
        canManage
        empty="Add a server with your own account, then pick it when you launch a private sandbox."
      />
      <ConnectionSection
        title={`${selected.org.name} connections`}
        description={
          isAdmin
            ? "Shared with every member's org sandboxes. You are an admin: you manage them."
            : "Shared with every member's org sandboxes. Only an admin adds or changes them."
        }
        connections={shared}
        canManage={isAdmin}
        empty={isAdmin ? "Add one with Org selected under Who uses it." : "No admin has shared a connection yet."}
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
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {connections.length === 0 ? (
        <Empty title="No connections">{empty}</Empty>
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
