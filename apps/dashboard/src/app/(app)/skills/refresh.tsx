"use server";

import SkillsContent from "@/components/pages/skills-content";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";

/** Render as the current caller without invalidating other cached sections. */
export async function refreshSkills(expectedScope: string) {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (`${viewer.id}:${selected?.org.id ?? "none"}` !== expectedScope)
    throw new Error("The active account or organization changed.");
  return SkillsContent();
}
