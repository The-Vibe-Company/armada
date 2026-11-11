import { MODEL_CATALOG } from "@armada/core";
import { CircleAlertIcon, InfoIcon, LayoutTemplateIcon, TriangleAlertIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CreatedAt } from "@/components/created-at";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import {
  CreateTemplateDialog,
  NoSecretsNote,
  TemplateLaunchDialog,
  TemplateManage,
  TemplateMark,
} from "@/components/templates";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { listSelectedConnections } from "@/lib/data/connections";
import { type GoldenRow, listGoldens } from "@/lib/data/goldens";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listSelectedTemplates, lookupsFrom } from "@/lib/data/templates";
import { listSelectedVault } from "@/lib/data/variables";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { EFFORT_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { createClient } from "@/lib/supabase/server";
import { launchTarget } from "@/lib/template-launch";
import {
  agentSummary,
  canManageTemplate,
  modelLabel,
  plural,
  type TemplateItem,
  type TemplateLookups,
  templateAudience,
  templateState,
} from "@/lib/templates";

export const metadata: Metadata = { title: "Templates" };
export const dynamic = "force-dynamic";
// A launch waits for the server to start the sandbox, as the Environments page's launch does.
export const maxDuration = 800;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Templates";
const DESCRIPTION = "Launch presets: an environment, tools, a model and variables.";

export default async function TemplatesPage({ searchParams }: Props) {
  const [selected, list, query] = await Promise.all([selectedOrganization(), listSelectedTemplates(), searchParams]);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

  if (!selected || list.state === "no-org") {
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>{" "}
          to add templates.
        </Empty>
      </>
    );
  }
  if (list.state === "not-configured" || list.state === "unsupported") {
    return (
      <>
        {header}
        <Alert>
          <InfoIcon />
          <AlertDescription>
            {list.state === "unsupported"
              ? list.message
              : "The Armada server is not configured: templates cannot be managed here."}
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (list.state === "error") {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Templates could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{list.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/templates">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const [goldens, connections, vault] = await Promise.all([
    createClient().then(listGoldens),
    listSelectedConnections(),
    listSelectedVault(),
  ]);
  const lookups = lookupsFrom(goldens, connections, vault);
  const isAdmin = selected.role === "admin";
  const org = { id: selected.org.id, name: selected.org.name };
  const viewer = { userId: list.userId, admin: isAdmin };
  const now = Date.now();
  const rows = sortResources(
    list.items.map((item) => row(item, { org, lookups, goldens, manage: canManageTemplate(item, viewer), now })),
  );
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;

  return (
    <ResourceBrowser
      title={TITLE}
      description={DESCRIPTION}
      meta={rows.length > 0 ? rows.length : undefined}
      label="Templates"
      rows={rows}
      blockers={[]}
      initial={requested}
      actions={
        <CreateTemplateDialog
          orgId={org.id}
          orgName={org.name}
          isAdmin={isAdmin}
          lookups={lookups}
          catalog={MODEL_CATALOG}
        />
      }
      footer={
        <p className="text-xs text-pretty text-muted-foreground">
          Personal templates are yours alone. Org templates can be launched by every member of {org.name};{" "}
          {isAdmin ? "you manage them." : "only an admin changes them."} Each publication is a new revision: a published
          revision never changes.
        </p>
      }
      empty={
        <Empty title="No templates yet" icon={<LayoutTemplateIcon />}>
          Use New to save an environment, tools, a model and variables that agents start from.
        </Empty>
      }
    />
  );
}

type RowContext = {
  org: { id: string; name: string };
  lookups: TemplateLookups;
  goldens: readonly GoldenRow[];
  manage: boolean;
  now: number;
};

/** One template as a row (what it starts, who can use it, Launch) and its panel (the four choices, management). */
function row(item: TemplateItem, context: RowContext): ResourceRow & { bucket: Bucket; tie: string } {
  const { org, lookups } = context;
  const state = templateState(item, lookups);
  const definition = item.revision?.definition;
  const golden = definition ? lookups.goldens.find((row) => row.id === definition.goldenId) : undefined;
  const environment = definition
    ? `${golden?.name ?? "Unavailable environment"} on ${PROVIDER_LABELS[definition.provider]}`
    : null;
  const meta = definition
    ? [
        environment,
        modelLabel(definition.harness, definition.model),
        plural(definition.connections.length, "tool"),
        plural(definition.variables.length, "variable"),
      ].join(" · ")
    : `Revision ${item.currentRevision}`;
  const target = launchTarget(item, context.goldens, lookups);
  const blocker = target?.blocker ?? null;

  const detail = (
    <div className="space-y-4" data-template-panel={item.name}>
      <div className="space-y-2">
        <StateCell tone={state.tone} label={state.label} />
        {state.problems.length > 0 && (
          <Alert className="border-warning/40" data-template-problems>
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>Fix this before launching</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {state.problems.map((problem) => (
                  <li key={problem.text}>{problem.text}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {target && !blocker && (
          <div className="pt-1">
            <TemplateLaunchDialog target={target} />
          </div>
        )}
      </div>
      {definition && target ? (
        <>
          <PanelSection title="Environment">
            <p className="text-sm">{environment}</p>
          </PanelSection>
          <PanelSection title="Agent">
            <p className="text-sm">
              {HARNESS_LABELS[definition.harness]}, {modelLabel(definition.harness, definition.model)},{" "}
              {EFFORT_LABEL[definition.reasoningEffort] ?? definition.reasoningEffort} effort
            </p>
            <p className="text-xs text-muted-foreground">
              {definition.modelAccount
                ? "Runs on a pinned model account, whoever launches it."
                : "Runs on the launcher's own model account."}
            </p>
          </PanelSection>
          <PanelSection title="Tools">
            {target.tools.length ? (
              <ul className="space-y-1 text-sm">
                {target.tools.map((tool, index) => (
                  <li key={definition.connections[index]}>{tool}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </PanelSection>
          <PanelSection title="Variables">
            {definition.variables.length ? (
              <ul className="space-y-1 font-mono text-xs">
                {definition.variables.map((binding) => (
                  <li key={binding.key} className="flex justify-between gap-3">
                    <span className="truncate">{binding.key}</span>
                    <span className="shrink-0 font-sans text-muted-foreground tabular-nums">v{binding.version}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
            <NoSecretsNote />
          </PanelSection>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Its current revision could not be read. Refresh the page to try again.
        </p>
      )}
      <PanelSection title="About">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Revision</dt>
          <dd className="tabular-nums">{item.currentRevision} (published revisions never change)</dd>
          <dt className="text-muted-foreground">Who can launch it</dt>
          <dd>{templateAudience(item.scope, org.name)}</dd>
          <dt className="text-muted-foreground">Who can change it</dt>
          <dd>{item.scope === "personal" ? "Only you" : `${org.name}'s admins`}</dd>
          <dt className="text-muted-foreground">Last published</dt>
          <dd>
            <CreatedAt iso={item.updatedAt} now={context.now} />
          </dd>
        </dl>
      </PanelSection>
      {context.manage && item.revision ? (
        <TemplateManage
          editing={{
            id: item.id,
            name: item.name,
            scope: item.scope,
            revision: item.currentRevision,
            definition: item.revision.definition,
          }}
          orgId={org.id}
          orgName={org.name}
          lookups={lookups}
          catalog={MODEL_CATALOG}
        />
      ) : (
        !context.manage && (
          <p className="border-t pt-4 text-xs text-muted-foreground">Managed by {org.name}'s admins.</p>
        )
      )}
    </div>
  );

  return {
    key: item.id,
    name: item.name,
    tie: item.id,
    bucket: state.bucket,
    search: [item.name, item.scope, environment ?? "", definition ? agentSummary(definition) : ""].join(" "),
    mark: <TemplateMark />,
    tags: (
      <RowTag>
        {item.scope === "personal" ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />}
        {item.scope === "personal" ? "Personal" : "Org"}
      </RowTag>
    ),
    meta,
    subtitle: `Revision ${item.currentRevision} · ${templateAudience(item.scope, org.name)}`,
    state: <StateCell tone={state.tone} label={state.label} data-template-state={state.label} />,
    fact: templateAudience(item.scope, org.name),
    ...(target && !blocker ? { action: <TemplateLaunchDialog target={target} /> } : {}),
    detail,
    attrs: { "data-template": item.name },
  };
}
