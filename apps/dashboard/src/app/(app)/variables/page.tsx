import { CircleAlertIcon, InfoIcon, UserIcon, UsersIcon, VariableIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { RowTag, StateCell } from "@/components/state-cell";
import { TemplateUsage } from "@/components/template-usage";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AddVaultDialog, VaultMark, VaultPanel } from "@/components/variables";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listSelectedTemplates, type TemplateList } from "@/lib/data/templates";
import { listSelectedVault } from "@/lib/data/variables";
import { type Bucket, ITEM_PARAM, sortResources } from "@/lib/resource-list";
import { audience, canManage, itemKey, type VaultItem, vaultState } from "@/lib/variables";

export const metadata: Metadata = { title: "Variables" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TITLE = "Variables";
const DESCRIPTION = "Configuration and write-only secrets for your agents.";

export default async function VariablesPage({ searchParams }: Props) {
  const [selected, list, query] = await Promise.all([selectedOrganization(), listSelectedVault(), searchParams]);
  const header = <PageHeader title={TITLE} description={DESCRIPTION} />;

  if (!selected || list.state === "no-org") {
    return (
      <>
        {header}
        <Empty title="No organization yet">
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>{" "}
          to add variables and secrets.
        </Empty>
      </>
    );
  }
  if (list.state === "not-configured" || list.state === "unsupported") {
    // Not a failure of anything the viewer did: said plainly, not in red.
    return (
      <>
        {header}
        <Alert>
          <InfoIcon />
          <AlertDescription>
            {list.state === "unsupported"
              ? list.message
              : "The Armada server is not configured: variables cannot be managed here."}
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
          <AlertTitle>Variables could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{list.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/variables">Try again</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const templates = await listSelectedTemplates();
  const isAdmin = selected.role === "admin";
  const orgName = selected.org.name;
  const viewer = { userId: list.userId, admin: isAdmin };
  const now = Date.now();
  const rows = sortResources<ResourceRow & { bucket: Bucket; tie: string }>(
    list.items.map((item) => row(item, orgName, canManage(item, viewer), now, templates)),
  );
  const requested = typeof query[ITEM_PARAM] === "string" ? query[ITEM_PARAM] : null;

  return (
    <ResourceBrowser
      detailPanel
      title={TITLE}
      description={DESCRIPTION}
      meta={rows.length > 0 ? rows.length : undefined}
      label="Variables and secrets"
      rows={rows}
      blockers={[]}
      initial={requested}
      actions={<AddVaultDialog orgId={selected.org.id} orgName={orgName} isAdmin={isAdmin} />}
      footer={
        <p className="text-xs text-pretty text-muted-foreground">
          Personal entries are yours alone. Org entries are shared with every member of {orgName};{" "}
          {isAdmin ? "you manage them." : "only an admin changes them."} A secret is write-only: once stored, nobody can
          read it back. Launches do not deliver these values to sandboxes yet.
        </p>
      }
      empty={
        <Empty title="No variables or secrets yet" icon={<VariableIcon />}>
          Add readable configuration, or a secret that is stored encrypted and never shown again.
        </Empty>
      }
    />
  );
}

/** One variable or secret as a row: its kind and scope, whether it is active, and who can use it. */
function row(
  item: VaultItem,
  orgName: string,
  manage: boolean,
  now: number,
  templates: TemplateList,
): ResourceRow & { bucket: Bucket; tie: string } {
  const state = vaultState(item);
  const meta = `${item.kind === "secret" ? "Write-only secret" : "Variable"} · version ${item.version}`;
  return {
    key: itemKey(item),
    name: item.name,
    tie: item.kind,
    bucket: state.bucket,
    search: [item.name, item.kind, item.scope, item.status].join(" "),
    mark: <VaultMark kind={item.kind} />,
    tags: (
      <RowTag>
        {item.scope === "personal" ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />}
        {item.scope === "personal" ? "Personal" : "Org"}
      </RowTag>
    ),
    meta,
    subtitle: meta,
    state: <StateCell tone={state.tone} label={state.label} data-vault-status={item.status} />,
    fact: audience(item, orgName),
    detail: (
      <div className="space-y-4">
        <VaultPanel item={item} orgName={orgName} canManage={manage} now={now} />
        <TemplateUsage
          list={templates}
          uses={(definition) =>
            item.kind === "variable"
              ? definition.variables.some((binding) => binding.variableId === item.id)
              : (definition.secrets ?? []).some((binding) => binding.secretId === item.id)
          }
        />
      </div>
    ),
    attrs: { "data-vault-item": item.name, "data-vault-kind": item.kind },
  };
}
