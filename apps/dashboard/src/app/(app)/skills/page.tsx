import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import SkillsContent from "@/components/pages/skills-content";
import { RevalidatingContent } from "@/components/revalidating-content";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { refreshSkills } from "./refresh";

export const metadata: Metadata = { title: "Skills" };
export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  const scope = `${viewer.id}:${selected?.org.id ?? "none"}`;
  const renderId = randomUUID();
  return (
    <RevalidatingContent
      key={renderId}
      scope={scope}
      path="/skills"
      renderId={renderId}
      refresh={refreshSkills.bind(null, scope)}
    >
      {await SkillsContent()}
    </RevalidatingContent>
  );
}
