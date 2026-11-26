import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "../global-error";
import AppError from "./error";
import NotFound from "./not-found";

test("unavailable pages retain an accessible recovery destination and application theme surface", () => {
  const html = renderToStaticMarkup(<NotFound />);
  expect(html).toContain("This page could not be found");
  expect(html).toContain('href="/sandboxes"');
  expect(html).toContain("bg-background");
  expect(html).toContain("text-foreground");
});

test("error boundaries render sanitized copy with a recovery button and never expose internal error messages", () => {
  const internal = Object.assign(new Error("secret_internal_sql_detail"), { digest: "err-digest-42" });
  for (const html of [
    renderToStaticMarkup(<AppError error={internal} reset={() => {}} />),
    renderToStaticMarkup(<GlobalError error={internal} reset={() => {}} />),
  ]) {
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).toContain("err-digest-42");
    expect(html).not.toContain("secret_internal_sql_detail");
  }
});
