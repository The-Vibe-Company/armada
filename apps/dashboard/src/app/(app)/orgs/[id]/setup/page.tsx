import { CircleCheckIcon, HourglassIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { ProviderSetupForm } from "@/components/provider-setup-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isUuid } from "@/lib/action";
import { readProviderSetup } from "@/lib/data/provider-setup";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { providerSetupPath, SETUP_PROVIDER_INFO } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set up a sandbox provider" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * An organization's sandbox provider onboarding (#576). Its state is the server's (`org/provider/status`) on every
 * visit, so an interrupted setup resumes here and a removed org credential makes it pending again. An admin chooses
 * Boat or Modal and connects it; a member sees who can. Nothing here redirects away on its own, so no page can loop
 * back to it.
 */
export default async function ProviderSetupPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireViewer();
  const supabase = await createClient();
  const membership = (await listMemberships(supabase, viewer.id)).find((item) => item.org.id === id);
  if (!membership) notFound();
  const { org, role } = membership;

  const header = (
    <PageHeader title={`Sandbox provider for ${org.name}`}>
      <Button variant="outline" asChild>
        <Link href={`/orgs/${org.id}`}>Members</Link>
      </Button>
    </PageHeader>
  );

  // Writes are scoped to the selected organization; a deep link to another one offers the switch first.
  if (!(await isSelectedOrganization(id))) {
    return (
      <div className="max-w-2xl space-y-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle>{org.name} is not your active organization</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={switchOrganization}>
              <input type="hidden" name="org" value={org.id} />
              <input type="hidden" name="section" value="setup" />
              <SubmitButton>Switch to {org.name}</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    );
  }

  const setup = await readProviderSetup(id);

  if (setup.state === "unavailable") {
    return (
      <div className="max-w-2xl space-y-6">
        {header}
        <Alert variant="destructive" data-setup-state="unavailable">
          <TriangleAlertIcon />
          <AlertTitle>Provider status unavailable</AlertTitle>
          <AlertDescription>{setup.message}</AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link href={providerSetupPath(id)} prefetch={false}>
            <RotateCwIcon />
            Check again
          </Link>
        </Button>
      </div>
    );
  }

  if (setup.state === "ready") {
    const configured = setup.status.providers.filter((item) => item.configured);
    return (
      <div className="max-w-2xl space-y-6">
        {header}
        <Card data-setup-state="ready">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleCheckIcon className="size-5 text-success" aria-hidden />
              {configured.map((item) => SETUP_PROVIDER_INFO[item.provider].label).join(" and ")} connected
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/goldens">Create a golden</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/credentials">Credentials</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (role !== "admin") {
    const roster = await supabase.rpc("org_members", { target_org: id });
    const admins = (roster.data ?? []).filter((member) => member.role === "admin").map((member) => member.email);
    return (
      <div className="max-w-2xl space-y-6">
        {header}
        <Card data-setup-state="waiting">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HourglassIcon className="size-5 text-muted-foreground" aria-hidden />
              Waiting for an admin
            </CardTitle>
            <CardDescription>Only an admin connects a provider.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {admins.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Ask an admin</p>
                <ul className="space-y-1 text-sm">
                  {admins.map((email) => (
                    <li key={email}>
                      <a className="underline underline-offset-4" href={`mailto:${email}`}>
                        {email}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {header}
      <Card data-setup-state="pending">
        <CardContent>
          <ProviderSetupForm orgId={org.id} />
        </CardContent>
      </Card>
    </div>
  );
}
