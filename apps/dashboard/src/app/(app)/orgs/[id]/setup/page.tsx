import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isUuid } from "@/lib/action";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sandbox providers" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * The earlier provider setup address (#576), kept for links and bookmarks. Sandbox providers are connected in Settings
 * for the active organization (#598): this page opens them there, offering the switch first when the link names
 * another organization of the viewer's, and is not found for any other.
 */
export default async function ProviderSetupPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireViewer();
  const membership = (await listMemberships(await createClient(), viewer.id)).find((item) => item.org.id === id);
  if (!membership) notFound();
  if (await isSelectedOrganization(id)) redirect(PROVIDER_SETTINGS_PATH);
  const { org } = membership;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={`Sandbox providers for ${org.name}`}>
        <Button variant="outline" asChild>
          <Link href={`/orgs/${org.id}`}>Members</Link>
        </Button>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{org.name} is not your active organization</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={switchOrganization}>
            <input type="hidden" name="org" value={org.id} />
            <input type="hidden" name="section" value="settings" />
            <SubmitButton>Switch to {org.name}</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
