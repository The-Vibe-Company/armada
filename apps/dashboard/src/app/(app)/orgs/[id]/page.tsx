import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { inviteMember, resendInvitation, revokeInvitation } from "@/app/actions/invitations";
import { InvitationList, InviteForm } from "@/components/invitations";
import { MemberRoleForm, RemoveMember } from "@/components/member-controls";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/action";
import { ControlError, createInvitationControl } from "@/lib/control";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer, type Viewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { type InvitationView, pendingInvitations } from "@/lib/invitations";
import { initialOf } from "@/lib/members";
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
              Armada emails them a link to this invitation. They sign in with that address, review the organization and
              join only if they accept.
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

      <section className="space-y-3" aria-labelledby="members-heading">
        <SectionHeader
          id="members-heading"
          title="Members"
          description={isAdmin ? "Admins manage members, org goldens and providers." : "Only an admin changes members."}
        >
          <span className="text-sm text-muted-foreground tabular-nums">
            {roster.data.length} {roster.data.length === 1 ? "member" : "members"}
          </span>
        </SectionHeader>
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Member</TableHead>
                <TableHead>Role</TableHead>
                {isAdmin && (
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Manage</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roster.data.map((member) => {
                const self = member.user_id === viewer.id;
                const role = member.role === "admin" ? "admin" : "member";
                return (
                  <TableRow key={member.user_id} data-member={member.email} className="hover:bg-muted/30">
                    <TableCell className="pl-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium text-muted-foreground"
                        >
                          {initialOf(member.email)}
                        </span>
                        <span className="min-w-0 truncate font-medium">{member.email}</span>
                        {self && (
                          <Badge variant="secondary" className="shrink-0">
                            you
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="align-top sm:align-middle">
                      {isAdmin ? (
                        <MemberRoleForm
                          org={id}
                          orgName={membership.org.name}
                          user={member.user_id}
                          email={member.email}
                          role={role}
                          self={self}
                        />
                      ) : (
                        <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="pr-4 text-right">
                        <RemoveMember
                          org={id}
                          orgName={membership.org.name}
                          user={member.user_id}
                          email={member.email}
                          self={self}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>
    </>
  );
}
