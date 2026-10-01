import { requireFleetAccess, scopeOf } from "@/lib/access";
import { appDatabase } from "@/lib/app-db";
import { serveAttachment } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await requireFleetAccess().catch(() => null);
  const scope = access ? scopeOf(access) : null;
  if (!scope)
    return Response.json(
      { error: "organization membership is required" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  const db = await appDatabase();
  if (!db) return Response.json({ error: "attachments unavailable" }, { status: 503 });
  return serveAttachment(db, scope, (await context.params).id);
}
