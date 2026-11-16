import { expect, spyOn, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceBrowser } from "../src/components/resource-browser";
import { ResourceTags } from "../src/components/resource-tags";
import { roundTripRsc } from "./fixtures/rsc";

test("tag groups retain one identity across Flight transport without missing-key warnings", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { tags } = await roundTripRsc({
      tags: (
        <ResourceTags>
          <span>Private</span>
          <span>New version available</span>
        </ResourceTags>
      ),
    });
    // Exercise the actual transport that unwraps unkeyed server fragments.
    expect(Children.count(tags)).toBe(1);
    const group = Children.toArray(tags)[0];
    expect(isValidElement(group)).toBe(true);
    if (isValidElement<{ children: ReactNode }>(group)) {
      Children.forEach(group.props.children, (child) => {
        if (isValidElement(child)) expect(child.key).not.toBeNull();
      });
    }
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
            tags,
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
