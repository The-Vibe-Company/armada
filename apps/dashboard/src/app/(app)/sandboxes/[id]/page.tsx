import { MODEL_CATALOG } from "@armada/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectionStatusBadge, ScopeBadge } from "@/components/connections";
import { LinkPendingIcon } from "@/components/link-pending";
import { SandboxActions } from "@/components/sandbox-actions";
import { SandboxLogs } from "@/components/sandbox-logs";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isUuid } from "@/lib/action";
import { sandboxVisibility } from "@/lib/connections";
import { listSandboxConnections, type SandboxConnections } from "@/lib/data/connections";
import { listGoldens } from "@/lib/data/goldens";
import { getSandbox } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { isActiveStatus } from "@/lib/events";
import { sandboxRepositoryDir } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function SandboxPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const pending = listMemberships(supabase, viewer.id).then((items) =>
    items.filter((item) => item.org.id === selected?.org.id),
  );
  const [sandbox, goldens, memberships, directory] = await Promise.all([
    getSandbox(supabase, id),
    listGoldens(supabase),
    pending,
    pending.then((items) =>
      memberDirectory(
        supabase,
        items.map((item) => item.org.id),
      ),
    ),
  ]);
  if (!sandbox) notFound();
  const golden = goldens.find((item) => item.id === sandbox.golden_id);
  const org = memberships.find((item) => item.org.id === sandbox.org_id);
  const configured = mcpUrl() !== null;
  const applied = await listSandboxConnections(sandbox);
  const visibility = sandboxVisibility(sandbox);
  const repositoryDir = sandboxRepositoryDir(sandbox);

  const facts: [string, string][] = [
    ["Golden", golden?.name ?? "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Provider", sandbox.provider],
    ["Harness", sandbox.harness],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
    ...(visibility
      ? [
          ["Visibility", visibility === "private" ? "Private (only its owner)" : "Org (every member)"] as [
            string,
            string,
          ],
        ]
      : []),
    ...(repositoryDir ? [["Repository context", repositoryDir] as [string, string]] : []),
    ["Owner", displayUser(directory, sandbox.owner_id, viewer.id)],
    ["Created", formatDate(sandbox.created_at)],
    ["Stopped", sandbox.stopped_at ? formatDate(sandbox.stopped_at) : "Not stopped"],
    ["Conversations", String(sandbox.conversation_ids.length)],
  ];

  return (
    <>
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link href="/sandboxes">
            <LinkPendingIcon>
              <ArrowLeftIcon />
            </LinkPendingIcon>
            Sandboxes
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{sandbox.provider_sandbox_id}</h1>
            <StatusBadge status={sandbox.status} />
          </div>
          {configured && (
            <SandboxActions
              sandboxId={sandbox.id}
              status={sandbox.status}
              harness={sandbox.harness}
              catalog={MODEL_CATALOG}
              launchedModel={sandbox.model}
            />
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP connections</CardTitle>
        </CardHeader>
        <CardContent>
          <AppliedConnections applied={applied} />
        </CardContent>
      </Card>

      <SandboxLogs sandboxId={sandbox.id} initialStatus={sandbox.status} live={isActiveStatus(sandbox.status)} />
    </>
  );
}

/** What the registry bound at launch. A failed read says so; it is never shown as "no connections". */
function AppliedConnections({ applied }: { applied: SandboxConnections }) {
  if (applied.state === "not-configured") {
    return <p className="text-sm text-muted-foreground">The Armada server is not configured for this dashboard.</p>;
  }
  if (applied.state === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        The connections of this sandbox could not be loaded: {applied.message}
      </p>
    );
  }
  if (applied.connections.length === 0) {
    return <p className="text-sm text-muted-foreground">Launched without MCP connections you can see.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Applied connections">
      {applied.connections.map((connection) => (
        <li key={connection.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="font-medium">{connection.name}</span>
          <ScopeBadge scope={connection.scope} />
          <ConnectionStatusBadge connection={connection} />
          {connection.status !== "connected" && (
            <span className="text-xs text-muted-foreground">
              New sessions cannot reach it until it is connected again.
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatDate(iso: string): string {
  return `${new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC`;
}
