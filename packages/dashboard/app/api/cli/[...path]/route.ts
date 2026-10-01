// The routes the Armada CLI calls (`armada login`, `whoami`, `logout`, the
// organization's Linear key, the workers' launch tokens, and the fleet's live
// data). Both proxy gates let them through: each checks its own credential
// (lib/cli-api.ts).
import { accounts } from "@/lib/accounts-server";
import { handleCli } from "@/lib/cli-api";
import { vaultModeOf } from "@/lib/vault";

export const dynamic = "force-dynamic";
// `armada inbox --wait` holds a read open up to 25 s (INBOX_WAIT_MAX_MS): well within this.
export const maxDuration = 60;

async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handleCli(request, (await params).path, { accounts, vault: () => vaultModeOf(process.env) });
}

export { handle as DELETE, handle as GET, handle as POST };
