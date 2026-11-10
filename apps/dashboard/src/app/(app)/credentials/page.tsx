import type { Harness } from "@armada/core";
import { encryptionKey } from "@armada/core";
import { CircleAlertIcon, KeyRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { removeCredential, saveCredential } from "@/app/actions/credentials";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AddAccountDialog, HarnessAccounts } from "@/components/model-accounts";
import { Empty, PageHeader, SectionHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CREDENTIAL_KINDS, SINGLE_VALUE_KINDS } from "@/lib/credentials";
import { type CredentialRow, listCredentials } from "@/lib/data/credentials";
import {
  type AccountList,
  listSelectedAccounts,
  readAccountUsage,
  readAuthCapabilities,
} from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import {
  type AccountKind,
  type AuthCapabilities,
  accountsFor,
  launchDefault,
  type ModelAccount,
} from "@/lib/model-accounts";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [credentials, accounts, capabilities] = await Promise.all([
    listCredentials(supabase),
    listSelectedAccounts(),
    selected ? readAuthCapabilities(selected.org.id) : null,
  ]);
  const personal = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);
  const now = Date.now();

  return (
    <>
      <PageHeader title="Credentials" description="The accounts your agents run on, and your own hosting keys.">
        {selected && accounts.state === "ready" && (
          <AddAccountDialog
            orgId={selected.org.id}
            orgName={selected.org.name}
            isAdmin={selected.role === "admin"}
            capabilities={capabilities}
          />
        )}
      </PageHeader>

      <ModelAccounts list={accounts} selected={selected} capabilities={capabilities} now={now} />

      <section className="space-y-3" aria-labelledby="hosting">
        <SectionHeader id="hosting" title="Hosting" description="Pays for and runs sandboxes. Never enters one." />
        {!encryptionKey() && (
          <Alert variant="destructive">
            <AlertDescription>
              Credential encryption is not configured on this server: hosting keys cannot be saved.
            </AlertDescription>
          </Alert>
        )}

        <CredentialSection
          title="Your hosting keys"
          description="Only you see these. They host your private goldens."
          scope="user"
          owner={viewer.id}
          rows={personal}
          canManage
        />

        {selected && (
          <p className="text-sm text-muted-foreground" data-org-hosting>
            Boat and Modal for {selected.org.name} are its{" "}
            <Link className="underline underline-offset-4" href={PROVIDER_SETTINGS_PATH}>
              sandbox providers in Settings
            </Link>
            .
          </p>
        )}
      </section>
    </>
  );
}

const HARNESS_ORDER: Harness[] = ["claude", "codex"];
/** The kind the add dialog opens on from an agent with no account: its subscription sign-in. */
const FIRST_KIND: Record<Harness, AccountKind> = { claude: "claude_oauth", codex: "codex_auth" };

/** Defaults first, then yours before the org's, then by name: the order a person scans for "which one bills". */
function ordered(accounts: ModelAccount[]): ModelAccount[] {
  return [...accounts].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      (a.scope === b.scope ? 0 : a.scope === "user" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
}

async function ModelAccounts({
  list,
  selected,
  capabilities,
  now,
}: {
  list: AccountList;
  selected: Awaited<ReturnType<typeof selectedOrganization>>;
  capabilities: AuthCapabilities | null;
  now: number;
}) {
  if (list.state === "no-org" || !selected)
    return (
      <Empty title="No organization yet">
        <Link className="underline" href="/orgs">
          Create an organization
        </Link>{" "}
        to add model accounts.
      </Empty>
    );
  if (list.state === "not-configured")
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertDescription>The Armada server is not configured: model accounts cannot be managed here.</AlertDescription>
      </Alert>
    );
  if (list.state === "legacy")
    return (
      <Alert data-accounts="legacy">
        <CircleAlertIcon />
        <AlertTitle>This Armada server predates named accounts</AlertTitle>
        <AlertDescription>
          Your saved model keys still launch. Update the server to name them, add more and choose one per launch.
        </AlertDescription>
      </Alert>
    );
  if (list.state === "error")
    return (
      <Alert variant="destructive" data-accounts="error">
        <CircleAlertIcon />
        <AlertTitle>Model accounts could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{list.message}</p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href="/credentials">Try again</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );

  const usage = await readAccountUsage(list.accounts);
  return (
    <>
      {HARNESS_ORDER.map((harness) => (
        <HarnessAccounts
          key={harness}
          harness={harness}
          harnessLabel={HARNESS_LABELS[harness]}
          resolved={launchDefault(list.accounts, harness, now)}
          accounts={ordered(accountsFor(list.accounts, harness))}
          orgId={selected.org.id}
          orgName={selected.org.name}
          isAdmin={selected.role === "admin"}
          usage={usage}
          now={now}
          emptyAction={
            <AddAccountDialog
              orgId={selected.org.id}
              orgName={selected.org.name}
              isAdmin={selected.role === "admin"}
              capabilities={capabilities}
              initialKind={FIRST_KIND[harness]}
              triggerLabel={`Add a ${HARNESS_LABELS[harness]} account`}
              triggerVariant="outline"
            />
          }
        />
      ))}
    </>
  );
}

