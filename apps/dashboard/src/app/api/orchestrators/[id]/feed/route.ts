import { NextResponse } from "next/server";
import { readFailure, viewerOrchestrators } from "@/lib/data/orchestrators";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { isOrchestratorId, type OrchestratorFeedEvent } from "@/lib/orchestrators";

type Context = { params: Promise<{ id: string }> };

/** Pages read in one poll before the browser asks again: a long backlog arrives over a few polls, never in one. */
const MAX_PAGES = 10;

/**
 * One poll of an orchestrator: its current detail (state, revision, waits, children) and its events after `cursor`.
 * Both come from the Armada server as the viewer; the server decides visibility, so an orchestrator of someone else
 * is "not found" here too. The cursor is the server's opaque one, kept by the browser for reconnecting.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!isOrchestratorId(id)) return NextResponse.json({ error: "Not found.", failure: "rejected" }, { status: 404 });
  const api = viewerOrchestrators(await requireViewer());
  if (!api)
    return NextResponse.json(
      { error: "The Armada server is not configured for this dashboard.", failure: "unavailable" },
      { status: 503 },
    );
  const org = (await selectedOrganization())?.org.id;
  if (!org) return NextResponse.json({ error: "Not found.", failure: "rejected" }, { status: 404 });
  let cursor = new URL(request.url).searchParams.get("cursor");
  try {
    const detail = await api.detail(org, id);
    const events: OrchestratorFeedEvent[] = [];
    let hasMore = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const read = await api.events(org, id, cursor);
      events.push(...read.events);
      hasMore = read.hasMore;
      const moved = read.cursor !== null && read.cursor !== cursor;
      if (read.cursor) cursor = read.cursor;
      if (!read.hasMore || !moved) break;
    }
    return NextResponse.json({ detail, events, cursor, hasMore }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const read = readFailure(error);
    // An `unavailable` answer is retried, unless the server now says orchestrators are off: then polling stops on that.
    if (read.failure === "uncertain") {
      const capabilities = await api.capabilities().catch(() => null);
      if (capabilities && !capabilities.enabled)
        return NextResponse.json(
          { error: capabilities.message, failure: "unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
    }
    const { failure, message } = read;
    const status = failure === "session" ? 401 : failure === "rejected" ? 404 : 502;
    return NextResponse.json({ error: message, failure }, { status, headers: { "cache-control": "no-store" } });
  }
}
