import { loadSearchIndex } from "@/lib/fleet-data";
import { answerJson } from "@/lib/live-http";
import { fleetOf } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * ⌘K's search index (THE-895): what the polled overview does not carry
 * (every ticket of each project's last reading, done ones of the last 30
 * days, the pull requests GitHub gave, the attachments' captions), for the
 * viewer's organization. Read once when ⌘K first opens, Postgres only, 304
 * while unchanged. Carries no secret.
 */
export async function GET(request: Request) {
  const { opts, scope } = await fleetOf();
  return answerJson(request, await loadSearchIndex(opts, scope));
}
