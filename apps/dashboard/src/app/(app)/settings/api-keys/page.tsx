import { controlRouteKey, tokenOperations } from "@armada/core/contract";
import type { Metadata } from "next";
import { revokeApiKey } from "@/app/actions/api-keys";
import { ApiKeyCreateDialog } from "@/components/api-key-create-dialog";
import { ConfirmedAction } from "@/components/confirmed-action";
import { ResourceBrowser } from "@/components/resource-browser";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createControlClient } from "@/lib/control";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "API keys" };

function date(value: string | null) {
  return value?.slice(0, 10) ?? "Never";
}

export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const serverUrl = mcpUrl();
  const op = tokenOperations.listServiceTokens;
  const result =
    viewer.token && serverUrl
      ? await createControlClient({ serverUrl, token: viewer.token })
          .post(controlRouteKey(op.route), {})
          .then((value) => op.output.parse(value))
          .catch(() => null)
      : null;
  const [memberships, params] = await Promise.all([listMemberships(supabase, viewer.id), searchParams]);

  return (
    <div className="mx-auto w-full max-w-[920px]">
      <ResourceBrowser
        title="API keys"
        description="Give agents and scripts access to Armada in one organization."
        label="API keys"
        blockers={[]}
        initial={params.item ?? null}
        actions={
          result && memberships.length > 0 ? (
            <ApiKeyCreateDialog orgs={memberships.map(({ org }) => ({ id: org.id, name: org.name }))} />
          ) : null
        }
        notices={
          !result && (
            <Alert variant="destructive">
              <AlertDescription>API keys could not be loaded. Try again.</AlertDescription>
            </Alert>
          )
        }
        empty={result ? "No API keys yet." : null}
        variant="table"
        columns={["Name and organization", "Created", "Last used", "Expires", "Status"]}
        rows={(result?.tokens ?? []).map((key) => {
          const state = key.revokedAt
            ? "Revoked"
            : key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
              ? "Expired"
              : "Active";
          return {
            key: key.id,
            name: key.label,
            search: `${key.label} ${key.orgName}`,
            meta: key.orgName,
            state: null,
            columns: [
              { key: "Created", content: date(key.createdAt) },
              { key: "Last used", content: date(key.lastUsedAt) },
              { key: "Expires", content: date(key.expiresAt) },
              { key: "Status", content: state },
            ],
            detail: (
              <div className="space-y-4">
                <dl className="grid grid-cols-1 gap-x-2 gap-y-1 break-words text-sm max-sm:[&_dd:not(:last-child)]:mb-2 sm:grid-cols-2">
                  <dt>Organization</dt>
                  <dd>{key.orgName}</dd>
                  <dt>Status</dt>
                  <dd>{state}</dd>
                  <dt>Created</dt>
                  <dd>{date(key.createdAt)}</dd>
                  <dt>Last used</dt>
                  <dd>{date(key.lastUsedAt)}</dd>
                  <dt>Expires</dt>
                  <dd>{date(key.expiresAt)}</dd>
                </dl>
                {!key.revokedAt && (
                  <ConfirmedAction
                    action={revokeApiKey.bind(null, key.id)}
                    trigger="Revoke"
                    triggerLabel={`Revoke ${key.label}`}
                    title="Revoke this API key?"
                    description="Agents and scripts using this key will lose access."
                    confirm="Revoke API key"
                    pendingLabel="Revoking…"
                    successFocusId="api-key-create"
                  />
                )}
              </div>
            ),
          };
        })}
      />
    </div>
  );
}
