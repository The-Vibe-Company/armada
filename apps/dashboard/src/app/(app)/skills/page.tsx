import { CircleAlertIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { SkillpackKeyView } from "@/components/skillpack-key";
import { TemplateUsage } from "@/components/template-usage";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { selectedOrganization } from "@/lib/data/selected-org";
import { readSelectedSkillpackKeys } from "@/lib/data/skillpack-key";
import { listSelectedTemplates } from "@/lib/data/templates";
import { SKILLS_PATH } from "@/lib/skillpack-key";

export const metadata: Metadata = { title: "Skills" };
export const dynamic = "force-dynamic";

const TITLE = "Skills";
const DESCRIPTION = "The Skillpack key that installs your private skills in the sandboxes Armada launches.";

/**
 * Build > Skills (#957): where the Skillpack key is added, replaced and removed. Harness is about model
 * subscriptions and Variables about values delivered to agents; this key is never given to an agent, only used by
 * Armada to install skills, so it has its own entry.
 */
export default async function SkillsPage() {
  const [selected, list] = await Promise.all([selectedOrganization(), readSelectedSkillpackKeys()]);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

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
      </>
    );

  const templates = await listSelectedTemplates();
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
      <TemplateUsage
        list={templates}
        uses={(definition) => definition.skills.length > 0}
        title="Templates using skills"
        empty="No visible templates include skill pins."
        note="These templates include skill pins; this is not a count of Skillpack-key usage."
      />
    </>
  );
}
