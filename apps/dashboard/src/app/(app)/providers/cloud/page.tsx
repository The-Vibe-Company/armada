import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ProviderConnection, type ProviderRowState } from "@/components/provider-connection";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ProviderSetup, readProviderSetup } from "@/lib/data/provider-setup";
import { selectedOrganization } from "@/lib/data/selected-org";
import type { Membership } from "@/lib/data/viewer";
import { CLOUD_PROVIDERS_PATH, isConfigured, SETUP_PROVIDERS } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Cloud" };
export const dynamic = "force-dynamic";

const DESCRIPTION = "Your Boat and Modal accounts: sandboxes run on them. Each organization connects its own.";

/**
 * Cloud sandbox providers (#1474, moved out of Settings): the active organization's Boat and Modal accounts, which an
 * admin connects, replaces and disconnects, and a member sees the status of. The self-hosted machines live on the
 * Hosts page; a viewer's personal provider keys stay in Settings.
 */
export default async function CloudProvidersPage() {
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const [setup, admins] = await Promise.all([
    selected ? readProviderSetup(selected.org.id) : null,
    // A member is told whom to ask; an admin manages the providers here.
    selected && selected.role !== "admin"
      ? supabase
          .rpc("org_members", { target_org: selected.org.id })
          .then(({ data }) => (data ?? []).filter((member) => member.role === "admin").map((member) => member.email))
      : [],
  ]);
  return (
    <>
      <PageHeader title="Cloud" description={DESCRIPTION} />
      <SandboxProviders selected={selected} setup={setup} admins={admins} />
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
          {selected ? `Sandbox providers for ${selected.org.name}` : "Sandbox providers"}
        </CardTitle>
        {selected && !isAdmin && <CardDescription>Only an admin changes them.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {!selected || !setup ? (
          <p className="text-sm text-muted-foreground">
            <Link className="font-medium text-foreground underline underline-offset-4" href="/orgs">
              Create or join an organization
            </Link>{" "}
            to connect a provider.
          </p>
        ) : (
          <>
            {setup.state === "unavailable" && (
              <Alert variant="destructive" data-setup-state="unavailable">
                <TriangleAlertIcon />
                <AlertTitle>Provider status unavailable</AlertTitle>
                <AlertDescription>
                  <p>{setup.message}</p>
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
            <ul className="divide-y rounded-lg border" data-setup-state={setup.state}>
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
