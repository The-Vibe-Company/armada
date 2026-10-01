import { showSummary, visitSince } from "@armada/core/read";
import { requireFleetAccess } from "@/lib/access";
import { appDatabase } from "@/lib/app-db";
import { sameOrigin } from "@/lib/auth-http";
import { NOTIFY_OFF, notifyOf, type VisitAnswer } from "@/lib/notify";
import { viewerKey } from "@/lib/viewer";
import { dismissSummary, readVisit, recordVisit, saveNotify } from "@/lib/visits";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * The shell's visit beacon (THE-894): records that the viewer is here and
 * answers with where "since you were away" starts, when their last visit
 * was more than 30 minutes ago and they did not dismiss it (the overview
 * reads the summary itself, `/api/fleet/since`), and their notification
 * settings. `{ dismiss: <since> }` hides that summary, `{ notify: <settings> }`
 * keeps their settings; neither counts as a visit. One write, no fleet read.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  const access = await requireFleetAccess();
  const db = await appDatabase().catch(() => null);
  const empty: VisitAnswer = { since: null, notify: NOTIFY_OFF };
  if (!db) return Response.json(empty, { headers: NO_STORE });
  const key = await viewerKey(access, true);
  if (!key) return Response.json(empty, { headers: NO_STORE });
  const body = (await request.json().catch(() => ({}))) as { dismiss?: unknown; notify?: unknown };
  const now = new Date();
  if (body.notify !== undefined) {
    const notify = notifyOf(body.notify);
    if (!notify) return Response.json({ error: "notify is { on, quiet: { from, to } | null }" }, { status: 400 });
    await saveNotify(db, key, notify, now);
  }
  if (body.dismiss !== undefined) {
    const since = typeof body.dismiss === "string" ? new Date(body.dismiss) : null;
    if (!since || Number.isNaN(since.getTime()))
      return Response.json({ error: "dismiss is the summary's start" }, { status: 400 });
    await dismissSummary(db, key, since);
  }
  const visit =
    body.notify === undefined && body.dismiss === undefined
      ? await recordVisit(db, key, now)
      : await readVisit(db, key);
  const answer: VisitAnswer = { since: showSummary(visit, now) ? visitSince(visit, now) : null, notify: visit.notify };
  return Response.json(answer, { headers: NO_STORE });
}
