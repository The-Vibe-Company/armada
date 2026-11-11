import { CircleAlertIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { SkillDefaultsCard } from "@/components/skill-defaults";
import { SkillpackKeyView } from "@/components/skillpack-key";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { selectedOrganization } from "@/lib/data/selected-org";
import { readSelectedSkillpackKeys } from "@/lib/data/skillpack-key";
import { SKILLS_PATH } from "@/lib/skillpack-key";

export const metadata: Metadata = { title: "Skills" };
export const dynamic = "force-dynamic";

const TITLE = "Skills";
const DESCRIPTION = "Default skills for future launches, and the Skillpack key that installs private skills.";

/**
 * Build > Skills (#957): where the Skillpack key is added, replaced and removed. Harness is about model
 * subscriptions and Variables about values delivered to agents; this key is never given to an agent, only used by
 * Armada to install skills, so it has its own entry.
 */
export default async function SkillsPage() {
  const [selected, list] = await Promise.all([selectedOrganization(), readSelectedSkillpackKeys()]);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;
  const defaults = selected ? (
    <div className="grid gap-4 lg:grid-cols-2">
      <SkillDefaultsCard
        key={`${selected.org.id}-personal`}
        orgId={selected.org.id}
        scope="personal"
        title="Your default skills"
        description="Used for your launches across organizations. They override organization and environment pins for the same skill."
        canManage
      />
      <SkillDefaultsCard
        key={`${selected.org.id}-org`}
        orgId={selected.org.id}
        scope="org"
        title="Organization default skills"
        description={`Used for launches in ${selected.org.name}, overriding environment pins for the same skill.`}
        canManage={selected.role === "admin"}
      />
    </div>
  ) : null;

  if (!selected || list.state === "no-org")
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>{" "}
          to add a Skillpack key.
        </Empty>
      </>
    );
  if (list.state === "not-configured")
    return (
      <>
        {header}
        <Alert>
          <InfoIcon />
          <AlertDescription>
            The Armada server is not configured: the Skillpack key cannot be managed here.
          </AlertDescription>
        </Alert>
        {defaults}
      </>
    );
  if (list.state === "error")
    return (
      <>
        {header}
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>The Skillpack key could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{list.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href={SKILLS_PATH}>Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
        {defaults}
      </>
    );

  return (
    <>
      <SkillpackKeyView
        title={TITLE}
        description={DESCRIPTION}
        orgId={selected.org.id}
        orgName={selected.org.name}
        isAdmin={selected.role === "admin"}
        keys={list.keys}
      />
      {defaults}
    </>
  );
}
