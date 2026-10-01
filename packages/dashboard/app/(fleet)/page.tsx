import { Fleet } from "@/components/Fleet";
import { InsightsLine } from "@/components/insights/InsightsLine";

// The overview (THE-867): what waits for the owner, what is broken, and each
// project; under its summary, this week's delivery (THE-893).
export default function Home() {
  return <Fleet insights={<InsightsLine />} />;
}
