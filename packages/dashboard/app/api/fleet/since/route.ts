import { awayWindow, showSummary } from "@armada/core/read";
import { requireFleetAccess } from "@/lib/access";
import { appDatabase } from "@/lib/app-db";
import { loadCatchup } from "@/lib/fleet-data";
import { answerJson } from "@/lib/live-http";
import { fleetOf } from "@/lib/server";
import { viewerKey } from "@/lib/viewer";
import { readVisit } from "@/lib/visits";

export const dynamic = "force-dynamic";

/**
 * "Since you were away" (THE-894), read by the overview when the shell's
 * beacon says there is one: what merged, started and got stuck while the
 * viewer was away, and what waits for them now. Postgres only, 304 while
 * unchanged; `{ summary: null }` when there is none to show. Carries no secret.
 */
export async function GET(request: Request) {
  const access = await requireFleetAccess();
  const db = await appDatabase().catch(() => null);
  const key = db && (await viewerKey(access, false));
  if (!db || !key) return answerJson(request, { summary: null });
  const now = new Date();
  const visit = await readVisit(db, key);
  const window = showSummary(visit, now) ? awayWindow(visit, now) : null;
  if (!window) return answerJson(request, { summary: null });
  const { opts, scope } = await fleetOf(access);
  const summary = await loadCatchup(opts, scope, { since: new Date(window.since), until: new Date(window.until) });
  return answerJson(request, { summary });
}
