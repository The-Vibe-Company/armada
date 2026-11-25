import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ResourceBrowser } from "./resource-browser";

test("column-based resources render a desktop table and selectable mobile cards", () => {
  const html = renderToString(
    <ResourceBrowser
      title="Variables"
      description="Manage variables"
      label="Settings and secrets"
      columns={["Name", "Kind"]}
      rows={[
        {
          key: "region",
          name: "REGION",
          search: "REGION",
          meta: "Organization",
          state: "Available",
          columns: [{ key: "kind", content: "Variable" }],
          detail: null,
        },
      ]}
      blockers={[]}
      empty={null}
      initial={null}
      selectionQuery="scope=org"
    />,
  );

  expect(html).toMatch(/<div class="hidden [^"]*md:block"><table[^>]*aria-label="Settings and secrets"/);
  expect(html).toMatch(/<ul aria-label="Settings and secrets" class="[^"]*md:hidden[^"]*"><li/);
  const card = html.slice(html.indexOf("<li"), html.indexOf("</li>"));
  expect(card).toContain('href="?scope=org&amp;item=region"');
  expect(card).toContain(">REGION</span>");
  expect(card).toContain(">Available</div>");
});
