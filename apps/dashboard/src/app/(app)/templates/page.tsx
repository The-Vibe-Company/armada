import { MODEL_CATALOG } from "@armada/core";
import { CircleAlertIcon, InfoIcon, LayoutTemplateIcon, TriangleAlertIcon, UserIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CatalogBrowser } from "@/components/catalog-browser";
import { CatalogHarnessMark } from "@/components/catalog-harness-mark";
import { CreatedAt } from "@/components/created-at";
import { IngredientLink } from "@/components/ingredient-link";
import { Empty, PageHeader } from "@/components/page-header";
import type { ResourceRow } from "@/components/resource-browser";
import { PanelSection, RowTag, StateCell } from "@/components/state-cell";
import { CreateTemplateDialog, NoSecretsNote, TemplateLaunchDialog, TemplateManage } from "@/components/templates";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { listSelectedConnections } from "@/lib/data/connections";
import { readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { readSelectedDockerSnapshots } from "@/lib/data/docker-snapshots";
import { type GoldenRow, listGoldens } from "@/lib/data/goldens";
import { launchAccounts, listSelectedAccounts } from "@/lib/data/model-accounts";
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
import { itemKey } from "@/lib/variables";

export const metadata: Metadata = { title: "Templates" };
export const dynamic = "force-dynamic";
// A launch waits for the server to start the sandbox, as the Environments page's launch does.
export const maxDuration = 800;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Templates";
const DESCRIPTION = "Saved launch setups: one click, then write the task.";

export default async function TemplatesPage({ searchParams }: Props) {
  // Lookup reads do not depend on template headers or their revision fan-out. Keep their
  // failures settled until after the list guards so unavailable-list fallbacks still win.
  const lookupsRead = Promise.allSettled([
    createClient().then(listGoldens),
    listSelectedConnections(),
    listSelectedVault(),
    listSelectedAccounts(),
    readSelectedDockerHosts(),
    readSelectedDockerSnapshots(),
  ]);
  const [selected, list, query] = await Promise.all([selectedOrganization(), listSelectedTemplates(), searchParams]);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

  if (!selected || list.state === "no-org") {
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
          Create or join an organization before saving launch setups.
        </Empty>
      </>
    );
  }
  if (list.state === "not-configured" || list.state === "unsupported") {
    return (
      <>
        {header}
        <Alert role="status">
          <InfoIcon />
          <AlertTitle>
            {list.state === "unsupported" ? "Template management needs an update" : "Template setup is not ready here"}
          </AlertTitle>
          <AlertDescription>
            <p>
              {list.state === "unsupported"
                ? "Ask an Armada administrator to update Armada before managing templates here."
                : "Ask an Armada administrator to finish setup, then reload Templates."}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href="/templates">Reload Templates</a>
            </Button>
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
            <p>
              Check your connection and reload Templates. If this continues, ask an Armada administrator to check
              template access.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <a href="/templates">Reload Templates</a>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const results = await lookupsRead;
  const goldens = fulfilled(results[0]);
  const connections = fulfilled(results[1]);
  const vault = fulfilled(results[2]);
  const accounts = fulfilled(results[3]);
  const hosts = fulfilled(results[4]);
  const snapshots = fulfilled(results[5]);
  const lookups: TemplateLookups = {
    ...lookupsFrom(goldens, connections, vault),
    accounts: launchAccounts(accounts, Date.now()),
    hosts: hosts.state === "ready" ? hosts.list.hosts : [],
    snapshots: snapshots.state === "ready" ? snapshots.snapshots : [],
  };
  const isAdmin = selected.role === "admin";
  const org = { id: selected.org.id, name: selected.org.name };
  const viewer = { userId: list.userId, admin: isAdmin };
  const now = Date.now();
  const rows = sortResources(
    list.items.map((item) => row(item, { org, lookups, goldens, manage: canManageTemplate(item, viewer), now })),
  );
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;

  return (
    <CatalogBrowser
      title={TITLE}
      description=""
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
          {isAdmin ? "you manage them." : "only an admin changes them."} Each save creates a new version. Existing
          routines keep the version they were set up with.
        </p>
      }
      empty={
        <Empty title="No templates yet" icon={<LayoutTemplateIcon />}>
          Choose New to save a reusable launch setup with the snapshot and agent settings you want.
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
  const golden = definition
    ? lookups.goldens.find((row) => row.id === definition.goldenId && row.provider === definition.provider)
    : undefined;
  const environment = definition
    ? definition.provider === "docker"
      ? `${lookups.snapshots?.find((snapshot) => snapshot.id === definition.snapshotId)?.name ?? (definition.snapshotId ? "Unavailable snapshot" : "Official Armada image")} · your server ${lookups.hosts?.find((host) => host.id === definition.hostId)?.name ?? "Unavailable server"}`
      : `${golden?.name ?? "Unavailable snapshot"} on ${PROVIDER_LABELS[definition.provider]} cloud`
    : null;
  const meta = definition
    ? [
        `${HARNESS_LABELS[definition.harness]} running ${modelLabel(definition.harness, definition.model)}, effort ${definition.reasoningEffort}, from ${environment}`,
        definition.connections.length
          ? definition.connections
              .map((id) => lookups.connections?.find((tool) => tool.id === id)?.name ?? "Unavailable tool")
              .join(", ")
          : "No tools",
        plural(definition.variables.length, "variable"),
      ].join(" · ")
    : `Version ${item.currentRevision}`;
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
          <PanelSection title="Snapshot">
            {golden ? (
              <IngredientLink href={`/snapshots?item=${encodeURIComponent(golden.id)}`}>{environment}</IngredientLink>
            ) : (
              <p className="text-sm">{environment}</p>
            )}
            {definition.provider === "docker" && (
              <p className="text-xs text-muted-foreground">
                {definition.snapshotId ? "Exact snapshot on this server." : "Official Armada image."}
              </p>
            )}
          </PanelSection>
          <PanelSection title="Agent">
            <IngredientLink href="/harness">
              {HARNESS_LABELS[definition.harness]}, {modelLabel(definition.harness, definition.model)},{" "}
              {EFFORT_LABEL[definition.reasoningEffort] ?? definition.reasoningEffort} effort
            </IngredientLink>
            <p className="text-xs text-muted-foreground">
              {definition.modelAccount
                ? "Runs on a pinned model account, whoever launches it."
                : "Runs on the launcher's own model account."}
            </p>
          </PanelSection>
          {definition.skills.length > 0 && (
            <PanelSection title="Skills">
              <p className="text-xs text-muted-foreground">Manage Skillpack access on the Skills page.</p>
              <ul className="flex flex-wrap gap-2">
                {definition.skills.map((pin) => (
                  <li key={pin} className="min-w-0 max-w-full">
                    <IngredientLink href="/skills">{pin}</IngredientLink>
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}
          <PanelSection title="Tools">
            {target.tools.length ? (
              <ul className="space-y-1 text-sm">
                {definition.connections.map((id) => {
                  const tool = lookups.connections?.find((connection) => connection.id === id);
                  return (
                    <li key={id}>
                      {tool ? (
                        <IngredientLink href={`/tools?item=${encodeURIComponent(id)}`}>{tool.name}</IngredientLink>
                      ) : (
                        "Unavailable tool"
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </PanelSection>
          <PanelSection title="Variables">
            {definition.variables.length ? (
              <ul className="space-y-1 font-mono text-xs">
                {definition.variables.map((binding) => (
                  <li key={binding.key} className="flex min-w-0 justify-between gap-3">
                    {lookups.variables?.some((variable) => variable.id === binding.variableId) ? (
                      <IngredientLink
                        href={`/variables?item=${encodeURIComponent(itemKey({ kind: "variable", id: binding.variableId }))}`}
                      >
                        {binding.key}
                      </IngredientLink>
                    ) : (
                      <span className="min-w-0 [overflow-wrap:anywhere]">{binding.key}</span>
                    )}
                    <span className="shrink-0 font-sans text-muted-foreground tabular-nums">v{binding.version}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </PanelSection>
          {(definition.secrets?.length ?? 0) > 0 && (
            <PanelSection title="Secrets">
              <ul className="space-y-1 text-xs">
                {definition.secrets?.map((binding) => (
                  <li key={binding.key} className="flex min-w-0 items-center justify-between gap-3">
                    {lookups.secrets?.some((secret) => secret.id === binding.secretId) ? (
                      <IngredientLink
                        href={`/variables?item=${encodeURIComponent(itemKey({ kind: "secret", id: binding.secretId }))}`}
                      >
                        {binding.key}
                      </IngredientLink>
                    ) : (
                      <span className="min-w-0 [overflow-wrap:anywhere]">{binding.key}</span>
                    )}
                    <span className="shrink-0 text-muted-foreground tabular-nums">v{binding.version}</span>
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}

          <NoSecretsNote />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Its current version could not be read. Refresh the page to try again.
        </p>
      )}
      <PanelSection title="About">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="tabular-nums">{item.currentRevision} (published versions never change)</dd>
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
    catalog: {
      group: definition?.harness,
      version: `v${item.currentRevision}`,
      footer: templateAudience(item.scope, org.name),
    },
    key: item.id,
    name: item.name,
    tie: item.id,
    bucket: state.bucket,
    search: [item.name, item.scope, environment ?? "", definition ? agentSummary(definition) : ""].join(" "),
    mark: definition ? <CatalogHarnessMark harness={definition.harness} /> : undefined,
    tags: (
      <RowTag>
        {item.scope === "personal" ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />}
        {item.scope === "personal" ? "Personal" : "Org"}
      </RowTag>
    ),
    meta: definition
      ? `${HARNESS_LABELS[definition.harness]} · ${modelLabel(definition.harness, definition.model)}`
      : meta,
    subtitle: `Version ${item.currentRevision} · ${templateAudience(item.scope, org.name)}`,
    state: <StateCell tone={state.tone} label={state.label} data-template-state={state.label} />,
    fact: (
      <div className="flex flex-wrap gap-1.5">
        {environment && <RowTag>{environment}</RowTag>}
        {definition?.connections.map((id) => (
          <RowTag key={id}>{lookups.connections?.find((tool) => tool.id === id)?.name ?? "Unavailable tool"}</RowTag>
        ))}
      </div>
    ),
    ...(target && !blocker ? { action: <TemplateLaunchDialog target={target} /> } : {}),
    detail,
    attrs: { "data-template": item.name },
  };
}

/** Rethrow unexpected lookup failures only when the ready list actually needs the result. */
function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
