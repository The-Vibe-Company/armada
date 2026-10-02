import { OverviewScreen } from "@/components/screens/OverviewScreen";

// The overview (THE-916): the sessions in flight, grouped by coordinator.
// Renders from the overview the shell polls: no server data here, so it opens without waiting.
export default function Home() {
  return <OverviewScreen />;
}
