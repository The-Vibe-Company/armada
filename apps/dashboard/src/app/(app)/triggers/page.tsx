import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { TriggerPanel } from "@/components/inbound-triggers";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser } from "@/components/resource-browser";
import { Badge } from "@/components/ui/badge";
import { ControlError } from "@/lib/control";
import { viewerInboundTriggers } from "@/lib/data/inbound-triggers";
import { selectedOrganization } from "@/lib/data/selected-org";
import { mcpUrl } from "@/lib/env";
import { HARNESS_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Inbound triggers" };
export const dynamic = "force-dynamic";

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
    const [triggers, { item }] = await Promise.all([control.list(), searchParams]);
    return (
      <ResourceBrowser
        key={org}
        title="Inbound triggers"
        description=""
        label="Inbound triggers"
        blockers={[]}
        initial={typeof item === "string" ? item : null}
        empty={<Empty title="No inbound triggers configured" />}
        rows={triggers.map((trigger) => {
          const { id, templateId, poolHarness, enabled, ratePerMinute, concurrency, rateRefusals } = trigger;
          const hook = new URL(`/api/v1/hooks/${id}`, mcpUrl() ?? undefined).href;
          const harness = HARNESS_LABELS[poolHarness];
          return {
            key: id,
            name: id,
            search: `${id} ${harness} ${enabled ? "enabled" : "disabled"}`,
            meta: harness,
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
                        View template
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
        <PageHeader title="Inbound triggers" description="" />
        <p role="alert" className="text-sm text-destructive">
          Could not load inbound triggers. Reload to try again.
        </p>
      </>
    );
  }
}
