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
const DESCRIPTION = (
  <>
    Manage your private-skill access key here. Choose skills in supported launch dialogs or templates.{" "}
    <a
      className="font-medium text-foreground underline underline-offset-4"
      href="https://skillpack.app"
      target="_blank"
      rel="noreferrer"
    >
      Browse Skillpack
    </a>
    .
  </>
);

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
        <Empty
          title="No organization yet"
          action={
            <Button asChild>
              <Link href="/orgs">Choose an organization</Link>
            </Button>
          }
        >
          Create or join an organization before connecting a private-skill key.
        </Empty>
      </>
    );
  if (list.state === "not-configured")
    return (
      <>
        {header}
        <Alert role="status">
          <InfoIcon />
          <AlertTitle>Skill setup is not ready here</AlertTitle>
          <AlertDescription>
            <p>Ask an Armada administrator to finish setup, then reload Skills.</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href={SKILLS_PATH}>Reload Skills</a>
            </Button>
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
            <p>
              Check your connection and reload Skills. If this continues, ask an Armada administrator to check Skillpack
              access.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href={SKILLS_PATH}>Reload Skills</a>
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
