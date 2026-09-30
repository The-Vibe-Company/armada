// The routes the Armada CLI calls (`armada login`, `whoami`, `logout`, and
// the organization's keys). Both proxy gates let them through: each checks its
// own credential (lib/cli-api.ts).
import { accounts } from "@/lib/accounts-server";
import { handleCli } from "@/lib/cli-api";
import { vaultModeOf } from "@/lib/vault";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handleCli(request, (await params).path, { accounts, vault: () => vaultModeOf(process.env) });
}

export { handle as DELETE, handle as GET, handle as POST };
