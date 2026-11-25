import { expect, test } from "bun:test";

test("launch pins reject installed-slug collisions, floating private versions and reserved tool references", async () => {
  const { validateSkillPins } = await import("../src/skillpack.ts");
  for (const skills of [
    ["notes@1.0.0", "example/notes@2.0.0"],
    ["one@1.0.0", "two@1.0.0", "one@2.0.0"],
    ["notes@latest"],
    ["armada-tools@1.0.0"],
  ])
    expect(() => validateSkillPins(skills)).toThrow();
});
