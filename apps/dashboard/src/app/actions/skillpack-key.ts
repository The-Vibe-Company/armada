"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerSkillpackKey } from "@/lib/data/skillpack-key";
import { checkSkillpackKey, SKILLS_PATH, type SkillpackScope } from "@/lib/skillpack-key";

/**
 * The Skills page's writes (#957), one control API call each as the signed-in viewer. The pasted key goes to the
 * server once and is never returned, logged or put in a message; the server checks the organization admin role.
 */
type Context = {
  control: NonNullable<Awaited<ReturnType<typeof viewerSkillpackKey>>>;
  scope: SkillpackScope;
  org: string;
};

async function scoped(data: FormData): Promise<Context | ActionResult> {
  const scope = formString(data, "scope");
  if (scope !== "user" && scope !== "org") return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (!selected) return fail("Create an organization first.");
  if (formString(data, "org") !== selected.org.id) return fail("Switch to that organization first.");
  if (scope === "org" && selected.role !== "admin") return fail("Only an organization admin changes its key.");
  const control = await viewerSkillpackKey();
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  return { control, scope, org: selected.org.id };
}

async function guarded(data: FormData, run: (context: Context) => Promise<ActionResult>): Promise<ActionResult> {
  const context = await scoped(data);
  if ("ok" in context) return context;
  try {
    const result = await run(context);
    revalidatePath(SKILLS_PATH);
    return result;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(error.message);
  }
}

/** Stores the key for the scope, replacing the one stored there. */
export async function saveSkillpackKey(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const checked = checkSkillpackKey(data.get("value"));
  if (!checked.ok) return fail(checked.error);
  return guarded(data, async ({ control, scope, org }) => {
    await control.set({ scope, org, value: checked.value });
    return done(
      `${scope === "user" ? "Your" : "The organization's"} Skillpack key is stored. It cannot be shown again.`,
    );
  });
}

export async function removeSkillpackKey(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(data, async ({ control, scope, org }) => {
    await control.remove({ scope, org });
    return done(`${scope === "user" ? "Your" : "The organization's"} Skillpack key is removed.`);
  });
}
