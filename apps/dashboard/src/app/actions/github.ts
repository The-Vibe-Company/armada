"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail } from "@/lib/action";
import { ControlError, createControlClient } from "@/lib/control";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";

/** Forgets the connection. Revoke the authorization in GitHub's settings too to invalidate tokens already issued. */
export async function disconnectGitHub(): Promise<ActionResult> {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  const control = createControlClient({ serverUrl, token: viewer.token });
  try {
    await control.post("github/disconnect", {});
  } catch (error) {
    if (error instanceof ControlError) return fail(error.message);
    throw error;
  }
  revalidatePath("/settings");
  return done("GitHub disconnected.");
}
