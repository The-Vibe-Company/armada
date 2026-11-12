import { encryptionKey } from "@armada/core";
import { KeyRoundIcon } from "lucide-react";
import { removeCredential, saveCredential } from "@/app/actions/credentials";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConfirmedAction } from "@/components/confirmed-action";
import { ToneBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CREDENTIAL_KINDS, SINGLE_VALUE_KINDS } from "@/lib/credentials";
import type { CredentialRow } from "@/lib/data/credentials";

/**
 * The viewer's own provider keys (Boat, Modal): they host the viewer's private goldens and never connect a provider
 * for an organization. Moved from the Credentials page to Settings → Providers (#805) with the same forms and server
 * actions; an organization's keys are its provider rows above them, changed only by an admin.
 */
export function PersonalProviderKeys({ owner, rows }: { owner: string; rows: CredentialRow[] }) {
  return (
    <Card data-settings="personal-keys" id="personal-keys" aria-labelledby="personal-provider-keys">
      <CardHeader>
        <CardTitle id="personal-provider-keys" role="heading" aria-level={2} className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Your personal provider keys
        </CardTitle>
        <CardDescription>Only you see these. They host your private goldens, never an organization's.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!encryptionKey() && (
          <Alert variant="destructive">
            <AlertDescription>
              Encryption is not configured on this server: provider keys cannot be saved.
            </AlertDescription>
          </Alert>
        )}
        <CredentialSection scope="user" owner={owner} rows={rows} canManage />
      </CardContent>
    </Card>
  );
}

function CredentialSection({
  scope,
  owner,
  rows,
  canManage,
}: {
  /** Only the viewer's own: an organization's keys are its provider rows. */
  scope: "user";
  owner: string;
  rows: CredentialRow[];
  canManage: boolean;
}) {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return (
    <div data-credentials={scope} className="space-y-4">
      {/* What is stored, apart from the forms that store it. */}
      <div className="overflow-hidden rounded-lg border">
        <ul className="divide-y" aria-labelledby="personal-provider-keys">
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
                      <ConfirmedAction
                        action={removeCredential}
                        trigger="Remove"
                        triggerLabel={`Remove ${info.label}`}
                        title={`Remove ${info.label}?`}
                        description={`This removes your saved ${info.label}. You will need to save it again to build or launch private goldens with this provider. Organization providers are not affected.`}
                        confirm="Remove key"
                        pendingLabel="Removing…"
                        successFocusId={`kind-${owner}`}
                      >
                        <input type="hidden" name="id" value={row.id} />
                      </ConfirmedAction>
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
          <div className="space-y-3 rounded-lg border p-4" data-hosting-form="key">
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold">Save a key</h3>
              <p className="text-sm text-muted-foreground">Replaces the one stored for that kind.</p>
            </div>
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
              <SubmitButton className="justify-self-start">Save key</SubmitButton>
            </ActionForm>
          </div>

          <div className="space-y-3 rounded-lg border p-4" data-modal-token>
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold">Modal token</h3>
              <p className="text-sm text-muted-foreground">A token ID and its secret, stored together.</p>
            </div>
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
          </div>
        </div>
      )}
    </div>
  );
}
