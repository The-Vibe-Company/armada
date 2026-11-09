import { githubAppFromEnv } from "@armada/core";
import { GitPullRequestIcon } from "lucide-react";
import type { Metadata } from "next";
import { disconnectGitHub } from "@/app/actions/github";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  await requireViewer();
  const supabase = await createClient();
  const [connection, params] = await Promise.all([getGitHubConnection(supabase), searchParams]);
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
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  Connected as <span className="font-mono">@{connection.login}</span>
                  {connection.name ? ` (${connection.name})` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {connection.github_id}+{connection.login}@users.noreply.github.com, since{" "}
                  {new Date(connection.created_at).toISOString().slice(0, 10)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Connected</Badge>
                {configured && (
                  <Button variant="outline" size="sm" asChild>
                    <a href="/github/connect">Reconnect</a>
                  </Button>
                )}
                <ActionForm action={disconnectGitHub}>
                  <SubmitButton variant="ghost" size="sm">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  {revoked ? `GitHub access for @${connection?.login} was revoked or expired.` : "Not connected."}
                </p>
                <p className="text-xs text-muted-foreground">Sandboxes have no GitHub identity.</p>
              </div>
              {configured && (
                <Button asChild>
                  <a href="/github/connect">{revoked ? "Reconnect GitHub" : "Connect GitHub"}</a>
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
            ) : null}{" "}
            Sandbox GitHub tokens last 8 hours.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
