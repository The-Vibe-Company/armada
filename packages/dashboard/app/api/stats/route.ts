import { accounts } from "@/lib/accounts-server";
import { STATS_VARIABLE, statsRoute } from "@/lib/stats";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return statsRoute(request, { token: process.env[STATS_VARIABLE], accounts });
}
