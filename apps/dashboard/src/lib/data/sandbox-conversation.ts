import { idlePauseMessage, isRecord } from "@armada/core";
import { isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { conversationReadDirection, parseEventPage, readLogPages } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import { createClient } from "@/lib/supabase/server";
import { usageRevision } from "@/lib/usage-revision";

export async function readSandboxConversation(id: string, cursor: string | null, source: "history" | "follow") {
  if (!isUuid(id)) return { body: { error: "Not found." }, status: 404 };

  const viewer = await requireViewer();
  const supabase = await createClient();
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) return { body: { error: "Not found." }, status: 404 };

  const persistedMessage = idlePauseMessage(
    { status: sandbox.status, statusReason: sandbox.status_reason, expiresAt: sandbox.expires_at },
    new Date(),
  );
  const persistedRevision = usageRevision(sandbox.usage_turns);
  const gateway = viewerGateway(viewer);
  if (!gateway) {
    return {
      body: {
        status: sandbox.status,
        statusMessage: persistedMessage,
        usageRevision: persistedRevision,
        configured: false,
        events: [],
        cursor: null,
        hasMore: false,
      },
      status: 200,
    };
  }

  const backward = conversationReadDirection(sandbox, source) === "backward";
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
    return { body: { ...(await metadata()), configured: true, ...page }, status: 200 };
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : "The logs could not be read.";
    return { body: { ...(await metadata()), configured: true, error: message }, status: 502 };
  }
}
