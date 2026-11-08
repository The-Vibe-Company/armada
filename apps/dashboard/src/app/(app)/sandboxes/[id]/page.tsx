import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SandboxActions } from "@/components/sandbox-actions";
import { SandboxLogs } from "@/components/sandbox-logs";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isUuid } from "@/lib/action";
import { listGoldens } from "@/lib/data/goldens";
import { getSandbox } from "@/lib/data/sandboxes";
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
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) notFound();

  const memberships = await listMemberships(supabase, viewer.id);
  const [goldens, directory] = await Promise.all([
    listGoldens(supabase),
    memberDirectory(
      supabase,
      memberships.map((item) => item.org.id),
    ),
  ]);
  const golden = goldens.find((item) => item.id === sandbox.golden_id);
  const org = memberships.find((item) => item.org.id === sandbox.org_id);
  const configured = mcpUrl() !== null;

  const facts: [string, string][] = [
    ["Golden", golden?.name ?? "Unknown"],
    ["Org", org?.org.name ?? "Unknown"],
    ["Harness", sandbox.harness],
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
            <ArrowLeftIcon /> Sandboxes
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{sandbox.boat_id}</h1>
            <StatusBadge status={sandbox.status} />
          </div>
          {configured && <SandboxActions sandboxId={sandbox.id} status={sandbox.status} />}
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
