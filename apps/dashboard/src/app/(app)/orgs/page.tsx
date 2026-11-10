import { ChevronRightIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createOrg } from "@/app/actions/orgs";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { initialOf } from "@/lib/members";
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
        <Empty icon={<UsersIcon />} title="You are not in an org yet">
          Create one below, or ask an admin to add your email.
        </Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs" aria-label="Your orgs">
          {memberships.map(({ org, role }) => {
            const current = selected?.org.id === org.id;
            const identity = (
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-xs font-semibold text-muted-foreground"
                >
                  {initialOf(org.name)}
                </span>
                <span className="min-w-0 truncate font-medium">{org.name}</span>
                {current && (
                  <ToneBadge tone="success" className="shrink-0">
                    Active
                  </ToneBadge>
                )}
              </span>
            );
            const roleBadge = <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>;
            return (
              <li key={org.id}>
                {!current ? (
                  <ActionForm action={switchOrganization} className="flex items-center justify-between gap-3 px-4 py-3">
                    <input type="hidden" name="org" value={org.id} />
                    <input type="hidden" name="section" value="orgs" />
                    {identity}
                    <span className="flex shrink-0 items-center gap-2">
                      {roleBadge}
                      <SubmitButton variant="outline" size="sm" aria-label={`Switch to ${org.name}`}>
                        Switch
                      </SubmitButton>
                    </span>
                  </ActionForm>
                ) : (
                  <Link
                    href={`/orgs/${org.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
                  >
                    {identity}
                    <span className="flex shrink-0 items-center gap-2">
                      {roleBadge}
                      <LinkPendingIcon className="text-muted-foreground">
                        <ChevronRightIcon />
                      </LinkPendingIcon>
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
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
