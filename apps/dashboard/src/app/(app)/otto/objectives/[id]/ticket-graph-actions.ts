"use server";
import { validateTicketGraph } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, isUuid } from "@/lib/action";
import { objectiveRequest } from "@/lib/data/otto-objectives";
export async function importTicketGraph(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const org = String(form.get("org") ?? ""),
    id = String(form.get("id") ?? "");
  if (!isUuid(org) || !isUuid(id)) return fail("Invalid objective.");
  try {
    const raw = String(form.get("graph") ?? "");
    if (raw.length > 100000) return fail("Ticket file is too large.");
    const graph = validateTicketGraph(JSON.parse(raw));
    await objectiveRequest(org, `/${id}/tickets`, graph);
    revalidatePath(`/otto/objectives/${id}`);
    return done("Ticket plan saved.");
  } catch {
    return fail("Unable to import: check the graph and revision, then try again.");
  }
}
