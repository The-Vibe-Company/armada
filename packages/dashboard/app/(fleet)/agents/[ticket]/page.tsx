import { redirect } from "next/navigation";
import { AgentScreen } from "@/components/screens/AgentScreen";
import { attachmentHref } from "@/lib/fleet-view";
import { initialActivity } from "@/lib/server";

type Search = Promise<Record<string, string | string[] | undefined>>;

// Renders from the overview the shell polls, with the ticket's activity read
// here too (Postgres only): it opens whole, and nothing moves when the page's
// own read of the activity arrives (THE-892). The link `armada attach` prints
// opens the attachment itself.
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticket: string }>;
  searchParams: Search;
}) {
  const [{ ticket }, search] = await Promise.all([params, searchParams]);
  const attachment = attachmentHref(search);
  if (attachment) redirect(attachment);
  return <AgentScreen initialActivity={await initialActivity(decodeURIComponent(ticket))} />;
}
