import { Fleet } from "@/components/Fleet";
import { InsightsLine } from "@/components/insights/InsightsLine";
import { initialInsightsLine, initialSince } from "@/lib/server";

// The overview (THE-867): what waits for the owner, what is broken, and each
// project; this week's delivery (THE-893) and what happened while the viewer
// was away (THE-894) are read with the page, so they are there at once and
// move nothing (THE-892, THE-899).
export default async function Home() {
  const [line, since] = await Promise.all([initialInsightsLine(), initialSince()]);
  return <Fleet insights={<InsightsLine initial={line} />} since={since} />;
}
