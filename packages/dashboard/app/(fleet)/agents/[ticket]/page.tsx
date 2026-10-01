import { AgentScreen } from "@/components/screens/AgentScreen";
import { initialActivity } from "@/lib/server";

// Renders from the overview the shell polls, with the ticket's activity read
// here too (Postgres only): it opens whole, and nothing moves when the page's
// own read of the activity arrives (THE-892).
export default async function AgentPage({ params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  return <AgentScreen initialActivity={await initialActivity(decodeURIComponent(ticket))} />;
}
