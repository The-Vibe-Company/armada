import { STATS_VARIABLE, statsRoute } from "@/lib/stats";
import { statsAccounts } from "@/lib/stats-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return statsRoute(request, { token: process.env[STATS_VARIABLE], accounts: statsAccounts });
}
