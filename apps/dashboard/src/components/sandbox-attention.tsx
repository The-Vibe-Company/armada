import { dockerWorkspaceReclaimedMessage, type Sandbox } from "@armada/core";
import Link from "next/link";
import {
  AddSandboxTime,
  CopyRecoveryCommand,
  PushSandboxWork,
  SandboxAttentionActions,
  SandboxAttentionRefresh,
} from "@/components/sandbox-attention-actions";
import { OutcomeBadge, OutcomeDetail } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { viewerGateway } from "@/lib/data/gateway";
import { listMemberships, type Viewer } from "@/lib/data/viewer";
import { parseEventPage } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import { preservationView } from "@/lib/outcome";
import { sandboxAttention, summarizeEvents, type TurnSummary } from "@/lib/sandbox-attention";
import { createClient } from "@/lib/supabase/server";

/** One bounded, authorized event read; the highest-priority recovery owns the single banner. */
export async function SandboxAttention({
  sandbox,
  viewer,
}: {
  sandbox: Omit<Sandbox, "docker_retention_deadline" | "external_ref">;
  viewer: Viewer;
}) {
  const gateway = viewerGateway(viewer);
  let turn: TurnSummary | null = null;
  if (gateway) {
    try {
      const page = parseEventPage(await gateway.logs(sandbox.id, null, { all: true, limit: 500 }));
      if (!page.hasMore) turn = summarizeEvents(page.events);
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
    }
  }
  const view = sandboxAttention(sandbox, turn, new Date());
  const preserved = preservationView(sandbox.preservation_note, sandbox.status, sandbox.id, true);
  let title: string | null = null;
  let detail: string | null = null;
  let action: React.ReactNode = null;
  const reclaimed = sandbox.status === "deleted" ? dockerWorkspaceReclaimedMessage(sandbox.status_reason) : null;
  if (reclaimed) {
    title = "Workspace reclaimed";
    detail = reclaimed;
  } else if (sandbox.status === "failed") {
    title = view.state.failure?.title ?? "This sandbox failed.";
    detail =
      sandbox.status_reason?.includes("before launching again") ||
      sandbox.status_reason?.startsWith("Runtime credential projection failed.")
        ? sandbox.status_reason
        : "It takes no new messages. Launch a new sandbox to continue.";
    action =
      detail === sandbox.status_reason ? null : (
        <Button asChild size="sm">
          <Link href="/sandboxes">Launch a new one</Link>
        </Button>
      );
  } else if (view.state.failure) {
    title = view.state.failure.title;
    detail = view.state.failure.hint;
    if (view.state.failure.fix)
      action = (
        <Button asChild size="sm">
          <Link href={view.state.failure.fix.href}>
            {view.state.failure.fix.label === "Reconnect the account"
              ? "Reconnect in Models"
              : view.state.failure.fix.label}
          </Link>
        </Button>
      );
  } else if (preserved?.kind === "preserved") {
    title = "Work that was not pushed has been saved.";
    detail = "Get it back with one command in your terminal.";
    if (preserved.command) action = <CopyRecoveryCommand command={preserved.command} />;
  } else if (view.attention === "interrupted" || view.attention === "unconcluded") {
    title =
      view.attention === "interrupted"
        ? "Your message was interrupted before the agent answered."
        : "The agent stopped without saying what it did.";
    action = (
      <SandboxAttentionActions
        sandboxId={sandbox.id}
        name="this sandbox"
        status={sandbox.status}
        configured={gateway !== null}
        busy={false}
        attention={view.attention}
        resend={view.resend}
        ackKey={view.ackKey}
        dismissed={false}
      />
    );
  } else if (view.attention === "expiring") {
    title = `${view.expiry?.text ?? "Little time left"} and the agent is still working.`;
    detail =
      sandbox.provider === "docker"
        ? "The time limit cannot be extended on your own server."
        : "When time is up Armada tries to save work that was not pushed.";
    const memberships = await listMemberships(await createClient(), viewer.id);
    if (
      sandbox.provider !== "docker" &&
      (sandbox.owner_id === viewer.id ||
        memberships.some((item) => item.org.id === sandbox.org_id && item.role === "admin"))
    )
      action = (
        <div className="flex flex-wrap items-start gap-2">
          <AddSandboxTime sandboxId={sandbox.id} />
          <PushSandboxWork sandboxId={sandbox.id} restarts={sandbox.harness !== "claude"} />
        </div>
      );
  } else if (view.state.outcome?.kind === "ready" && view.state.outcome.pr?.href) {
    title = "Ready to merge.";
    action = (
      <Button asChild size="sm">
        <Link href={view.state.outcome.pr.href} target="_blank" rel="noopener noreferrer">
          Open the pull request
        </Link>
      </Button>
    );
  } else if (view.state.outcome?.kind === "blocked") {
    title = "The agent needs your help.";
    detail = view.state.outcome.reason;
  }
  return (
    <>
      <SandboxAttentionRefresh />
      {title && (
        <section
          data-sandbox-attention={view.attention ?? "failed"}
          className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${sandbox.status === "failed" ? "border-destructive/30 bg-destructive/5" : "border-border bg-muted/40"}`}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{title}</p>
            {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
            {sandbox.status === "failed" && view.state.outcome && (
              <div className="mt-2 space-y-1">
                <OutcomeBadge outcome={view.state.outcome} />
                <OutcomeDetail outcome={view.state.outcome} />
              </div>
            )}
          </div>
          {action}
        </section>
      )}
    </>
  );
}
