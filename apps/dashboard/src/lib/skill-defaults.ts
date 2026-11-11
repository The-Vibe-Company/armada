import { validateSkillPins } from "@armada/core";
import { isUuid } from "./action.ts";

export type SkillDefaultsTarget =
  | { org: string; scope: "personal" | "org" }
  | { org: string; scope: "golden"; goldenId: string };

/** Closed targets prevent a displayed scope from silently selecting a different defaults record. */
export function parseSkillDefaultsTarget(value: unknown): SkillDefaultsTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isUuid(row.org)) return null;
  if (row.scope === "golden") {
    if (!isUuid(row.goldenId) || Object.keys(row).some((key) => !["org", "scope", "goldenId"].includes(key)))
      return null;
    return { org: row.org, scope: "golden", goldenId: row.goldenId };
  }
  if (
    (row.scope !== "personal" && row.scope !== "org") ||
    Object.keys(row).some((key) => !["org", "scope"].includes(key))
  )
    return null;
  return { org: row.org, scope: row.scope };
}

/** Empty is a real cleared record; unreadable answers must never be mistaken for empty defaults. */
export function parseSkillDefaults(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const skills = (value as Record<string, unknown>).skills;
  try {
    validateSkillPins(skills);
    return [...skills];
  } catch {
    return null;
  }
}
