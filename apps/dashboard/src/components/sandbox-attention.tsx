import type { Sandbox } from "@armada/core";
import { cookies } from "next/headers";
import Link from "next/link";
import { SandboxAttentionActions, SandboxAttentionRefresh } from "@/components/sandbox-attention-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { viewerGateway } from "@/lib/data/gateway";
import type { Viewer } from "@/lib/data/viewer";
import { parseEventPage } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import {
  ACK_COOKIE,
  attentionLabel,
  readAcks,
  sandboxAttention,
  summarizeEvents,
  type TurnSummary,
} from "@/lib/sandbox-attention";

/** Called only after getSandbox authorized the interior. One bounded event read, never an org-wide board scan. */
export async function SandboxAttention({ sandbox, viewer }: { sandbox: Sandbox; viewer: Viewer }) {
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
  if (!view.attention) return <SandboxAttentionRefresh />;
  const dismissed = readAcks((await cookies()).get(ACK_COOKIE)?.value, viewer.id).includes(view.ackKey);
  return (
    <>
      <SandboxAttentionRefresh />
      <Card data-sandbox-attention={view.attention} className="gap-3 py-5">
        <CardHeader className="px-5">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            {attentionLabel(view.attention, sandbox.status)}
            {dismissed && <Badge variant="secondary">Acknowledged</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-5 text-sm">
          {view.state.failure && (
            <div className="space-y-2" data-failure>
              <p className="font-medium text-destructive">{view.state.failure.title}</p>
              {view.state.failure.hint && <p className="text-muted-foreground">{view.state.failure.hint}</p>}
              {view.state.failure.fix && (
                <Button asChild variant="outline" size="sm">
                  <Link href={view.state.failure.fix.href}>{view.state.failure.fix.label}</Link>
                </Button>
              )}
            </div>
          )}
          {view.state.interruption && (
            <p className="text-muted-foreground" data-interruption>
              {view.state.interruption}
            </p>
          )}
          {view.attention === "expiring" && (
            <p className="text-warning" data-expiry="urgent">
              {view.expiry?.text}
            </p>
          )}
          <SandboxAttentionActions
            sandboxId={sandbox.id}
            name={sandbox.provider_sandbox_id ?? sandbox.id}
            status={sandbox.status}
            configured={gateway !== null}
            busy={view.state.kind === "working"}
            attention={view.attention}
            resend={view.resend}
            ackKey={view.ackKey}
            dismissed={dismissed}
          />
        </CardContent>
      </Card>
    </>
  );
}
