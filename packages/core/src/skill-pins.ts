/** Exact, browser-safe launch skill pin policy shared by every surface. */
export const SKILL_PIN_PATTERN =
  /^(?:[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;

export function validateSkillPins(skills: unknown, publicOnly = false): asserts skills is string[] {
  if (
    !Array.isArray(skills) ||
    skills.length > 20 ||
    skills.some(
      (skill) =>
        typeof skill !== "string" ||
        (publicOnly && !skill.includes("/")) ||
        skill.length > 256 ||
        !SKILL_PIN_PATTERN.test(skill) ||
        skill.split("/").at(-1)?.startsWith("armada-tools@"),
    ) ||
    new Set(skills.map((skill) => skill.split("@")[0].split("/").at(-1))).size !== skills.length
  )
    throw new Error("Skills require distinct org/slug@exact-version or slug@exact-version pins (maximum 20).");
}
