import { expect, test } from "bun:test";
import { extractInShort, LINT_DEFAULTS, lintTicket } from "../src/lint.ts";

const description = `## In short
* **What changes:** People can search images.
* **Why:** Finding an image takes too long.
* **Done when:** Results appear after a search.
* **Depends on:** nothing.
---
## Technical detail
More detail.
`;
const check = (title: string, text = description, isSpec = false) =>
  lintTicket({ title, description: text, isSpec }, LINT_DEFAULTS);

test("readable tickets and both spec formats pass; only the spec name counts toward the limit", () => {
  expect(check("Search images")).toEqual([]);
  expect(check(`Spec 2 — ${"a".repeat(60)}`, description, true)).toEqual([]);
  expect(check(`Spec 2/11 — ${"a".repeat(60)}`, description, true)).toEqual([]);
  expect(check("Écran de recherche")).toEqual([]);
  expect(check("Search images", description.replaceAll(/\* \*\*([^:]+):\*\*/g, "### $1\n"))).toEqual([]);
  expect(check("Search images (optional)")).toEqual([]);
  expect(check("Sign in with OAuth and GitHub")).toEqual([]);
  expect(check("Search images", description.replaceAll(":**", ".**"))).toEqual([]);
});

test("reports missing section and each missing part with an actionable fix and chosen severity", () => {
  expect(check("Search images", "## Detail\nWhat changes: here")).toMatchObject([
    { code: "in-short", severity: "warning", fix: expect.stringContaining("## In short") },
  ]);
  const problems = check("Search images", "## In short\nA summary\n## Detail\nWhy: outside");
  expect(problems.map((p) => p.code)).toEqual(Array(4).fill("in-short-part"));
  expect(problems.map((p) => p.fix).join(" ")).toContain("Depends on");
  expect(
    lintTicket({ title: "Search images", description: "", isSpec: false }, { ...LINT_DEFAULTS, severity: "error" })[0]
      ?.severity,
  ).toBe("error");
});

test("extracts the configured section and ignores headings and parts in fenced examples", () => {
  expect(extractInShort(description)).toContain("What changes");
  expect(extractInShort(description)).not.toContain("Technical detail");
  expect(extractInShort("```md\n## In short\nExample\n```\n## Detail\nText")).toBeNull();
  expect(check("Search images", "## In short\n```\nWhy: example\n```")).toHaveLength(4);
  const custom = { ...LINT_DEFAULTS, inShort: "## Résumé", inShortParts: ["Pourquoi"] };
  expect(
    lintTicket({ title: "Chercher des images", description: "## Résumé\n**Pourquoi.** Utile.", isSpec: false }, custom),
  ).toEqual([]);
  expect(extractInShort("## In short\r\nText\r\n# Next\r\nOther")).toBe("Text");
});

test("flags code tokens in titles, overlong names and malformed spec numbering", () => {
  for (const title of [
    "Change `state`",
    "Change src/state",
    "Change /state",
    "Change state.ts",
    "Change loadState",
    "Change load_state",
    "Change STATE_NAME",
    "Change load()",
    "Change read(options)",
  ])
    expect(check(title).some((p) => p.code === "title-code")).toBe(true);
  expect(check("a".repeat(61))[0]?.code).toBe("title-length");
  for (const title of [
    "Spec — Search images",
    "Spec 0 — Search images",
    "Spec 2/0 — Search images",
    "Spec 2 — ",
    "Search images",
  ])
    expect(check(title, description, true).some((p) => p.code === "spec-title")).toBe(true);
});
