"use server";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { waitRequest } from "./request";
export async function answerWait(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = formString(data, "org"),
    id = formString(data, "id"),
    choice = formString(data, "choice");
  if (!isUuid(org) || !isUuid(id) || !choice || choice.length > 100)
    return fail("Choose one of the available answers.");
  try {
    await waitRequest(org, `/${id}`, { choice });
  } catch {
    return fail("This answer could not be saved. Refresh to check whether the question has changed.");
  }
  revalidatePath("/otto/your-turn");
  revalidatePath("/otto/objectives", "layout");
  return done("Answer saved.");
}
