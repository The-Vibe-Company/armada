import {
  SKILL_PIN_PATTERN,
  type SkillCatalogItem,
  type SkillCatalogPage,
  type SkillCatalogSource,
  validateSkillPins,
} from "@armada/core";

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

function catalogReference(value: unknown, source: SkillCatalogSource): value is string {
  if (
    (source !== "public" && source !== "private") ||
    typeof value !== "string" ||
    value.includes("/") !== (source === "public") ||
    value.split("/").some((part) => part.length > 128)
  )
    return false;
  try {
    validateSkillPins([`${value}@1.0.0`]);
    return true;
  } catch {
    return false;
  }
}

function exactVersions(value: unknown, reference: string): string[] | null {
  if (!Array.isArray(value)) return null;
  for (const version of value) {
    if (typeof version !== "string" || version.length > 128) return null;
    try {
      validateSkillPins([`${reference}@${version}`]);
    } catch {
      return null;
    }
  }
  return [...new Set(value as string[])];
}

/** A control answer is runtime JSON, not a trustworthy TypeScript cast. Strip all non-picker metadata. */
export function parseSkillCatalogPage(
  value: unknown,
  source: SkillCatalogSource,
  offset: number,
): SkillCatalogPage | null {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.items) || row.items.length > 50) return null;
  const nextOffset = row.nextOffset;
  if (
    nextOffset !== null &&
    (typeof nextOffset !== "number" || !Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > 10_000)
  )
    return null;
  const items: SkillCatalogItem[] = [];
  for (const value of row.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      !catalogReference(item.reference, source) ||
      item.visibility !== source ||
      typeof item.name !== "string" ||
      item.name.length < 1 ||
      item.name.length > 256 ||
      typeof item.description !== "string" ||
      item.description.length > 8192
    )
      return null;
    const versions = exactVersions(item.versions, item.reference);
    if (!versions?.length) return null;
    items.push({
      reference: item.reference,
      name: item.name,
      description: item.description,
      visibility: source,
      versions,
    });
  }
  return { items, nextOffset };
}

/** Version discovery must return exact installable pins for the reference being viewed. */
export function parseSkillVersions(value: unknown, source: SkillCatalogSource, reference: string): string[] | null {
  if (!catalogReference(reference, source) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  return exactVersions((value as Record<string, unknown>).versions, reference);
}
