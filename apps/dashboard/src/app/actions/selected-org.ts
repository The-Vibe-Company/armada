"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type ActionResult, fail, formString } from "@/lib/action";
import { SELECTED_ORG_COOKIE } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { providerSetupPath } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

export async function switchOrganization(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const memberships = await listMemberships(await createClient(), viewer.id);
  const id = formString(data, "org");
  if (!memberships.some((item) => item.org.id === id))
    return fail("That organization is no longer available. Reload and try again.");
  (await cookies()).set(SELECTED_ORG_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  const section = formString(data, "section");
  const destination =
    section === "setup"
      ? providerSetupPath(id)
      : section === "orgs"
        ? `/orgs/${id}`
        : section === "goldens"
          ? "/goldens"
          : section === "credentials"
            ? "/credentials"
            : section === "connections"
              ? "/connections"
              : section === "settings"
                ? "/settings"
                : "/sandboxes";
  revalidatePath("/", "layout");
  redirect(destination);
}
