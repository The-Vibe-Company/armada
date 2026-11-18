import { CircleAlertIcon } from "lucide-react";
import { Suspense } from "react";
import { LangfuseSettingsCard } from "@/components/langfuse-settings";
import { SectionHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { viewerLangfuse } from "@/lib/data/langfuse";

async function Settings({ org, admin, now }: { org: string; admin: boolean; now: number }) {
  const control = await viewerLangfuse(org);
  const settings = await control?.read(admin).catch(() => null);
  if (settings) return <LangfuseSettingsCard org={org} settings={settings} now={now} />;
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Langfuse settings could not be loaded</AlertTitle>
      <AlertDescription>
        <p>Reload this organization to try again. If this continues, ask an Armada administrator for help.</p>
        <Button asChild variant="outline" size="sm" className="mt-2">
          <a href={`/orgs/${org}`}>Reload organization</a>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function LangfuseSection(props: { org: string; admin: boolean; now: number }) {
  return (
    <section className="space-y-3" aria-labelledby="langfuse-heading">
      <SectionHeader
        id="langfuse-heading"
        title="Langfuse"
        description="Export every agent turn in this organization's sandboxes to Langfuse as a trace."
      />
      <Suspense
        fallback={
          <p role="status" className="rounded-[10px] border bg-card p-4 text-sm text-muted-foreground">
            Loading Langfuse settings…
          </p>
        }
      >
        <Settings {...props} />
      </Suspense>
    </section>
  );
}
