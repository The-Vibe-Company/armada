"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

export async function setGoldenVisibility(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const golden = formString(data, "golden");
  const visibility = formString(data, "visibility");
  if (!isUuid(golden) || (visibility !== "org" && visibility !== "private")) return fail("That request is not valid.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_golden_visibility", { target_golden: golden, new_visibility: visibility });
  if (error) return fail(explainDbError(error));
  revalidatePath("/goldens");
  return done(visibility === "org" ? "Shared with the org." : "Now private to you.");
}
