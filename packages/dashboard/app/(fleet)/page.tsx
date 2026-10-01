import { Fleet } from "@/components/Fleet";
import { InsightsLine } from "@/components/insights/InsightsLine";
import { initialInsightsLine } from "@/lib/server";

// The overview (THE-867): what waits for the owner, what is broken, and each
// project; under its summary, this week's delivery (THE-893), read with the
// page so it is there at once and moves nothing (THE-892).
export default async function Home() {
  return <Fleet insights={<InsightsLine initial={await initialInsightsLine()} />} />;
}
