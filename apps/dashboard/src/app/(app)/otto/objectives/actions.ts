"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { objectiveRequest } from "@/lib/data/otto-objectives";

export async function createObjective(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = formString(data, "org"),
    repository = formString(data, "repository"),
    request = formString(data, "request");
  if (!isUuid(org) || !repository || !request.trim() || request.length > 20000)
    return fail("Choose a repository and enter a request of at most 20,000 characters.");
  let id: string;
  try {
    const result = await objectiveRequest<{ objective: { id: string } }>(org, "", { repository, request });
    id = result.objective.id;
  } catch {
    return fail("The objective could not be saved. Check repository access and try again.");
  }
  revalidatePath("/otto/objectives");
  redirect(`/otto/objectives/${id}`);
}

export async function addObjectiveMessage(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = formString(data, "org"),
    id = formString(data, "id"),
    body = formString(data, "body");
  if (!isUuid(org) || !isUuid(id) || !body.trim() || body.length > 20000)
    return fail("Enter a message of at most 20,000 characters.");
  try {
    await objectiveRequest(org, `/${id}`, { body });
  } catch {
    return fail("The message could not be saved. Check your organization and try again.");
  }
  revalidatePath(`/otto/objectives/${id}`);
  return done("Message saved.");
}
