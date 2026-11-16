import { routineReasonHelp } from "@armada/core";
import { Clock3Icon, HistoryIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow, SelectItem } from "@/components/resource-browser";
import { CreateRoutineDialog, DeleteRoutine, RoutineHistory, RoutineToggle } from "@/components/routines";
import { PanelSection } from "@/components/state-cell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { listSelectedRoutines } from "@/lib/data/routines";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerTemplates } from "@/lib/data/templates";
import { canManageRoutine, type RoutineItem, scheduleLabel } from "@/lib/routines";
import type { TemplateHeader } from "@/lib/templates";

import styles from "./routines.module.css";

export const metadata: Metadata = { title: "Routines" };
export const dynamic = "force-dynamic";
const DESCRIPTION = "";
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
        <Empty
          title="No organization yet"
          action={
            <Button asChild>
              <Link href="/orgs">Choose an organization</Link>
            </Button>
          }
        >
          Create or join an organization before scheduling launches.
        </Empty>
      </>
    );
  if (list.state !== "ready")
    return (
      <>
        {header}
        <Alert
          variant={list.state === "error" ? "destructive" : "default"}
          role={list.state === "error" ? "alert" : "status"}
        >
          <AlertTitle>
            {list.state === "unsupported"
              ? "Routine management needs an update"
              : list.state === "not-configured"
                ? "Routine setup is not ready here"
                : "Routines could not be loaded"}
          </AlertTitle>
          <AlertDescription>
            <p>
              {list.state === "unsupported"
                ? "Ask an Armada administrator to update Armada before scheduling routines here."
                : list.state === "not-configured"
                  ? "Ask an Armada administrator to finish setup, then reload Routines."
                  : "Check your connection and reload Routines. If this continues, ask an Armada administrator to check routine access."}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href="/routines">Reload Routines</a>
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
      meta: null,
      state: (
        <div className="space-y-1 text-sm">
          {item.pauseReason ? (
            <>
              <p className="text-destructive">
                {item.pauseReason === "repeated_launch_failures"
                  ? "Paused after 3 failed launches"
                  : routineReasonHelp(item.pauseReason)}
              </p>
              <p className="text-xs text-muted-foreground">
                Open its runs to see what failed, fix it, then turn it back on.
              </p>
            </>
          ) : (
            <p>{scheduleLabel(item)}</p>
          )}
        </div>
      ),
      fact: (
        <div className={styles.facts}>
          <span>
            <span className={styles.mobileLabel}>Template: </span>
            {template?.name ?? "Unavailable template"}
          </span>
          <span className="text-[13px]">
            <span className={styles.mobileLabel}>Last run: </span>
            <SelectItem item={item.id} variant="link" size="sm" className="h-auto p-0">
              See runs
            </SelectItem>
          </span>
          <span className="text-xs">
            <span className={styles.mobileLabel}>Next: </span>
            {dueLabel(item)}
          </span>
        </div>
      ),
      action: (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {manage ? (
            <RoutineToggle item={item} orgId={orgId} />
          ) : (
            <span className="text-xs">{item.status === "enabled" ? "On" : "Off"}</span>
          )}
          <SelectItem item={item.id} variant="ghost" size="icon" aria-label={`See runs for ${item.name}`}>
            <HistoryIcon className="size-[15px]" />
          </SelectItem>
        </div>
      ),
      attrs: { "data-routine": item.name },
      panelAttrs: { "data-routine-panel": item.name },
      subtitle: `${scheduleLabel(item)} · ${item.scope === "org" ? "Organization" : "Personal"}`,
      detail: (
        <div className="space-y-5">
          {item.pauseReason && (
            <Alert>
              <AlertDescription>
                {item.pauseReason === "repeated_launch_failures"
                  ? "Paused after 3 failed launches. Open its runs to see what failed, fix it, then turn it back on."
                  : routineReasonHelp(item.pauseReason)}
              </AlertDescription>
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
          <PanelSection title="Task">
            <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-sm">{item.prompt}</p>
          </PanelSection>
          <RoutineHistory id={item.id} orgId={orgId} version={item.version} />
          <p className="text-xs text-muted-foreground">
            Switching off stops new launches, not runs already starting. A run missed while the routine was off is not
            caught up.
          </p>
          {manage && <DeleteRoutine item={item} orgId={orgId} />}
          {!manage && (
            <p className="text-xs text-muted-foreground">Only an organization admin can change this routine.</p>
          )}
        </div>
      ),
    };
  });
  return (
    <div className={styles.page}>
      <ResourceBrowser
        title="Routines"
        description={DESCRIPTION}
        label="Routines"
        rows={rows}
        blockers={[]}
        initial={typeof query.item === "string" ? query.item : null}
        actions={
          templatesUnavailable ? (
            <Button asChild variant="outline">
              <a href="/routines">Reload Routines</a>
            </Button>
          ) : templates.length > 0 ? (
            <CreateRoutineDialog orgId={orgId} isAdmin={admin} templates={templates} />
          ) : (
            <Button asChild>
              <Link href="/templates">Create a template</Link>
            </Button>
          )
        }
        notices={
          templatesUnavailable ? (
            <Alert>
              <AlertDescription>
                Templates could not be loaded. Existing schedules remain unchanged; use Reload Routines before creating
                a schedule.
              </AlertDescription>
            </Alert>
          ) : null
        }
        empty={
          <Empty title="No routines yet" icon={<Clock3Icon />}>
            {templatesUnavailable
              ? "Reload Routines to check templates before creating a schedule."
              : templates.length === 0
                ? "Create a template first, then return here to schedule it. New routines stay paused until you enable them."
                : "Choose New routine to schedule a template with a task. New routines stay paused until you enable them."}
          </Empty>
        }
        footer={
          rows.length > 0 && (
            <div className={styles.columns} aria-hidden="true">
              <span>Routine</span>
              <span>When</span>
              <span>Template</span>
              <span>Last run</span>
              <span>Next (UTC)</span>
              <span>On</span>
              <span className="text-right">Runs</span>
            </div>
          )
        }
      />
    </div>
  );
}
function dueLabel(item: RoutineItem) {
  return item.nextDueAt
    ? `${new Date(item.nextDueAt).toLocaleString("en", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`
    : "Not scheduled";
}
