"use server";

import VariablesContent from "@/components/pages/variables-content";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";

/** Re-read the caller's metadata and readable variables without invalidating other sections. */
export async function refreshVariables(expectedScope: string, query: Record<string, string | string[] | undefined>) {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (`${viewer.id}:${selected?.org.id ?? "none"}` !== expectedScope)
    throw new Error("The active account or organization changed.");
  return VariablesContent({ searchParams: Promise.resolve(query) });
}
