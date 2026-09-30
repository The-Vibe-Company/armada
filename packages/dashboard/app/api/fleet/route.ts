import { getOverview } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The live Fleet overview, polled by the page every few seconds. Carries no secret. */
export async function GET() {
  return Response.json(await getOverview(), { headers: { "Cache-Control": "no-store" } });
}
