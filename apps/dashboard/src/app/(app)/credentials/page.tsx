import type { Harness } from "@armada/core";
import { encryptionKey } from "@armada/core";
import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { removeCredential, saveCredential } from "@/app/actions/credentials";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AddAccountDialog, HarnessAccounts } from "@/components/model-accounts";
import { Empty, PageHeader, SectionHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CREDENTIAL_KINDS, SINGLE_VALUE_KINDS } from "@/lib/credentials";
import { type CredentialRow, listCredentials } from "@/lib/data/credentials";
import { type AccountList, listSelectedAccounts, readAccountUsage } from "@/lib/data/model-accounts";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { HARNESS_LABELS } from "@/lib/labels";
import { accountsFor, launchDefault, type ModelAccount } from "@/lib/model-accounts";
import { isConfigured } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [memberships, credentials, accounts] = await Promise.all([
    listMemberships(supabase, viewer.id).then((items) => items.filter((item) => item.org.id === selected?.org.id)),
    listCredentials(supabase),
    listSelectedAccounts(),
  ]);
  const personal = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);
  // An org Boat key is its org's column, which only the server can see (null: the server could not be asked).
  const orgBoat = new Map(
    await Promise.all(
      memberships.map(async ({ org }) => {
        const setup = await readProviderSetup(org.id);
        return [org.id, setup.state === "unavailable" ? null : isConfigured(setup.status, "boat")] as const;
      }),
    ),
  );
  const now = Date.now();

  return (
    <>
      <PageHeader title="Credentials" description="The accounts your agents run on, and your own hosting keys.">
        {selected && accounts.state === "ready" && (
          <AddAccountDialog orgId={selected.org.id} orgName={selected.org.name} isAdmin={selected.role === "admin"} />
        )}
      </PageHeader>

      <ModelAccounts list={accounts} selected={selected} now={now} />

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

        {memberships.map(({ org, role }) => (
          <CredentialSection
            key={org.id}
            title={`${org.name} (org)`}
            description={
              role === "admin"
                ? "Shared with every member. You manage them."
                : "Shared with every member. Only an admin changes them."
            }
            scope="org"
            owner={org.id}
            rows={credentials.filter((item) => item.scope === "org" && item.owner_id === org.id)}
            orgBoat={orgBoat.get(org.id) ?? null}
            canManage={role === "admin"}
          />
        ))}
      </section>
    </>
  );
}

const HARNESS_ORDER: Harness[] = ["claude", "codex"];

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
  now,
}: {
  list: AccountList;
  selected: Awaited<ReturnType<typeof selectedOrganization>>;
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
  orgBoat,
  canManage,
}: {
  title: string;
  description: string;
  scope: "user" | "org";
  owner: string;
  rows: CredentialRow[];
  /** The org section's Boat key, as the server reports it: set, not set, or null when it could not be checked. */
  orgBoat?: boolean | null;
  canManage: boolean;
}) {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return (
    <Card data-credentials={scope === "user" ? "user" : title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="divide-y rounded-lg border">
          {CREDENTIAL_KINDS.map((info) => {
            const orgKey = scope === "org" && info.kind === "boat";
            const row = orgKey ? undefined : byKind.get(info.kind);
            const set = orgKey ? orgBoat : Boolean(row);
            return (
              <li key={info.kind} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{info.label}</p>
                </div>
                {set ? (
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm tracking-widest" role="img" aria-label="Value hidden">
                      ••••••••
                    </span>
                    <Badge variant="outline">
                      {row ? `Set ${new Date(row.created_at).toISOString().slice(0, 10)}` : "Set"}
                    </Badge>
                    {canManage && (
                      <ActionForm action={removeCredential} className="flex flex-col items-end gap-1">
                        {row ? (
                          <input type="hidden" name="id" value={row.id} />
                        ) : (
                          <>
                            <input type="hidden" name="scope" value="org" />
                            <input type="hidden" name="owner" value={owner} />
                            <input type="hidden" name="kind" value="boat" />
                          </>
                        )}
                        <SubmitButton variant="ghost" size="sm" aria-label={`Remove ${info.label}`}>
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ) : (
                  <Badge variant="secondary">{set === null ? "Unavailable" : "Not set"}</Badge>
                )}
              </li>
            );
          })}
        </ul>

        {canManage && (
          <ActionForm action={saveCredential} resetOnSuccess className="grid gap-3 sm:max-w-xl">
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="owner" value={owner} />
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
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
        )}

        {canManage && (
          <div data-modal-token className="border-t pt-6">
            <ActionForm action={saveCredential} resetOnSuccess className="grid gap-3 sm:max-w-xl">
              <input type="hidden" name="scope" value={scope} />
              <input type="hidden" name="owner" value={owner} />
              <input type="hidden" name="kind" value="modal" />
              <p className="text-sm font-medium">Modal token</p>
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
