import { expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceBrowser } from "../src/components/resource-browser";

test("server-decoded tag arrays render every tag without missing-key warnings", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    // RSC unwraps unkeyed fragments into arrays of server-rendered children.
    const html = renderToStaticMarkup(
      <ResourceBrowser
        title="Resources"
        description="Resources"
        label="Resources"
        rows={[
          {
            key: "resource_one",
            name: "Resource one",
            search: "resource",
            meta: null,
            tags: [createElement("span", null, "Private"), createElement("span", null, "New version available")],
            state: <span>Ready</span>,
            detail: <p>Details</p>,
          },
        ]}
        blockers={[]}
        empty={null}
        initial={null}
      />,
    );
    expect(html).toContain("Private");
    expect(html).toContain("New version available");
    expect(errors.mock.calls.filter((args) => String(args[0]).includes('unique "key"'))).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});
