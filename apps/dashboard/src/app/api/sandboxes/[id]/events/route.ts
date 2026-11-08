import { NextResponse } from "next/server";
import { isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { parseEventPage } from "@/lib/events";
import { GatewayError } from "@/lib/gateway";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ id: string }> };

const MAX_LOG_PAGES = 100;

export async function readLogPages(
  logs: (id: string, cursor?: string | null) => Promise<unknown>,
  id: string,
  initialCursor: string | null,
) {
  const events = [];
  let cursor = initialCursor;
  let hasMore = false;
  for (let pageNumber = 0; pageNumber < MAX_LOG_PAGES; pageNumber += 1) {
    const page = parseEventPage(await logs(id, cursor));
    events.push(...page.events);
    hasMore = page.hasMore;
    if (!page.hasMore || !page.cursor || page.cursor === cursor) {
      cursor = page.cursor ?? cursor;
      break;
    }
    cursor = page.cursor;
  }
  return { events, cursor, hasMore };
}

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
    return NextResponse.json({ status: sandbox.status, configured: true, ...page });
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : "The logs could not be read.";
    return NextResponse.json({ status: sandbox.status, configured: true, error: message }, { status: 502 });
  }
}
