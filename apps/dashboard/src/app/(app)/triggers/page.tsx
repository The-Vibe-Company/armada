import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { CreateTriggerDialog } from "@/components/create-trigger-dialog";
import { TriggerPanel } from "@/components/inbound-triggers";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser } from "@/components/resource-browser";
import { Badge } from "@/components/ui/badge";
import { ControlError } from "@/lib/control";
import { inboundTriggerTemplates, viewerInboundTriggers } from "@/lib/data/inbound-triggers";
import { selectedOrganization } from "@/lib/data/selected-org";
import { mcpUrl } from "@/lib/env";
import { HARNESS_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Inbound triggers" };
export const dynamic = "force-dynamic";

const DESCRIPTION = "Webhook endpoints that launch a saved template automatically when external events arrive.";

export default async function InboundTriggersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const selected = await selectedOrganization();
  if (selected?.role !== "admin") notFound();
  const org = selected.org.id;
  const control = await viewerInboundTriggers(org);
  try {
    if (!control) throw new ControlError("Armada server unavailable.");
    const [triggers, { item }, templates] = await Promise.all([
      control.list(),
      searchParams,
      inboundTriggerTemplates(org),
    ]);
    const templateNames = new Map((templates ?? []).map((template) => [template.id, template.name]));
    return (
      <ResourceBrowser
        key={org}
        title="Inbound triggers"
        description={DESCRIPTION}
        label="Inbound triggers"
        blockers={[]}
        actions={<CreateTriggerDialog org={org} templates={templates} />}
        initial={typeof item === "string" ? item : null}
        empty={
          <Empty title="No inbound triggers yet">
            Create a trigger to get a webhook URL that launches a saved template automatically when external events
            arrive.
          </Empty>
        }
        rows={triggers.map((trigger) => {
          const { id, templateId, poolHarness, enabled, ratePerMinute, concurrency, rateRefusals } = trigger;
          const hook = new URL(`/api/v1/hooks/${id}`, mcpUrl() ?? undefined).href;
          const harness = HARNESS_LABELS[poolHarness];
          const templateName = templateId ? templateNames.get(templateId) : undefined;
          const rowName = templateName ?? (templateId ? "Saved template" : "Private template");
          const shortId = id.slice(0, 8);
          return {
            key: id,
            name: rowName,
            search: `${rowName} ${id} ${harness} ${enabled ? "enabled" : "disabled"}`,
            meta: `${harness} · ${shortId}`,
            state: <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? "Enabled" : "Disabled"}</Badge>,
            detail: (
              <div className="space-y-5">
                <div>
                  <p className="text-sm font-medium">Webhook URL</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 break-all text-xs">{hook}</code>
                    <CopyButton value={hook} label="Copy webhook URL" />
                  </div>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Template</dt>
                  <dd>
                    {templateId ? (
                      <Link href={`/templates?item=${templateId}`} className="underline">
                        {templateName ?? "View template"}
                      </Link>
                    ) : (
                      "Private template"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Rate limit</dt>
                  <dd>{ratePerMinute} deliveries/min</dd>
                  <dt className="text-muted-foreground">Concurrency limit</dt>
                  <dd>{concurrency} active launches</dd>
                  <dt className="text-muted-foreground">Rate refusals</dt>
                  <dd>{rateRefusals}</dd>
                </dl>
                <TriggerPanel org={org} id={id} enabled={enabled} />
              </div>
            ),
          };
        })}
      />
    );
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return (
      <>
        <PageHeader title="Inbound triggers" description={DESCRIPTION} />
        <p role="alert" className="text-sm text-destructive">
          Could not load inbound triggers. Reload to try again.
        </p>
      </>
    );
  }
}
