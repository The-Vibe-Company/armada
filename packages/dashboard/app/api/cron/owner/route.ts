import { accounts } from "@/lib/accounts-server";
import { ownerCron } from "@/lib/owner-cron";
import { vaultModeOf } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return ownerCron(request, { secret: process.env.CRON_SECRET, accounts, vault: () => vaultModeOf(process.env) });
}
