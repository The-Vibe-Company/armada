import { CircleAlertIcon, InfoIcon } from "lucide-react";
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

const TITLE = "Skills";
const DESCRIPTION = "Instruction packs an agent loads to do a kind of task well. They come from Skillpack.";

/**
 * Build > Skills (#957): where the Skillpack key is added, replaced and removed. Harness is about model
 * subscriptions and Variables about values delivered to agents; this key is never given to an agent, only used by
 * Armada to install skills, so it has its own entry.
 */
export default async function SkillsContent() {
  // Template usage is independent of the resource list. Settle speculative failures so
  // the resource's unavailable/no-org fallback still takes precedence.
  const templatesRead = Promise.allSettled([listSelectedTemplates()]);
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

  const [templateResult] = await templatesRead;
  if (templateResult.status === "rejected") throw templateResult.reason;
  const templates = templateResult.value;
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
        empty="No visible templates include skills."
        note="You pick skills in a template or at launch, not here."
      />
    </>
  );
}
