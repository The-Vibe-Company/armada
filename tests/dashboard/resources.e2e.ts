import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const session of ["alice", "large"]) {
  for (const resource of [
    { path: "/tools", title: "Tools", search: "Search tools", add: "Add an MCP server", row: "[data-select-item]" },
    {
      path: "/skills",
      title: "Skills",
      search: "Search keys",
      add: "Add a key",
      row: "[data-skillpack-key] button[aria-expanded]",
    },
  ]) {
    test(`${session}: filter and inspect ${resource.title}`, { session }, async ({ app, screen, browser }) => {
      await app.open(resource.path);
      await screen.getByPlaceholder(resource.search).fill("no_matching_resource");
      await expect(browser.locator(resource.row)).toHaveCount(0);
      await screen.getByPlaceholder(resource.search).fill("");
      await browser.locator(resource.row).first().tap();
      await expect(screen.getByRole("dialog")).toBeVisible();
      await screen.getByRole("button", "Close details", { exact: true }).tap();
      await screen.getByRole("button", resource.add, { exact: true }).tap();
      await expect(screen.getByRole("dialog")).toBeVisible();
      await screen.getByRole("button", "Close", { exact: true }).tap();
    });
  }
  test(`${session}: inspect variable metadata without exposing stored values`, { session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/variables");
    await expect(screen.getByRole("columnheader", "Value", { exact: true })).toBeVisible();
    await expect(screen.getByRole("cell", "Not shown", { exact: true }).first()).toBeVisible();
    await browser.locator("[data-select-item]").first().tap();
    await expect(screen.getByRole("dialog")).toBeVisible();
    await screen.getByRole("button", "Close details", { exact: true }).tap();
    await screen.getByRole("button", "Add a variable", { exact: true }).tap();
    await expect(screen.getByRole("dialog", "Add a setting or a secret")).toBeVisible();
  });
}
