import type { Credential } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

/** Everything but `value_enc`: a user JWT cannot read the ciphertext, and the dashboard never asks. */
export type CredentialRow = Pick<Credential, "id" | "scope" | "owner_id" | "kind" | "created_at">;

export async function listCredentials(supabase: Supabase): Promise<CredentialRow[]> {
  const { data, error } = await supabase
    .from("credentials")
    .select("id, scope, owner_id, kind, created_at")
    .order("created_at");
  if (error) throw new Error(error.message);
  const selected = await selectedOrganization();
  const viewer = await requireViewer();
  return data.filter((row) => (row.scope === "user" ? row.owner_id === viewer.id : row.owner_id === selected?.org.id));
}
