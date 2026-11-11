import { NextResponse } from "next/server";
import { isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { readLogPages } from "@/lib/events";
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

  const persistedRevision = usageRevision(sandbox.usage_turns);
  const gateway = viewerGateway(viewer);
  if (!gateway) {
    return NextResponse.json({
      status: sandbox.status,
      usageRevision: persistedRevision,
      configured: false,
      events: [],
      cursor: null,
      hasMore: false,
    });
  }

  const cursor = new URL(request.url).searchParams.get("cursor");
  // A broken log lane must not prevent status from collecting delayed usage.
  const statusRead = gateway.status(id).catch(() => ({}));
  const metadata = async () => {
    const detail = (await statusRead) as { status?: string; prompt?: unknown; usage?: unknown };
    return {
      status: detail.status ?? sandbox.status,
      prompt: detail.prompt ?? null,
      usageRevision: detail.usage === undefined ? persistedRevision : usageRevision(detail.usage),
    };
  };
  try {
    const page = await readLogPages(gateway.logs, id, cursor);
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
