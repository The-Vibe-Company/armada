import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addMember, changeMemberRole, removeMember } from "@/app/actions/orgs";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/action";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Organization" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function OrgPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
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

  return (
    <>
      <PageHeader title={membership.org.name} description={`You are ${isAdmin ? "an admin" : "a member"} of this org.`}>
        <Button variant="outline" asChild>
          <Link href="/credentials">Org keys</Link>
        </Button>
      </PageHeader>

      <section className="space-y-3" aria-label="Members">
        <h2 className="text-lg font-medium">Members</h2>
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

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Add a member</CardTitle>
            <CardDescription>
              By the email of their Armada account. They sign in once first (the sign-in page creates the account).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={addMember} resetOnSuccess className="flex flex-col gap-3 sm:max-w-md">
              <input type="hidden" name="org" value={id} />
              <div className="space-y-2">
                <Label htmlFor="member-email">Email</Label>
                <Input id="member-email" name="email" type="email" required placeholder="teammate@company.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="member-role">Role</Label>
                <NativeSelect id="member-role" name="role" defaultValue="member">
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </NativeSelect>
              </div>
              <SubmitButton className="self-start">Add member</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
