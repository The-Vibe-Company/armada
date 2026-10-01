import { loadAgentActivity } from "@/lib/fleet-data";
import { answerJson, timed } from "@/lib/live-http";
import { fleetOf } from "@/lib/server";
import { isProjectSlug, isTicketId } from "@/lib/workers";

export const dynamic = "force-dynamic";

/**
 * One ticket's activity, read again by its agent's page when the ticket moves
 * (THE-869; its first render carries it, THE-892): Postgres only, 304 while
 * nothing changed, 404 for a project the viewer may not see. Carries no secret.
 */
export async function GET(request: Request) {
  return timed("/api/fleet/activity", () => answerActivity(request));
}

async function answerActivity(request: Request): Promise<Response> {
  const { opts, scope } = await fleetOf();
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const ticket = url.searchParams.get("ticket")?.toUpperCase();
  if (!isProjectSlug(project) || !isTicketId(ticket))
    return Response.json({ error: "project and ticket are required" }, { status: 400 });
  const activity = await loadAgentActivity(opts, scope, project, ticket);
  if (!activity) return Response.json({ error: "no such project" }, { status: 404 });
  return answerJson(request, activity);
}
