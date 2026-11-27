import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const session of ["alice", "large"]) {
  for (const resource of [
    { path: "/tools", title: "Tools", search: "Search tools", add: "Add an MCP server", row: "[data-select-item]" },
    {
      path: "/skills",
      title: "Skills",
      add: "Add a key",
      row: "[data-skillpack-key] button[aria-expanded]",
    },
  ]) {
    test(`${session}: filter and inspect ${resource.title}`, { session }, async ({ app, screen, browser }) => {
      await app.open(resource.path);
      if (resource.search) {
        await screen.getByPlaceholder(resource.search).fill("no_matching_resource");
        await expect(browser.locator(resource.row)).toHaveCount(0);
        await screen.getByPlaceholder(resource.search).fill("");
      }
      await browser.locator(resource.row).first().tap();
      await expect(screen.getByRole("dialog")).toBeVisible();
      await screen
        .getByRole("button", resource.title === "Skills" ? "Close details" : "Close the panel", { exact: true })
        .tap();
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
    const mobile = await browser.evaluate(() => window.innerWidth < 768);
    const name = session === "alice" ? "APP_REGION" : "LARGE_CONFIGURATION_0";
    const storedValue = session === "alice" ? "eu-west-1" : "large_fixture_value_0";
    const variable = screen.getByRole("link", name, { exact: true });
    const row = screen.getByRole(mobile ? "listitem" : "row").filter({ has: variable });
    if (mobile) {
      await expect(row.getByText("Click to view", { exact: true })).toBeVisible();
    } else {
      await expect(screen.getByRole("columnheader", "Value", { exact: true })).toBeVisible();
      await expect(row.getByRole("cell", "Click to view", { exact: true })).toBeVisible();
    }
    await expect(screen.getByText(storedValue, { exact: true })).toHaveCount(0);
    await variable.tap();
    await expect(screen.getByRole("dialog")).toBeVisible();
    await screen.getByRole("button", "Close the panel", { exact: true }).tap();
    await screen.getByRole("button", "Add a variable", { exact: true }).tap();
    await expect(screen.getByRole("dialog", "Add a variable or secret")).toBeVisible();
  });
}
