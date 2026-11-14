import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { ProviderConnection, type ProviderRowState } from "@/components/provider-connection";
import { ProviderMark } from "@/components/provider-mark";
import { ToneBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type DockerHostsState, readSelectedDockerHosts } from "@/lib/data/docker-hosts";
import { type ProviderSetup, readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import type { Membership } from "@/lib/data/viewer";
import { HOSTS_PATH } from "@/lib/docker-hosts";
import { CLOUD_PROVIDERS_PATH, isConfigured, SETUP_PROVIDERS } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Providers" };
export const dynamic = "force-dynamic";

const DESCRIPTION = "Cloud accounts and self-hosted machines for your organization.";

/**
 * Cloud sandbox providers (#1474, moved out of Settings): the active organization's Boat and Modal accounts, which an
 * admin connects, replaces and disconnects, and a member sees the status of. The self-hosted machines live on the
 * Hosts page; a viewer's personal provider keys stay in Settings.
 */
export default async function CloudProvidersPage() {
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [setup, admins, hosts] = await Promise.all([
    selected ? readProviderSetup(selected.org.id) : null,
    // A member is told whom to ask; an admin manages the providers here.
    selected && selected.role !== "admin"
      ? supabase
          .rpc("org_members", { target_org: selected.org.id })
          .then(({ data }) => (data ?? []).filter((member) => member.role === "admin").map((member) => member.email))
      : [],
    readSelectedDockerHosts(),
  ]);
  return (
    <>
      <PageHeader title="Providers" description={DESCRIPTION} />
      <SandboxProviders selected={selected} setup={setup} admins={admins} />
      <MachineProviders selected={selected} hosts={hosts} />
    </>
  );
}

function SandboxProviders({
  selected,
  setup,
  admins,
}: {
  selected: Membership | null;
  setup: ProviderSetup | null;
  admins: string[];
}) {
  const isAdmin = selected?.role === "admin";
  return (
    <Card data-settings="providers" aria-labelledby="sandbox-providers-title" id="sandbox-providers">
      <CardHeader>
        <CardTitle id="sandbox-providers-title" role="heading" aria-level={2} className="flex items-center gap-2">
          Cloud accounts
        </CardTitle>
        {selected && (
          <CardDescription>
            Accounts shared with {selected.org.name}. Only administrators change cloud connections.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!selected || !setup ? (
          <Empty
            title="Choose an organization"
            action={
              <Button asChild variant="outline">
                <Link href="/orgs">Create or join an organization</Link>
              </Button>
            }
          >
            Connect provider accounts and machines for the organization you work in.
          </Empty>
        ) : (
          <>
            {setup.state === "unavailable" && (
              <Alert variant="destructive" data-setup-state="unavailable">
                <TriangleAlertIcon />
                <AlertTitle>Provider status unavailable</AlertTitle>
                <AlertDescription>
                  <p>
                    Cloud account status could not be checked. Try again; your saved accounts have not been changed.
                  </p>
                  {/* A document request, not a client navigation: the router would reuse its cached render (staleTimes). */}
                  <a
                    className="inline-flex items-center gap-1 underline underline-offset-4"
                    href={CLOUD_PROVIDERS_PATH}
                  >
                    <RotateCwIcon className="size-3" aria-hidden />
                    Check again
                  </a>
                </AlertDescription>
              </Alert>
            )}
            <ul className="divide-y rounded-lg border" data-setup-state={setup.state} aria-label="Cloud accounts">
              {SETUP_PROVIDERS.map((provider) => {
                const state: ProviderRowState =
                  setup.state === "unavailable"
                    ? "unavailable"
                    : isConfigured(setup.status, provider)
                      ? "connected"
                      : "not-connected";
                return (
                  <ProviderConnection
                    // A switched organization mounts a fresh row: no open form or message carries over.
                    key={`${selected.org.id}.${provider}`}
                    orgId={selected.org.id}
                    orgName={selected.org.name}
                    provider={provider}
                    state={state}
                    canManage={isAdmin}
                  />
                );
              })}
            </ul>
            {!isAdmin && setup.state === "pending" && admins.length > 0 && (
              <p className="text-sm text-muted-foreground" data-provider-admins>
                Ask an admin to connect one:{" "}
                {admins.map((email, index) => (
                  <span key={email}>
                    {index > 0 && ", "}
                    <a className="text-foreground underline underline-offset-4" href={`mailto:${email}`}>
                      {email}
                    </a>
                  </span>
                ))}
                .
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One overview of usable placement choices; setup entries are not machines that can take work. */
function MachineProviders({ selected, hosts }: { selected: Membership | null; hosts: DockerHostsState }) {
  if (!selected || hosts.state === "disabled") return null;
  const admin = selected.role === "admin";
  const machines =
    hosts.state === "ready"
      ? hosts.list.hosts.filter((host) => host.state === "online" || host.state === "offline")
      : [];
  return (
    <Card data-provider-machines>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Self-hosted machines
        </CardTitle>
        <CardDescription>Machines shared with {selected.org.name}. Sandboxes run in Docker.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hosts.state === "ready" && !hosts.list.placement && (
          <p role="status" className="text-sm text-muted-foreground">
            Launching on self-hosted machines is not enabled here yet. You can still view their connections.
          </p>
        )}
        {hosts.state === "ready" && hosts.list.skipped > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Some machines could not be shown. Open Self-hosted to review them.
          </p>
        )}
        {hosts.state === "error" ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Machine status unavailable</AlertTitle>
            <AlertDescription>
              <p>Your machines could not be loaded. Open Self-hosted to check the connection and try again.</p>
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link href={HOSTS_PATH}>View machines</Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : machines.length === 0 ? (
          <Empty
            title={hosts.list.skipped > 0 ? "No machines available to show" : "No machines connected yet"}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={HOSTS_PATH}>{admin && hosts.list.skipped === 0 ? "Manage machines" : "View machines"}</Link>
              </Button>
            }
          >
            {hosts.list.skipped > 0
              ? "Open Self-hosted to check your machines before setting up another."
              : admin
                ? "Open machine management to connect a Linux machine running Docker."
                : "Ask an organization admin to connect a Linux machine running Docker."}
          </Empty>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Self-hosted machines">
            {machines.map((host) => {
              const name = host.name ?? "Unnamed machine";
              return (
                <li key={host.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
                    <ProviderMark provider="docker" />
                    <span className="min-w-0 max-w-full break-words">{name}</span>
                    <ToneBadge tone={host.state === "online" ? "success" : "warning"}>
                      {host.state === "online" ? "Online" : "Offline"}
                    </ToneBadge>
                  </p>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`${HOSTS_PATH}?item=${host.id}`} aria-label={`View ${name}`}>
                      View machine
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
