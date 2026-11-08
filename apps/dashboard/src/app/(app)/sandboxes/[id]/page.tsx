import { MODEL_CATALOG } from "@armada/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LinkPendingIcon } from "@/components/link-pending";
import { SandboxActions } from "@/components/sandbox-actions";
import { SandboxLogs } from "@/components/sandbox-logs";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isUuid } from "@/lib/action";
import { listGoldens } from "@/lib/data/goldens";
import { getSandbox } from "@/lib/data/sandboxes";
import { selectedOrganization } from "@/lib/data/selected-org";
import { displayUser, listMemberships, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { isActiveStatus } from "@/lib/events";
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

  const facts: [string, string][] = [
    ["Golden", golden?.name ?? "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Harness", sandbox.harness],
    ["Model", sandbox.model ?? "Provider default"],
    ["Reasoning effort", sandbox.reasoning_effort ?? "Provider default"],
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
            <h1 className="font-mono text-xl font-semibold tracking-tight">{sandbox.boat_id}</h1>
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

      <SandboxLogs sandboxId={sandbox.id} initialStatus={sandbox.status} live={isActiveStatus(sandbox.status)} />
    </>
  );
}

function formatDate(iso: string): string {
  return `${new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC`;
}
