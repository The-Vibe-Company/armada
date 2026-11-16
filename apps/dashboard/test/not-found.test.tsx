import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "../src/app/(app)/not-found";

test("unavailable pages retain an accessible recovery destination and application theme surface", () => {
  const html = renderToStaticMarkup(<NotFound />);
  expect(html).toContain("This page could not be found");
  expect(html).toContain('href="/sandboxes"');
  expect(html).toContain("bg-background");
  expect(html).toContain("text-foreground");
});
