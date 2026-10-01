// The routes the Armada CLI calls (`armada login`, `whoami`, `logout`, the
// organization's Linear key, the workers' launch tokens, and the fleet's live
// data). Both proxy gates let them through: each checks its own credential
// (lib/cli-api.ts).
import { after } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { handleCli } from "@/lib/cli-api";
import { PUBLISHED_CLI_VERSION } from "@/lib/cli-version";
import { vaultModeOf } from "@/lib/vault";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handleCli(request, (await params).path, {
    accounts,
    vault: () => vaultModeOf(process.env),
    publishedCli: PUBLISHED_CLI_VERSION,
    after,
  });
}

export { handle as DELETE, handle as GET, handle as POST };
