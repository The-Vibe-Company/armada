import { githubAppFromEnv } from "@armada/core";
import { ExternalLinkIcon, GitPullRequestIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { disconnectGitHub } from "@/app/actions/github";
import { ConfirmedAction } from "@/components/confirmed-action";
import { ConnectionPreferences } from "@/components/connection-preferences";
import { PageHeader } from "@/components/page-header";
import { PersonalProviderKeys } from "@/components/personal-provider-keys";
import { ConnectionBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createControlClient } from "@/lib/control";
import { listCredentials } from "@/lib/data/credentials";
import { getGitHubConnection } from "@/lib/data/github";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  GITHUB_RESULT_MESSAGES,
  githubInstallationManageUrl,
  githubInstallationsSummary,
  githubInstallUrl,
  isGitHubResult,
  resolveSettingsGitHubView,
  syncGitHubStatus,
} from "@/lib/github";
import { createClient } from "@/lib/supabase/server";
import { GitHubSyncButton } from "./github-sync-button";

export const metadata: Metadata = { title: "Your connections" };
export const dynamic = "force-dynamic";

const SSR_STATUS_TIMEOUT_MS = 5_000;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const serverUrl = mcpUrl();
  const [connection, params, credentials, liveStatus] = await Promise.all([
    getGitHubConnection(supabase),
    searchParams,
    listCredentials(supabase),
    serverUrl && viewer.token
      ? syncGitHubStatus(createControlClient({ serverUrl, token: viewer.token, timeoutMs: SSR_STATUS_TIMEOUT_MS }))
      : Promise.resolve(null),
  ]);
  const personalKeys = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);
  const configured = githubAppFromEnv(process.env) !== null;
  const result = isGitHubResult(params.github) ? GITHUB_RESULT_MESSAGES[params.github] : null;
  const view = resolveSettingsGitHubView({
    dbConnection: connection,
    liveStatus,
    serverConfigured: Boolean(serverUrl && viewer.token),
    envInstallUrl: githubInstallUrl(process.env.GITHUB_APP_SLUG),
  });
  const connected = view.state === "connected" && connection !== null;
  const revoked = view.state === "revoked";
  const { installations, installUrl } = view;

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-7">
      <PageHeader
        title="Your connections"
        description="Your personal GitHub identity, optional personal cloud keys, and Armada API keys."
      >
        <Button asChild variant="outline">
          <Link href="/settings/api-keys">Armada API keys</Link>
        </Button>
      </PageHeader>
      {result && (
        <Alert variant={result.ok ? "default" : "destructive"} data-github-result={params.github}>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{result.text}</span>
            {params.github === "requested" && connected && <GitHubSyncButton label="Refresh status" />}
          </AlertDescription>
        </Alert>
      )}

      <Card data-settings="github" className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequestIcon className="size-4" />
            GitHub
          </CardTitle>
          <CardDescription>Sandboxes commit and push as you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!configured && (
            <Alert variant="destructive">
              <AlertDescription>
                The GitHub App is not configured on this server: GitHub cannot be connected.
              </AlertDescription>
            </Alert>
          )}

          {connected ? (
            <div className="flex flex-wrap items-center justify-between gap-3" data-github-state="connected">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>
                    <span className="font-mono">@{connection.login}</span>
                    {connection.name ? ` (${connection.name})` : ""}
                  </span>
                  <ConnectionBadge state="connected" />
                </p>
                <details className="text-xs break-all text-muted-foreground">
                  <summary className="cursor-pointer">Technical details</summary>
                  {connection.github_id}+{connection.login}@users.noreply.github.com, since{" "}
                  {new Date(connection.created_at).toISOString().slice(0, 10)}
                </details>
              </div>
              <div className="flex items-center gap-2">
                {configured && (
                  <Button variant="outline" size="sm" asChild>
                    <a href="/github/connect">Reconnect</a>
                  </Button>
                )}
                <ConfirmedAction
                  action={disconnectGitHub}
                  trigger="Disconnect"
                  title="Disconnect GitHub?"
                  description="Armada will forget your GitHub connection. New sandboxes will have no GitHub identity until you reconnect. Revoke Armada's authorization in GitHub settings to invalidate tokens already issued."
                  confirm="Disconnect GitHub"
                  pendingLabel="Disconnecting…"
                  successFocusId="github-connect"
                />
              </div>
            </div>
          ) : (
            <div
              className="flex flex-wrap items-center justify-between gap-3"
              data-github-state={revoked ? "revoked" : "not-connected"}
            >
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {revoked ? <span className="font-mono">@{connection?.login}</span> : "Your GitHub account"}
                  <ConnectionBadge state={revoked ? "revoked" : "not-connected"} />
                </p>
                <p className="text-xs text-muted-foreground">
                  {revoked
                    ? `GitHub access for @${connection?.login} was revoked or expired. Sandboxes have no GitHub identity.`
                    : "Sandboxes have no GitHub identity until you connect it."}
                </p>
              </div>
              {configured && (
                <Button asChild size="sm">
                  <a id="github-connect" href="/github/connect">
                    {revoked ? "Reconnect GitHub" : "Connect GitHub"}
                  </a>
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card data-settings="github-installations">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle>Armada's GitHub App</CardTitle>
            <CardDescription>
              Install Armada's GitHub App on your personal account and GitHub organizations so sandboxes can reach their
              repositories.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {installUrl && (
              <Button asChild size="sm" variant={connected ? "default" : "outline"}>
                <a href={installUrl} target="_blank" rel="noreferrer" data-github-connect-org="cta">
                  <PlusIcon aria-hidden="true" className="size-3.5" />
                  Connect GitHub organization
                </a>
              </Button>
            )}
            {connected && <GitHubSyncButton />}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected && installations.length === 0 && (
            <Alert variant="destructive" data-github-installations="missing">
              <AlertDescription>
                The Armada GitHub App is not installed on any GitHub account or organization you can access: sandboxes
                cannot clone or push private repositories.
                {installUrl ? (
                  <>
                    {" "}
                    <a href={installUrl} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                      Connect GitHub organization
                    </a>
                    .
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
          )}

          {installations.length > 0 && (
            <ul className="space-y-2" data-github-installations="ready">
              {installations.map((installation) => {
                const manage = githubInstallationManageUrl({
                  id: installation.id,
                  account: installation.account,
                  accountType: installation.account_type,
                });
                return (
                  <li
                    key={installation.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    data-github-installation={installation.account}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-medium">{installation.account}</p>
                        <Badge variant="secondary">
                          {installation.account_type === "Organization" ? "Organization" : "Personal account"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {installation.repository_selection === "all"
                          ? "All repositories"
                          : "Selected repositories only"}
                      </p>
                    </div>
                    {manage && (
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={manage}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Manage installation for ${installation.account}`}
                        >
                          Manage installation
                          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                        </a>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{githubInstallationsSummary(installations)}</p>
            {connected && view.liveSync === "fallback" && (
              <p data-github-installations-sync="fallback">
                Showing saved installations; live sync with GitHub is temporarily unavailable.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <PersonalProviderKeys owner={viewer.id} rows={personalKeys} />
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Model accounts</h2>
            <p className="text-sm text-muted-foreground">Subscriptions and API keys your agents run on.</p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/harness">Models</Link>
          </Button>
        </CardContent>
      </Card>
      <ConnectionPreferences />
    </div>
  );
}
