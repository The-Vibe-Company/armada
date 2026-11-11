"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail } from "@/lib/action";
import { requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

/** Forgets the connection. Revoke the authorization in GitHub's settings too to invalidate tokens already issued. */
export async function disconnectGitHub(): Promise<ActionResult> {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const { error } = await supabase.from("github_connections").delete().eq("user_id", viewer.id);
  if (error) return fail(explainDbError(error));
  console.info(
    JSON.stringify({
      event: "github_connection_disconnected",
      caller: "dashboard_disconnect",
      ownerId: viewer.id,
      reason: "user_disconnect",
    }),
  );
  revalidatePath("/settings");
  return done("GitHub disconnected.");
}
