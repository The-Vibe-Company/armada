import { ApproveScreen } from "@/components/screens/ValidationsScreen";

// The approval link the coordinator sends (THE-885). Renders from the overview the shell polls,
// which holds the viewer's organization's projects only: another organization's validation is not there.
export default function ApprovePage() {
  return <ApproveScreen />;
}
