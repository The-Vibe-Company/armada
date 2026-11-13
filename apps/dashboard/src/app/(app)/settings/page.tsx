import { githubAppFromEnv } from "@armada/core";
import { GitPullRequestIcon } from "lucide-react";
import type { Metadata } from "next";
import { disconnectGitHub } from "@/app/actions/github";
import { ConfirmedAction } from "@/components/confirmed-action";
import { PageHeader } from "@/components/page-header";
import { PersonalProviderKeys } from "@/components/personal-provider-keys";
import { ConnectionBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listCredentials } from "@/lib/data/credentials";
import { getGitHubConnection } from "@/lib/data/github";
import { requireViewer } from "@/lib/data/viewer";
import {
  GITHUB_RESULT_MESSAGES,
  githubInstallationManageUrl,
  githubInstallUrl,
  isGitHubResult,
  storedGitHubInstallations,
} from "@/lib/github";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const [connection, params, credentials] = await Promise.all([
    getGitHubConnection(supabase),
    searchParams,
    listCredentials(supabase),
  ]);
  const personalKeys = credentials.filter((item) => item.scope === "user" && item.owner_id === viewer.id);
  const configured = githubAppFromEnv(process.env) !== null;
  const installUrl = githubInstallUrl(process.env.GITHUB_APP_SLUG);
  const result = isGitHubResult(params.github) ? GITHUB_RESULT_MESSAGES[params.github] : null;
  const revoked = connection?.revoked_at != null;
  const installations = connection && !revoked ? storedGitHubInstallations(connection.installations) : [];

  return (
    <>
      <PageHeader title="Settings" />
      {result && (
        <Alert variant={result.ok ? "default" : "destructive"}>
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}

      <PersonalProviderKeys owner={viewer.id} rows={personalKeys} />

      <Card data-settings="github">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequestIcon className="size-4" />
            GitHub
          </CardTitle>
          <CardDescription>Sandboxes commit, push and use gh as you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!configured && (
            <Alert variant="destructive">
              <AlertDescription>
                The GitHub App is not configured on this server: GitHub cannot be connected.
              </AlertDescription>
            </Alert>
          )}

          {connection && !revoked ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              data-github-state="connected"
            >
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>
                    <span className="font-mono">@{connection.login}</span>
                    {connection.name ? ` (${connection.name})` : ""}
                  </span>
                  <ConnectionBadge state="connected" />
                </p>
                <p className="text-xs break-all text-muted-foreground">
                  {connection.github_id}+{connection.login}@users.noreply.github.com, since{" "}
                  {new Date(connection.created_at).toISOString().slice(0, 10)}
                </p>
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
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

          {connection && !revoked && installations.length === 0 && (
            <Alert variant="destructive" data-github-installations="missing">
              <AlertDescription>
                The Armada GitHub App is not installed on an account you can access: sandboxes cannot push.
                {installUrl ? (
                  <>
                    {" "}
                    <a href={installUrl} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                      Install the app
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
                      <p className="text-sm font-medium">{installation.account}</p>
                      <p className="text-xs text-muted-foreground">
                        {installation.account_type === "Organization" ? "Organization" : "Account"} ·{" "}
                        {installation.repository_selection === "all" ? "All repositories" : "Selected repositories"}
                      </p>
                    </div>
                    {manage && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={manage} target="_blank" rel="noreferrer">
                          Manage installation
                        </a>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-sm text-muted-foreground">
            Only repositories with the app installed.
            {installUrl && installations.length === 0 && !(connection && !revoked) ? (
              <>
                {" "}
                <a href={installUrl} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                  Install the app on your repositories
                </a>
                .
              </>
            ) : null}
            {installUrl && installations.length > 0 ? (
              <>
                {" "}
                <a href={installUrl} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                  Install it on another account
                </a>
                .
              </>
            ) : null}
          </p>
        </CardContent>
      </Card>
    </>
  );
}
