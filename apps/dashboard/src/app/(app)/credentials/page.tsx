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
import { CREDENTIAL_KINDS } from "@/lib/credentials";
import { type CredentialRow, listCredentials } from "@/lib/data/credentials";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { masterKey } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const [memberships, credentials] = await Promise.all([
    listMemberships(supabase, viewer.id),
    listCredentials(supabase),
  ]);
  const personal = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Keys and tokens Armada injects into the sandboxes it launches. Your own come before your org's."
      />
      {!masterKey() && (
        <Alert variant="destructive">
          <AlertDescription>
            Credential encryption is not configured on this dashboard (ARMADA_MASTER_KEY), so keys cannot be saved yet.
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
                  <p className="font-mono text-xs text-muted-foreground">{info.env}</p>
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
                  {CREDENTIAL_KINDS.map((info) => (
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
      </CardContent>
    </Card>
  );
}
