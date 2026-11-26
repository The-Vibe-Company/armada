import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { SkillpackKeyView } from "./skillpack-key";

test("forwards the page description into the Skills page header", () => {
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
});
