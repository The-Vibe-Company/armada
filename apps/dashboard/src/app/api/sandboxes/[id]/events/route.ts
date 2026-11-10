import { NextResponse } from "next/server";
import { isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { readLogPages } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ id: string }> };

/** One page of a sandbox's events after `cursor`, and its current status, for the live logs. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const viewer = await requireViewer();
  const supabase = await createClient();
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const gateway = viewerGateway(viewer);
  if (!gateway) {
    return NextResponse.json({ status: sandbox.status, configured: false, events: [], cursor: null, hasMore: false });
  }

  const cursor = new URL(request.url).searchParams.get("cursor");
  try {
    const page = await readLogPages(gateway.logs, id, cursor);
    // Status is optional telemetry. A failed status read must not discard successful logs.
    const detail = (await gateway.status(id).catch(() => ({}))) as { status?: string; prompt?: unknown };
    return NextResponse.json({
      status: detail.status ?? sandbox.status,
      prompt: detail.prompt ?? null,
      configured: true,
      ...page,
    });
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : "The logs could not be read.";
    return NextResponse.json({ status: sandbox.status, configured: true, error: message }, { status: 502 });
  }
}
