import { routineReasonHelp } from "@armada/core";
import { Clock3Icon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { CreateRoutineDialog, RoutineHistory, RoutineMark, RoutineToggle } from "@/components/routines";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { listSelectedRoutines } from "@/lib/data/routines";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerTemplates } from "@/lib/data/templates";
import { canManageRoutine, type RoutineItem, scheduleLabel } from "@/lib/routines";
import type { TemplateHeader } from "@/lib/templates";

export const metadata: Metadata = { title: "Routines" };
export const dynamic = "force-dynamic";
const DESCRIPTION = "A template and a prompt, on a schedule. No overlapping runs.";
export default async function RoutinesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [selected, list, query] = await Promise.all([selectedOrganization(), listSelectedRoutines(), searchParams]);
  const header = <PageHeader title="Routines" description={DESCRIPTION} />;
  if (!selected || list.state === "no-org")
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link href="/orgs" className="underline">
            Create an organization
          </Link>{" "}
          to schedule routines.
        </Empty>
      </>
    );
  if (list.state !== "ready")
    return (
      <>
        {header}
        <Alert variant={list.state === "error" ? "destructive" : "default"}>
          <AlertTitle>Routines are unavailable</AlertTitle>
          <AlertDescription>
            {"message" in list ? list.message : "The Armada server is not configured for this dashboard."}
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/routines">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  let templates: TemplateHeader[] = [];
  let templatesUnavailable = false;
  try {
    const control = await viewerTemplates();
    if (control) templates = await control.list(selected.org.id);
    else templatesUnavailable = true;
  } catch {
    templatesUnavailable = true;
  }
  const admin = selected.role === "admin",
    orgId = selected.org.id;
  const rows: ResourceRow[] = list.items.map((item) => {
    const template = templates.find((x) => x.id === item.templateId),
      manage = canManageRoutine(item, { userId: list.userId, admin });
    return {
      key: item.id,
      name: item.name,
      search: `${item.name} ${template?.name ?? ""} ${item.scope} ${item.status}`,
      mark: <RoutineMark />,
      tags: <RowTag>{item.scope === "org" ? "Organization" : "Personal"}</RowTag>,
      meta: (
        <>
          <div className="truncate">
            {template?.name ?? "Unavailable template"} · revision {item.templateRevision}
          </div>
          <div className="mt-0.5 truncate @3xl:hidden">
            {scheduleLabel(item)} · {dueLabel(item)}
          </div>
        </>
      ),
      state: (
        <StateCell
          tone={item.status === "enabled" ? "success" : item.pauseReason ? "warning" : "neutral"}
          label={item.status === "enabled" ? "Enabled" : item.pauseReason ? "Paused after failures" : "Paused"}
        />
      ),
      fact: (
        <div className="space-y-0.5">
          <p>{scheduleLabel(item)}</p>
          <p className="text-xs text-muted-foreground">
            {item.nextDueAt ? "Next " : ""}
            {dueLabel(item)}
          </p>
        </div>
      ),
      action: manage ? <RoutineToggle item={item} orgId={orgId} /> : undefined,
      attrs: { "data-routine": item.name },
      panelAttrs: { "data-routine-panel": item.name },
      subtitle: `${scheduleLabel(item)} · ${item.scope === "org" ? "Organization" : "Personal"}`,
      detail: (
        <div className="space-y-5">
          {item.pauseReason && (
            <Alert>
              <AlertDescription>{routineReasonHelp(item.pauseReason)}</AlertDescription>
            </Alert>
          )}
          <PanelSection title="Schedule">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Template</dt>
              <dd>
                <Link href={`/templates?item=${item.templateId}`} className="underline underline-offset-4">
                  {template?.name ?? "Unavailable template"}
                </Link>
                , revision {item.templateRevision}
              </dd>
              <dt className="text-muted-foreground">Next due</dt>
              <dd>{dueLabel(item)}</dd>
              <dt className="text-muted-foreground">Runs as</dt>
              <dd>
                {item.ownerId === list.userId ? "You" : "Its original owner"}, with current access and credentials
              </dd>
              <dt className="text-muted-foreground">Limits</dt>
              <dd>
                {item.ttlSeconds / 60} min lifetime; {item.maxRunsPerDay} launches per rolling 24 hours
              </dd>
            </dl>
          </PanelSection>
          <PanelSection title="Prompt">
            <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-sm">{item.prompt}</p>
          </PanelSection>
          <RoutineHistory id={item.id} orgId={orgId} version={item.version} />
          <p className="text-xs text-muted-foreground">
            Pausing stops new admissions, not already admitted runs. A live or uncertain previous sandbox is skipped;
            missed intervals never queue up.
          </p>
          {!manage && (
            <p className="text-xs text-muted-foreground">Only an organization admin can change this routine.</p>
          )}
        </div>
      ),
    };
  });
  return (
    <ResourceBrowser
      title="Routines"
      description={DESCRIPTION}
      label="Routines"
      meta={rows.length || undefined}
      rows={rows}
      blockers={[]}
      initial={typeof query.item === "string" ? query.item : null}
      actions={<CreateRoutineDialog orgId={orgId} isAdmin={admin} templates={templates} />}
      notices={
        templatesUnavailable ? (
          <Alert>
            <AlertDescription>
              Templates could not be loaded. Existing schedules remain unchanged; refresh before creating a routine.
            </AlertDescription>
          </Alert>
        ) : undefined
      }
      empty={
        <Empty title="No routines yet" icon={<Clock3Icon />}>
          Schedule a template with a prompt. New routines stay paused until you enable them.
        </Empty>
      }
      footer={
        <p className="text-xs text-muted-foreground">
          Minimum interval: one hour. Personal routines are yours alone; organization routines are managed by admins.
          Templates stay pinned to their selected revision.
        </p>
      }
    />
  );
}
function dueLabel(item: RoutineItem) {
  return item.nextDueAt
    ? `${new Date(item.nextDueAt).toLocaleString("en", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`
    : "Not scheduled";
}
