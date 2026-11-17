import { idlePauseMessage, isRecord } from "@armada/core";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { parseEventPage, readLogPages } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import { createClient } from "@/lib/supabase/server";
import { usageRevision } from "@/lib/usage-revision";

type Context = { params: Promise<{ id: string }> };

/** One page of a sandbox's events after `cursor`, and its current status, for the live logs. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const viewer = await requireViewer();
  const supabase = await createClient();
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const persistedMessage = idlePauseMessage(
    { status: sandbox.status, statusReason: sandbox.status_reason, expiresAt: sandbox.expires_at },
    new Date(),
  );
  const persistedRevision = usageRevision(sandbox.usage_turns);
  const gateway = viewerGateway(viewer);
  if (!gateway) {
    return NextResponse.json({
      status: sandbox.status,
      statusMessage: persistedMessage,
      usageRevision: persistedRevision,
      configured: false,
      events: [],
      cursor: null,
      hasMore: false,
    });
  }

  const params = new URL(request.url).searchParams;
  const cursor = params.get("cursor");
  // Native Boat cursors track mutable provider rows only on forward reads.
  const retained = sandbox.provider === "docker" || sandbox.runtime_transport === "dialout" || sandbox.boat_runtime;
  const backward = retained && (!cursor || params.get("direction") === "backward");
  // A broken log lane must not prevent status from collecting delayed usage.
  let observedStatus: unknown;
  const statusRead = () => gateway.status(id).catch(() => ({}));
  const metadata = async () => {
    const detail = (observedStatus ?? (await statusRead())) as {
      status?: string;
      statusMessage?: string | null;
      prompt?: unknown;
      usage?: unknown;
    };
    return {
      status: detail.status ?? sandbox.status,
      statusMessage:
        detail.statusMessage !== undefined
          ? detail.statusMessage
          : detail.status === undefined || detail.status === sandbox.status
            ? persistedMessage
            : null,
      prompt: detail.prompt ?? null,
      usageRevision: detail.usage === undefined ? persistedRevision : usageRevision(detail.usage),
    };
  };
  try {
    const raw = await gateway.logs(id, cursor, backward ? { direction: "backward" } : {});
    if (isRecord(raw) && isRecord(raw.threadStatus)) observedStatus = raw.threadStatus;
    const page = backward
      ? { ...parseEventPage(raw), backward: true }
      : await readLogPages(async () => raw, id, cursor);
    return NextResponse.json({
      ...(await metadata()),
      configured: true,
      ...page,
    });
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : "The logs could not be read.";
    return NextResponse.json({ ...(await metadata()), configured: true, error: message }, { status: 502 });
  }
}
