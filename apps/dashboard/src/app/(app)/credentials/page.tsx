import { encryptionKey } from "@armada/core";
import type { Metadata } from "next";
import { removeCredential, saveCredential } from "@/app/actions/credentials";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CREDENTIAL_KINDS, SINGLE_VALUE_KINDS } from "@/lib/credentials";
import { type CredentialRow, listCredentials } from "@/lib/data/credentials";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [memberships, credentials] = await Promise.all([
    listMemberships(supabase, viewer.id).then((items) => items.filter((item) => item.org.id === selected?.org.id)),
    listCredentials(supabase),
  ]);
  const personal = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Model credentials run the agents inside your sandboxes; hosting credentials (Boat, Modal) pay for and run the sandboxes and stay on the Armada server. Your own are used before your org's."
      />
      {!encryptionKey() && (
        <Alert variant="destructive">
          <AlertDescription>
            Credential encryption is not configured (ARMADA_ENCRYPTION_KEY), so keys cannot be saved yet.
          </AlertDescription>
        </Alert>
      )}
      <Alert>
        <AlertDescription>
          Values are encrypted before they are stored and are never shown again. To change one, set it again. OpenCode
          and z.ai keys come with OpenCode support.
        </AlertDescription>
      </Alert>

      <CredentialSection
        title="Your credentials"
        description="Used for your launches. Nobody else can see that they exist."
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
              ? "Defaults for every member of the org. You are an admin: you manage them."
              : "Defaults for every member of the org. Only an admin changes them."
          }
          scope="org"
          owner={org.id}
          rows={credentials.filter((item) => item.scope === "org" && item.owner_id === org.id)}
          canManage={role === "admin"}
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
  scope: "user" | "org";
  owner: string;
  rows: CredentialRow[];
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
            const row = byKind.get(info.kind);
            return (
              <li key={info.kind} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{info.label}</p>
                  {info.env ? (
                    <p className="font-mono text-xs text-muted-foreground">{info.env}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Hosting: stays on the Armada server</p>
                  )}
                </div>
                {row ? (
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm tracking-widest" role="img" aria-label="Value hidden">
                      ••••••••
                    </span>
                    <Badge variant="outline">Set {new Date(row.created_at).toISOString().slice(0, 10)}</Badge>
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
                  <Badge variant="secondary">Not set</Badge>
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
                <NativeSelect id={`kind-${owner}`} name="kind" defaultValue="claude_oauth">
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
                  placeholder="Paste the key or token"
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
              <div>
                <p className="text-sm font-medium">Modal token</p>
                <p className="text-xs text-muted-foreground">
                  From modal.com, Settings, API tokens. Both halves are stored together and never shown again; saving
                  again replaces them.
                </p>
              </div>
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
