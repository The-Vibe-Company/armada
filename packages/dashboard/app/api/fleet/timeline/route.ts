import { answerTimeline } from "@/lib/live-http";
import { getOverview } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * The live timeline's history (THE-880): each row's last 24 h and each
 * coordinator's inbox reads, read by the overview only while its timeline is
 * on screen. Postgres only, 304 while nothing moved. Carries no secret.
 */
export async function GET(request: Request) {
  return answerTimeline(request, await getOverview({ timeline: true }));
}
