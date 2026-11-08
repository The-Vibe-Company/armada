import type { GitHubConnection } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";

/** Everything but the refresh token: a user JWT cannot read the ciphertext, and the dashboard never asks. */
export type GitHubConnectionRow = Pick<
  GitHubConnection,
  | "user_id"
  | "github_id"
  | "login"
  | "name"
  | "installation_id"
  | "refresh_expires_at"
  | "revoked_at"
  | "created_at"
  | "updated_at"
>;

export async function getGitHubConnection(supabase: Supabase): Promise<GitHubConnectionRow | null> {
  const { data, error } = await supabase
    .from("github_connections")
    .select("user_id, github_id, login, name, installation_id, refresh_expires_at, revoked_at, created_at, updated_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
