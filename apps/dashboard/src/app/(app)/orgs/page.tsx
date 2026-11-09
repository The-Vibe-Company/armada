import { ChevronRightIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createOrg } from "@/app/actions/orgs";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Organizations" };
export const dynamic = "force-dynamic";

export default async function OrgsPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const selected = await selectedOrganization();
  const memberships = await listMemberships(supabase, viewer.id);

  return (
    <>
      <PageHeader title="Organizations" />

      {memberships.length === 0 ? (
        <Empty title="You are not in an org yet">Create one below, or ask an admin to add your email.</Empty>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Your orgs">
          {memberships.map(({ org, role }) => (
            <li key={org.id}>
              {selected?.org.id !== org.id ? (
                <ActionForm action={switchOrganization} className="flex items-center justify-between gap-3 p-4">
                  <input type="hidden" name="org" value={org.id} />
                  <input type="hidden" name="section" value="orgs" />
                  <SubmitButton variant="ghost">Switch to {org.name}</SubmitButton>
                  <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>
                </ActionForm>
              ) : (
                <Link
                  href={`/orgs/${org.id}`}
                  className="flex items-center justify-between gap-3 p-4 hover:bg-accent/50"
                >
                  <span className="font-medium">{org.name}</span>
                  <span className="flex items-center gap-2">
                    <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>
                    <LinkPendingIcon className="text-muted-foreground">
                      <ChevronRightIcon />
                    </LinkPendingIcon>
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create an org</CardTitle>
          <CardDescription>You become its first admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createOrg} className="flex flex-col gap-3 sm:max-w-md">
            <div className="space-y-2">
              <Label htmlFor="org-name">Name</Label>
              <Input id="org-name" name="name" maxLength={120} required placeholder="The Vibe Company" />
            </div>
            <SubmitButton className="self-start">Create org</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
