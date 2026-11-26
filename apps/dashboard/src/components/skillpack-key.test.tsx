import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { SkillpackKeyView } from "./skillpack-key";

test("forwards the page description, surfaces the public-skills note, and omits filter/search clutter", () => {
  const html = renderToString(
    <SkillpackKeyView
      title="Skills"
      description="Instruction packs an agent loads from Skillpack."
      orgId="org-1"
      orgName="Acme"
      isAdmin
      keys={{ user: null, org: null }}
    />,
  );

  expect(html).toContain("Instruction packs an agent loads from Skillpack.");
  expect(html).toContain("Public skills work automatically.");
  expect(html).not.toContain("Filter Skillpack keys");
  expect(html).not.toContain("Search Skillpack keys");
});
