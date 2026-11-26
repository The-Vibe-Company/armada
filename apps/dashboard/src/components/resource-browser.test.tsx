import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ResourceBrowser } from "./resource-browser";

test("column-based resources render a desktop table, mobile list items, and page description", () => {
  const html = renderToString(
    <ResourceBrowser
      title="Variables"
      description="Manage variables"
      label="Variables and secrets"
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

  expect(html).toContain("Manage variables");
  expect(html).toMatch(/<table[^>]*aria-label="Variables and secrets"[^>]*md:table/);
  expect(html).toMatch(/<th[^>]*scope="col"[^>]*>Kind<\/th>/);
  expect(html).toMatch(/<ul[^>]*aria-label="Variables and secrets"[^>]*md:hidden[^>]*><li/);
  expect(html.slice(html.indexOf("<li"))).toContain('href="?scope=org&amp;item=region"');
  expect(html).toContain(">Variable</dd>");
});

test("filtered resource browsers preserve their page header description", () => {
  const html = renderToString(
    <ResourceBrowser
      title="Tools (MCP servers)"
      description="External MCP servers your agents can call inside sandboxes."
      label="Tools"
      variant="grid"
      filters={[{ key: "connected", label: "Connected" }]}
      rows={[]}
      blockers={[]}
      empty={null}
      initial={null}
    />,
  );

  expect(html).toContain("External MCP servers your agents can call inside sandboxes.");
});
