import { insightsSummary, isInsightRange } from "@armada/core/read";
import { loadInsights } from "@/lib/fleet-data";
import { answerJson } from "@/lib/live-http";
import { fleetOf } from "@/lib/server";
import { isProjectSlug } from "@/lib/workers";

export const dynamic = "force-dynamic";

/**
 * The overview's Insights line (THE-893): the range's merges, their median
 * claim to merge and the change from the period before. Postgres only, kept a
 * minute per project and range, 304 while unchanged, 404 for a project the
 * viewer may not see. Carries no secret.
 */
export async function GET(request: Request) {
  const { opts, scope } = await fleetOf();
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "7d";
  const project = url.searchParams.get("project");
  if (!isInsightRange(range) || (project !== null && !isProjectSlug(project)))
    return Response.json({ error: "range is 7d, 30d or 90d; project a slug" }, { status: 400 });
  const reading = await loadInsights(opts, scope, { range, project });
  if (!reading) return Response.json({ error: "no such project" }, { status: 404 });
  return answerJson(request, { range, project, live: reading.live, summary: insightsSummary(reading.insights) });
}
