import { expect, test } from "bun:test";
import { parseSkillDefaults, parseSkillDefaultsTarget } from "../src/lib/skill-defaults.ts";

const org = "00000000-0000-4000-8000-000000000010";
const goldenId = "00000000-0000-4000-8000-000000000020";

test("defaults targets bind the chosen scope to exactly one organization and optional golden", () => {
  expect(parseSkillDefaultsTarget({ org, scope: "personal" })).toEqual({ org, scope: "personal" });
  expect(parseSkillDefaultsTarget({ org, scope: "org" })).toEqual({ org, scope: "org" });
  expect(parseSkillDefaultsTarget({ org, scope: "golden", goldenId })).toEqual({ org, scope: "golden", goldenId });
  for (const value of [
    null,
    {},
    { org: "not-an-id", scope: "org" },
    { org, scope: "user" },
    { org, scope: "golden" },
    { org, scope: "personal", goldenId },
    { org, scope: "org", skills: [] },
  ]) {
    expect(parseSkillDefaultsTarget(value)).toBeNull();
  }
});

test("defaults JSON distinguishes an intentionally cleared record from unreadable or invalid pins", () => {
  expect(parseSkillDefaults({ skills: [] })).toEqual([]);
  expect(parseSkillDefaults({ skills: ["team/testing@1.2.3", "review-code@2.1.0"], hidden: "not returned" })).toEqual([
    "team/testing@1.2.3",
    "review-code@2.1.0",
  ]);
  for (const value of [
    null,
    [],
    {},
    { skills: null },
    { skills: "review-code@2.1.0" },
    { skills: ["review-code@latest"] },
    { skills: ["team/armada-tools@1.0.0"] },
    { skills: ["review-code@2.1.0", "team/review-code@2.0.0"] },
    { skills: Array.from({ length: 21 }, (_, index) => `skill-${index}@1.0.0`) },
  ]) {
    expect(parseSkillDefaults(value)).toBeNull();
  }
});
