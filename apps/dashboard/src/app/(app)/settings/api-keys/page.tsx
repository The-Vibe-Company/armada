import { controlRouteKey, tokenOperations } from "@armada/core/contract";
import { KeyRoundIcon, PlugIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { revokeApiKey } from "@/app/actions/api-keys";
import { ApiKeyCreateDialog } from "@/components/api-key-create-dialog";
import { ConfirmedAction } from "@/components/confirmed-action";
import { CopyButton } from "@/components/copy-button";
import { Empty } from "@/components/page-header";
import { ResourceBrowser } from "@/components/resource-browser";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createControlClient } from "@/lib/control";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Armada API keys" };

function date(value: string | null) {
  return value?.slice(0, 10) ?? "Never";
}

function mcpEndpointUrl(serverUrl: string | null) {
  if (!serverUrl) return null;
  try {
    return new URL("/mcp", serverUrl).href;
  } catch {
    return null;
  }
}

export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const serverUrl = mcpUrl();
  const mcpEndpoint = mcpEndpointUrl(serverUrl);
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
    <div className="mx-auto w-full max-w-[920px] space-y-6">
      <ResourceBrowser
        title="Armada API keys"
        description="Service tokens for CLIs, scripts, and external MCP clients to launch and manage sandboxes in one organization."
        label="Armada API keys"
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
              <AlertDescription>Armada API keys could not be loaded. Try again.</AlertDescription>
            </Alert>
          )
        }
        empty={
          result ? (
            <Empty title="No Armada API keys yet" icon={<KeyRoundIcon />}>
              Create an Armada API key to authenticate the CLI, CI scripts, or external MCP clients for one
              organization.
            </Empty>
          ) : null
        }
        footer={
          <Card data-armada-mcp-guide className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <PlugIcon aria-hidden className="size-4" />
                Connect Claude, Cursor, or Codex to Armada MCP
              </CardTitle>
              <CardDescription>
                Use this endpoint to control Armada from an external MCP client with an Armada API key. To give agents
                inside sandboxes external MCP tools, configure{" "}
                <Link href="/tools" className="underline underline-offset-4">
                  Tools (MCP servers)
                </Link>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code className="min-w-0 break-all font-mono text-xs">{mcpEndpoint ?? "<armada-url>/mcp"}</code>
                {mcpEndpoint && <CopyButton value={mcpEndpoint} label="Copy Armada MCP URL" showLabel />}
              </div>
              <p className="text-xs text-muted-foreground">
                Send <code className="font-mono">Authorization: Bearer &lt;armada-api-key&gt;</code> (or sign in via
                OAuth in clients that support it).
              </p>
            </CardContent>
          </Card>
        }
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
