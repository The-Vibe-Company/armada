"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { isSelectedOrganization, SELECTED_ORG_COOKIE } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export async function createOrg(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const name = formString(data, "name").trim();
  if (!name) return fail("Give the org a name.");
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("create_org", { org_name: name });
  if (error) return fail(explainDbError(error));
  (await cookies()).set(SELECTED_ORG_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 31536000,
  });
  revalidatePath("/", "layout");
  // A new organization has no sandbox provider: connecting one in Settings is the next step.
  redirect(PROVIDER_SETTINGS_PATH);
}

export async function addMember(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const org = formString(data, "org");
  const email = formString(data, "email").trim();
  const role = formString(data, "role");
  if (!isUuid(org) || (role !== "admin" && role !== "member")) return fail("That request is not valid.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter the email address of their account.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_org_member", { target_org: org, member_email: email, member_role: role });
  if (error) return fail(explainDbError(error));
  revalidatePath(`/orgs/${org}`);
  return done(`${email} is now ${role === "admin" ? "an admin" : "a member"}.`);
}

export async function changeMemberRole(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const org = formString(data, "org");
  const user = formString(data, "user");
  const role = formString(data, "role");
  if (!isUuid(org) || !isUuid(user) || (role !== "admin" && role !== "member"))
    return fail("That request is not valid.");
  const supabase = await createClient();
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const { data: rows, error } = await supabase
    .from("members")
    .update({ role })
    .eq("org_id", org)
    .eq("user_id", user)
    .select("user_id");
  if (error) return fail(explainDbError(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath(`/orgs/${org}`);
  return done("Role updated.");
}

export async function removeMember(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const org = formString(data, "org");
  const user = formString(data, "user");
  if (!isUuid(org) || !isUuid(user)) return fail("That request is not valid.");
  const supabase = await createClient();
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const { data: rows, error } = await supabase
    .from("members")
    .delete()
    .eq("org_id", org)
    .eq("user_id", user)
    .select("user_id");
  if (error) return fail(explainDbError(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath(`/orgs/${org}`);
  return done("Member removed.");
}
