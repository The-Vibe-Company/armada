import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ResourceBrowser } from "./resource-browser";

test("column-based resources share a semantic table and a responsive card layout", () => {
  const html = renderToString(
    <ResourceBrowser
      title="Variables"
      description="Manage variables"
      label="Settings and secrets"
      variant="table"
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

  expect(html).toMatch(/<table[^>]*aria-label="Settings and secrets"/);
  expect(html).toMatch(/<th[^>]*scope="col"[^>]*>Kind<\/th>/);
  expect(html).toMatch(/<tr[^>]*class="[^"]*grid[^"]*md:table-row[^"]*"/);
  expect(html).toContain('href="?scope=org&amp;item=region"');
  expect(html).toContain(">REGION</span>");
  expect(html).toContain(">Variable</div>");
});