function CredentialSection({
  title,
  description,
  scope,
  owner,
  rows,
  canManage,
}: {
  title: string;
  description: string;
  /** Only the viewer's own: an organization's hosting is its providers in Settings. */
  scope: "user";
  owner: string;
  rows: CredentialRow[];
  canManage: boolean;
}) {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return (
    <div data-credentials={scope} className="space-y-4">
      {/* What is stored, apart from the forms that store it. */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="space-y-0.5 border-b px-4 py-3">
          <h3 id={`credentials-${scope}`} className="text-sm font-semibold">
            {title}
          </h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <ul className="divide-y" aria-labelledby={`credentials-${scope}`}>
          {CREDENTIAL_KINDS.map((info) => {
            const row = byKind.get(info.kind);
            return (
              <li key={info.kind} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs [&_svg]:size-4"
                  >
                    <KeyRoundIcon />
                  </span>
                  <p className="text-sm font-medium">{info.label}</p>
                </div>
                {row ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className="font-mono text-sm tracking-widest text-muted-foreground"
                      role="img"
                      aria-label="Value hidden"
                    >
                      ••••••••
                    </span>
                    <ToneBadge tone="success" data-credential-state="set">
                      Set <time dateTime={row.created_at}>{new Date(row.created_at).toISOString().slice(0, 10)}</time>
                    </ToneBadge>
                    {canManage && (
                      <ActionForm action={removeCredential} className="flex flex-col items-end gap-1">
                        <input type="hidden" name="id" value={row.id} />
                        <SubmitButton variant="ghost" size="sm" aria-label={`Remove ${info.label}`}>
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ) : (
                  <ToneBadge tone="neutral" data-credential-state="not-set">
                    Not set
                  </ToneBadge>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-4" data-hosting-form="key">
            <CardHeader>
              <CardTitle role="heading" aria-level={4}>
                Save a key
              </CardTitle>
              <CardDescription>Replaces the one stored for that kind.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveCredential} resetOnSuccess className="grid gap-3">
                <input type="hidden" name="scope" value={scope} />
                <input type="hidden" name="owner" value={owner} />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <Label htmlFor={`kind-${owner}`}>Kind</Label>
                    <NativeSelect id={`kind-${owner}`} name="kind" defaultValue="boat">
                      {SINGLE_VALUE_KINDS.map((info) => (
                        <option key={info.kind} value={info.kind}>
                          {info.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`value-${owner}`}>Value</Label>
                    <Input
                      id={`value-${owner}`}
                      name="value"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      placeholder="Paste the value"
                    />
                  </div>
                </div>
                <SubmitButton className="justify-self-start">Save credential</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>

          <Card className="gap-4" data-modal-token>
            <CardHeader>
              <CardTitle role="heading" aria-level={4}>
                Modal token
              </CardTitle>
              <CardDescription>A token ID and its secret, stored together.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveCredential} resetOnSuccess className="grid gap-3">
                <input type="hidden" name="scope" value={scope} />
                <input type="hidden" name="owner" value={owner} />
                <input type="hidden" name="kind" value="modal" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`modal-id-${owner}`}>Token ID</Label>
                    <Input
                      id={`modal-id-${owner}`}
                      name="modal_token_id"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      placeholder="ak-…"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`modal-secret-${owner}`}>Token secret</Label>
                    <Input
                      id={`modal-secret-${owner}`}
                      name="modal_token_secret"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      placeholder="as-…"
                    />
                  </div>
                </div>
                <SubmitButton className="justify-self-start">Save Modal token</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
