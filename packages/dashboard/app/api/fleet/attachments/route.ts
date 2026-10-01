import { requireFleetAccess, scopeOf } from "@/lib/access";
import { appDatabase } from "@/lib/app-db";
import { listTicketAttachments } from "@/lib/attachments";
import { isProjectSlug, isTicketId } from "@/lib/workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireFleetAccess().catch(() => null);
  const scope = access ? scopeOf(access) : null;
  const headers = { "Cache-Control": "private, no-store" };
  if (!scope) return Response.json({ error: "organization membership is required" }, { status: 403, headers });
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const ticket = url.searchParams.get("ticket")?.toUpperCase();
  if (!isProjectSlug(project) || !isTicketId(ticket))
    return Response.json({ error: "project and ticket are required" }, { status: 400, headers });
  const db = await appDatabase();
  if (!db) return Response.json({ error: "attachments unavailable" }, { status: 503, headers });
  const attachments = await listTicketAttachments(db, scope, project, ticket);
  return attachments
    ? Response.json({ attachments }, { headers })
    : Response.json({ error: "organization membership is required" }, { status: 403, headers });
}
