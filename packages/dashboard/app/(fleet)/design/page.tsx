import { notFound } from "next/navigation";
import { DesignSheet } from "@/components/screens/DesignSheet";
import { designPageEnabled } from "@/lib/fleet-view";

// Every shared component in its states: in development and in the demo only.
export default function DesignPage() {
  if (!designPageEnabled(process.env)) notFound();
  return <DesignSheet />;
}
