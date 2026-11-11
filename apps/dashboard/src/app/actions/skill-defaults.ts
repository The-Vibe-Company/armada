"use server";

import { validateSkillPins } from "@armada/core";
import { revalidatePath } from "next/cache";
import { ControlError, createControlClient } from "@/lib/control";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { parseSkillDefaults, parseSkillDefaultsTarget, type SkillDefaultsTarget } from "@/lib/skill-defaults";

type Result = { ok: true; skills: string[] } | { ok: false; error: string };

async function client(target: SkillDefaultsTarget, write: boolean) {
  const viewer = await requireViewer();
  const selected = await selectedOrganization();
  if (selected?.org.id !== target.org) throw new ControlError("Switch to that organization first.");
  if (write && target.scope === "org" && selected.role !== "admin")
    throw new ControlError("Only an organization admin changes its default skills.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) throw new ControlError("The Armada server is not configured for this dashboard.");
  // Golden visibility/ownership and current membership are checked by the service, not trusted from UI props.
  return createControlClient({ serverUrl, token: viewer.token });
}

function failure(error: unknown): Result {
  if (!(error instanceof ControlError)) throw error;
  return { ok: false, error: error.message };
}

export async function readSkillDefaults(input: SkillDefaultsTarget): Promise<Result> {
  const target = parseSkillDefaultsTarget(input);
  if (!target) return { ok: false, error: "That skill defaults request is not valid." };
  try {
    const control = await client(target, false);
    const skills = parseSkillDefaults(await control.post<unknown>("skills/defaults/get", target));
    return skills
      ? { ok: true, skills }
      : { ok: false, error: "Default skills could not be read. Try again before editing." };
  } catch (error) {
    return failure(error);
  }
}

export async function saveSkillDefaults(input: SkillDefaultsTarget, pins: string[]): Promise<Result> {
  const target = parseSkillDefaultsTarget(input);
  if (!target) return { ok: false, error: "That skill defaults request is not valid." };
  try {
    validateSkillPins(pins);
  } catch {
    return {
      ok: false,
      error: "Choose at most 20 distinct skills pinned to exact versions. Armada tools are managed automatically.",
    };
  }
  try {
    const control = await client(target, true);
    const skills = parseSkillDefaults(await control.post<unknown>("skills/defaults/set", { ...target, skills: pins }));
    if (!skills) return { ok: false, error: "Default skills could not be confirmed. Reload before saving again." };
    revalidatePath("/skills");
    revalidatePath("/environments");
    return { ok: true, skills };
  } catch (error) {
    return failure(error);
  }
}
