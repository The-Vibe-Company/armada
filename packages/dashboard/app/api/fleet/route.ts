import { answerOverview, timed } from "@/lib/live-http";
import { getOverview } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The live Fleet overview, polled by the page; 304 while nothing changed. Carries no secret. */
export async function GET(request: Request) {
  return timed("/api/fleet", async () => answerOverview(request, await getOverview()));
}
