import { SKILL_PIN_PATTERN } from "@armada/core";

export const SKILL_PIN_HINT = "Use org/skill@1.2.3 for public skills or skill@1.2.3 for workspace skills.";

/** Browser feedback only; launch admission validates the same pins again on the server. */
export function skillPinProblem(pins: readonly string[]): string | null {
  if (pins.length > 20) return "Choose at most 20 additional skills.";
  const slugs = new Set<string>();
  for (const pin of pins) {
    if (pin.length > 256 || !SKILL_PIN_PATTERN.test(pin)) return SKILL_PIN_HINT;
    const slug = pin.split("@")[0]?.split("/").at(-1);
    if (!slug || slug === "armada-tools") return "Armada's tools are managed automatically. Choose another skill.";
    if (slugs.has(slug)) return "Choose only one version of each skill, including public and workspace copies.";
    slugs.add(slug);
  }
  return null;
}

export interface InstalledSkill {
  reference: string;
  version: string;
  visibility: "public" | "private";
  checksum: string | null;
  origin: string | null;
}

/** Stored receipts are JSON, not trusted component props. Project only the recorded installation facts. */
export function installedSkills(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) return [];
  const skills: InstalledSkill[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.reference !== "string" || skillPinProblem([row.reference])) continue;
    const [reference, version] = row.reference.split("@");
    if (!reference || !version || row.version !== version || seen.has(reference)) continue;
    seen.add(reference);
    skills.push({
      reference,
      version,
      visibility: reference.includes("/") ? "public" : "private",
      checksum: typeof row.checksum === "string" && /^sha256:[a-f0-9]{64}$/.test(row.checksum) ? row.checksum : null,
      origin: row.origin === "https://skillpack.app/v1" ? row.origin : null,
    });
  }
  return skills;
}
