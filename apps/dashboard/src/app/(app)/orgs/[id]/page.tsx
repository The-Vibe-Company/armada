import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { inviteMember, resendInvitation, revokeInvitation } from "@/app/actions/invitations";
import { changeMemberRole, removeMember } from "@/app/actions/orgs";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { InvitationList, InviteForm } from "@/components/invitations";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/action";
import { ControlError, createInvitationControl } from "@/lib/control";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer, type Viewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { type InvitationView, pendingInvitations } from "@/lib/invitations";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Organization" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type Invitations = { ok: true; rows: InvitationView[] } | { ok: false; message: string };

/** The org's pending invitations, read by the Armada server for an admin. A failed read leaves the page usable. */
async function readInvitations(viewer: Viewer, org: string, now: Date): Promise<Invitations> {
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token)
    return { ok: false, message: "The Armada server is not configured for this dashboard." };
  try {
    const list = await createInvitationControl({ serverUrl, token: viewer.token }).list(org);
    const rows = pendingInvitations(list, org, now);
    return rows ? { ok: true, rows } : { ok: false, message: "The Armada server sent an unexpected invitation list." };
  } catch (error) {
    if (error instanceof ControlError) return { ok: false, message: error.message };
    throw error;
  }
}

export default async function OrgPage({ params, searchParams }: Props) {
  const { id } = await params;
  const joined = (await searchParams).joined === "1";
  if (!isUuid(id)) notFound();
  if (!(await isSelectedOrganization(id))) redirect("/orgs");
  const viewer = await requireViewer();
  const supabase = await createClient();
  const [memberships, roster] = await Promise.all([
    listMemberships(supabase, viewer.id),
    supabase.rpc("org_members", { target_org: id }),
  ]);
  const membership = memberships.find((item) => item.org.id === id);
  if (!membership) notFound();
  const isAdmin = membership.role === "admin";
  if (roster.error) throw new Error(roster.error.message);
  const now = new Date();
  const invitations = isAdmin ? await readInvitations(viewer, id, now) : null;

  return (
    <>
      <PageHeader title={membership.org.name} description={isAdmin ? "Admin" : "Member"}>
        <Button variant="outline" asChild>
          <Link href={PROVIDER_SETTINGS_PATH}>Sandbox providers</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/credentials">Org credentials</Link>
        </Button>
      </PageHeader>

      {joined && (
        <p role="status" className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
          You joined {membership.org.name} as {membership.role === "admin" ? "an admin" : "a member"}.
        </p>
      )}

      {invitations && (
        <section className="space-y-3" aria-labelledby="invite-heading">
          <div>
            <h2 id="invite-heading" className="text-base font-semibold">
              Invite a teammate
            </h2>
            <p className="text-sm text-muted-foreground">
              They get an email link, sign in with that address and accept. They join only then.
            </p>
          </div>
          <InviteForm org={id} action={inviteMember} />
          <h3 className="pt-2 text-sm font-medium">Pending invitations</h3>
          {invitations.ok ? (
            <InvitationList
              org={id}
              invitations={invitations.rows}
              now={now}
              resend={resendInvitation}
              revoke={revokeInvitation}
            />
          ) : (
            <p role="alert" className="text-sm text-destructive">
              Pending invitations could not be loaded: {invitations.message}
            </p>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label="Members">
        <h2 className="text-base font-semibold">Members</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                {isAdmin && <TableHead className="text-right">Manage</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roster.data.map((member) => (
                <TableRow key={member.user_id} data-member={member.email}>
                  <TableCell>
                    {member.email}
                    {member.user_id === viewer.id && <span className="ml-2 text-xs text-muted-foreground">you</span>}
                  </TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <ActionForm action={changeMemberRole} className="flex items-center gap-2">
                        <input type="hidden" name="org" value={id} />
                        <input type="hidden" name="user" value={member.user_id} />
                        <NativeSelect
                          name="role"
                          defaultValue={member.role}
                          aria-label={`Role of ${member.email}`}
                          className="h-8 w-28"
                        >
                          <option value="admin">admin</option>
                          <option value="member">member</option>
                        </NativeSelect>
                        <SubmitButton variant="outline" size="sm">
                          Save
                        </SubmitButton>
                      </ActionForm>
                    ) : (
                      <Badge variant={member.role === "admin" ? "default" : "secondary"}>{member.role}</Badge>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <ActionForm action={removeMember} className="flex flex-col items-end gap-1">
                        <input type="hidden" name="org" value={id} />
                        <input type="hidden" name="user" value={member.user_id} />
                        <SubmitButton variant="ghost" size="sm" aria-label={`Remove ${member.email}`}>
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </>
  );
}
