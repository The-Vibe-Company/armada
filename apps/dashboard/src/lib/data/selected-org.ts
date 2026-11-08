import { cookies } from "next/headers";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { listMemberships, requireViewer } from "./viewer";

export const SELECTED_ORG_COOKIE = "armada-org";

/** A view preference validated against current memberships, never an authorization grant.
 * Returns null without memberships; stale/forged preferences fall back to the first org by name.
 * Launch integrations can use selected.org.id, but must still apply RLS/launch authorization.
 */
export const selectedOrganization = cache(async () => {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const memberships = await listMemberships(supabase, viewer.id);
  const preference = (await cookies()).get(SELECTED_ORG_COOKIE)?.value;
  return memberships.find((item) => item.org.id === preference) ?? memberships[0] ?? null;
});

export async function isSelectedOrganization(id: string): Promise<boolean> {
  return (await selectedOrganization())?.org.id === id;
}
