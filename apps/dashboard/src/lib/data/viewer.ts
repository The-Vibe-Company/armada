import type { MemberRole, Org } from "@armada/core";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient, type Supabase } from "@/lib/supabase/server";

export type Viewer = {
  id: string;
  email: string;
  token: string | null;
};

export type Membership = { org: Pick<Org, "id" | "name" | "created_at">; role: MemberRole };

/** The signed-in user, verified with the Auth server. Sends a signed-out visitor to the login page. */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  const session = await supabase.auth.getSession();
  return {
    id: data.user.id,
    email: data.user.email ?? "",
    token: session.data.session?.access_token ?? null,
  };
});

export async function listMemberships(supabase: Supabase, userId: string): Promise<Membership[]> {
  const [orgs, members] = await Promise.all([
    supabase.from("orgs").select("id, name, created_at").order("name"),
    supabase.from("members").select("org_id, role").eq("user_id", userId),
  ]);
  if (orgs.error) throw new Error(orgs.error.message);
  if (members.error) throw new Error(members.error.message);
  const roles = new Map(members.data.map((row) => [row.org_id, row.role]));
  return orgs.data.flatMap((org) => {
    const role = roles.get(org.id);
    return role ? [{ org, role }] : [];
  });
}

/** user id -> email, for everyone who shares an org with the viewer. */
export async function memberDirectory(supabase: Supabase, orgIds: string[]): Promise<Map<string, string>> {
  const rosters = await Promise.all(orgIds.map((id) => supabase.rpc("org_members", { target_org: id })));
  const directory = new Map<string, string>();
  for (const roster of rosters) {
    for (const member of roster.data ?? []) directory.set(member.user_id, member.email);
  }
  return directory;
}

export function displayUser(directory: Map<string, string>, userId: string, viewerId: string): string {
  if (userId === viewerId) return "You";
  return directory.get(userId) ?? `${userId.slice(0, 8)}…`;
}
