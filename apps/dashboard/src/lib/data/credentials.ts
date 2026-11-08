import type { Credential } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";

/** Everything but `value_enc`: a user JWT cannot read the ciphertext, and the dashboard never asks. */
export type CredentialRow = Pick<Credential, "id" | "scope" | "owner_id" | "kind" | "created_at">;

export async function listCredentials(supabase: Supabase): Promise<CredentialRow[]> {
  const { data, error } = await supabase
    .from("credentials")
    .select("id, scope, owner_id, kind, created_at")
    .order("created_at");
  if (error) throw new Error(error.message);
  return data;
}
