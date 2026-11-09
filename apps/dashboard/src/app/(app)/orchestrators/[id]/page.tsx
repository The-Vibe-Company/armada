import type { OrchestratorDetail } from "@armada/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LinkPendingIcon } from "@/components/link-pending";
import { OrchestratorChat } from "@/components/orchestrator-chat";
import { Empty } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listGoldenHistory } from "@/lib/data/goldens";
import { readFailure, viewerOrchestrators } from "@/lib/data/orchestrators";
import { requireViewer } from "@/lib/data/viewer";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { HARNESS_LABELS } from "@/lib/labels";
import { isOrchestratorId } from "@/lib/orchestrators";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Orchestrator" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * One orchestrator, read from the Armada server as the viewer. Its id is the persisted identity: the same page and
 * conversation before and after a stop and resume. Someone else's orchestrator is "not found", as the server says.
 */
export default async function OrchestratorPage({ params }: Props) {
  const { id } = await params;
  if (!isOrchestratorId(id)) notFound();
  const viewer = await requireViewer();
  const api = viewerOrchestrators(viewer);
  let detail: OrchestratorDetail | null = null;
  let problem: ReturnType<typeof readFailure> | null = null;
  if (!api) problem = { failure: "unavailable", message: "The Armada server is not configured for this dashboard." };
  else
    try {
      detail = await api.detail(id);
    } catch (error) {
      problem = readFailure(error);
      if (problem.failure === "rejected") notFound();
    }

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-3 text-muted-foreground">
      <Link href="/orchestrators">
        <LinkPendingIcon>
          <ArrowLeftIcon />
        </LinkPendingIcon>
        Orchestrators
      </Link>
    </Button>
  );

  if (!detail)
    return (
      <>
        {back}
        <Empty title="This orchestrator could not be loaded">{problem?.message}</Empty>
      </>
    );

  const config = detail.orchestrator.configuration;
  const golden = (await listGoldenHistory(await createClient())).find((row) => row.id === config.goldenId);
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        {back}
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{config.name}</h1>
      </div>
      <OrchestratorChat
        key={detail.orchestrator.id}
        initial={detail}
        facts={{
          golden: golden ? `${golden.name}${golden.removed_at ? " (removed)" : ""}` : "Unknown",
          providerLabel: PROVIDER_LABELS[config.provider],
          harnessLabel: HARNESS_LABELS[config.harness],
        }}
      />
    </div>
  );
}
