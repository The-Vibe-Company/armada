"use server";

import type { OttoInterview } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { ottoRequest } from "@/lib/otto-request";

export type InterviewView = {
  interview: OttoInterview | null;
  effects: { kind: string; state: string }[];
  goldens: { id: string; name: string; provider: string }[];
};
export async function interviewRequest(orgId: string, id: string, body?: unknown): Promise<InterviewView> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token || selected?.org.id !== orgId || !isUuid(id))
    throw Error("Interview access unavailable");
  const result = await ottoRequest({
    serverUrl,
    token: viewer.token,
    orgId,
    path: `interviews/${id}`,
    ...(body === undefined ? {} : { body }),
  });
  if (!result.response.ok) throw Error("Interview unavailable");
  return result.body as InterviewView;
}
export async function updateInterview(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  const org = formString(form, "org"),
    id = formString(form, "id"),
    action = formString(form, "action");
  if (!isUuid(org) || !isUuid(id)) return fail("Interview access unavailable.");
  const body = formString(form, "body");
  if (action === "answer" && (!body.trim() || body.length > 20000))
    return fail("Enter your numbered answers, or say “enough, go”.");
  try {
    await interviewRequest(org, id, {
      action,
      goldenId: formString(form, "goldenId"),
      revision: Number(formString(form, "revision")),
      body,
      enough: formString(form, "enough") === "yes",
    });
  } catch {
    revalidatePath(`/otto/objectives/${id}`);
    return fail(
      "Refresh to inspect saved state. Check Engine settings and snapshot access. Uncertain effects are not retried.",
    );
  }
  revalidatePath(`/otto/objectives/${id}`);
  return done("Saved. Refresh to see Otto’s next round; no workers are launched.");
}
