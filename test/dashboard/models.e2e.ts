import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const session of ["alice", "large"]) {
  test(`${session}: inspect a provider and configure an API account`, { session }, async ({ app, screen, browser }) => {
    await app.open("/harness");
    await screen.getByPlaceholder("Search accounts").fill("no_matching_account");
    await expect(screen.getByText("Nothing matches", { exact: true })).toBeVisible();
    await screen.getByPlaceholder("Search accounts").fill("");
    const toggle = browser.locator("[data-account] button[aria-expanded]").first();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(screen.getByRole("dialog").getByText("Status", { exact: true })).toBeVisible();
    await screen.getByRole("button", "Close details", { exact: true }).tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", "Add an account", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "Add an account");
    await dialog.getByRole("radio", "OpenAI API key", { exact: true }).check();
    await dialog.getByLabel("Name", { exact: true }).fill("Journey model connection");
    await dialog.getByLabel("Maximum agents running at the same time").fill("0");
    await dialog.getByRole("button", "Add account", { exact: true }).tap();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
    await dialog.getByLabel("Maximum agents running at the same time").fill("2");
    await dialog.getByLabel("API key", { exact: true }).fill("example_api_key");
    await dialog.getByRole("button", "Add account", { exact: true }).tap();
    await expect(dialog).toBeHidden();
    const added = browser.locator('[data-account="Journey model connection"]');
    await expect(added).toBeVisible();
    await added.getByRole("button", /^Journey model connection/).tap();
    await screen.getByRole("dialog").getByLabel("Display name").fill("Journey renamed connection");
    await screen.getByRole("dialog").getByRole("button", "Save name", { exact: true }).tap();
    const renamed = browser.locator('[data-account="Journey renamed connection"]');
    await expect(renamed).toBeVisible();
    await screen
      .getByRole("dialog")
      .getByRole("button", /^More actions for/)
      .tap();
    await screen.getByRole("menuitem", "Remove", { exact: true }).tap();
    await screen.getByRole("button", "Remove account", { exact: true }).tap();
    await expect(renamed).toHaveCount(0);
  });
}

test("long account names and subscription fallback fit a phone", { session: "alice" }, async ({
  app,
  screen,
  browser,
}) => {
  const name = "a".repeat(120);
  const fits = async () => {
    const overflow = await browser.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (!(dialog instanceof HTMLElement)) return true;
      const rect = dialog.getBoundingClientRect();
      return (
        rect.left < 0 ||
        rect.right > innerWidth ||
        rect.top < 0 ||
        rect.bottom > innerHeight ||
        dialog.scrollWidth > dialog.clientWidth
      );
    });
    expect(overflow).toBe(false);
  };
  await app.open("/harness");
  await screen.getByRole("button", "Add an account", { exact: true }).first().tap();
  let dialog = screen.getByRole("dialog", "Add an account");
  await dialog.getByRole("radio", "OpenAI API key", { exact: true }).check();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("API key", { exact: true }).fill("example_api_key");
  await dialog.getByRole("button", "Add account", { exact: true }).tap();
  await expect(dialog).toBeHidden();
  const row = browser.locator(`[data-account="${name}"]`);
  await row.getByRole("button", new RegExp(`^${name}`)).tap();
  for (const action of ["Agent limit", "Rename", "Test connection", "Replace key", "Remove"]) {
    await screen
      .getByRole("dialog")
      .getByRole("button", /^More actions for/)
      .tap();
    await screen.getByRole("menuitem", action, { exact: true }).tap();
    await expect(screen.getByRole(action === "Remove" ? "alertdialog" : "dialog")).toBeVisible();
    await fits();
    if (action === "Remove") await screen.getByRole("button", "Cancel", { exact: true }).tap();
    else await screen.getByRole("button", "Close", { exact: true }).tap();
  }
  await screen.getByRole("button", "Close details", { exact: true }).tap();
  for (const provider of ["claude_oauth", "codex_auth"]) {
    await screen.getByRole("button", "Add an account", { exact: true }).first().tap();
    dialog = screen.getByRole("dialog", "Add an account");
    await dialog
      .getByRole("radio", provider === "claude_oauth" ? "Claude subscription" : "ChatGPT subscription", { exact: true })
      .check();
    const fallback = dialog.getByRole("button", "Sign-in instructions and terminal login");
    await expect(fallback).toBeVisible();
    await fits();
    const box = await fallback.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= (await browser.evaluate(() => innerWidth))).toBe(true);
    await fallback.tap();
    await expect(fallback).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("button", "Close", { exact: true }).tap();
  }
});
