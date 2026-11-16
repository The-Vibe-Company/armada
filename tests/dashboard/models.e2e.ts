import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Protects the provider disclosure and wizard navigation at their user-facing boundary.
for (const session of ["alice", "large"]) {
  test(`${session}: inspect a provider and configure an API account`, { session }, async ({ app, screen, browser }) => {
    await app.open("/harness");
    const toggle = browser.locator("[data-account] button[aria-expanded]").first();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(screen.getByRole("dialog").getByText("Status", { exact: true })).toBeVisible();
    await screen.getByRole("button", "Close details", { exact: true }).tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", "Add account", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "Add provider");
    // Check before tapping: tap would scroll a clipped primary action into view.
    const clipped = await browser.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')!;
      const action = [...dialog.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Continue with Claude"),
      )!;
      const bounds = dialog.getBoundingClientRect();
      const rect = action.getBoundingClientRect();
      return rect.top < bounds.top || rect.bottom > bounds.bottom || rect.bottom > innerHeight;
    });
    expect(clipped).toBe(false);
    await dialog.getByRole("button", "OpenAI API key").tap();
    await dialog.getByRole("button", "Continue", { exact: true }).tap();
    await dialog.getByLabel("Name", { exact: true }).fill("Journey model connection");
    await dialog.getByLabel("Maximum agents running at the same time").fill("0");
    await dialog.getByRole("button", "Continue to configuration").tap();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
    await dialog.getByLabel("Maximum agents running at the same time").fill("2");
    await dialog.getByRole("button", "Continue to configuration").tap();
    await expect(dialog.getByLabel("API key", { exact: true })).toBeVisible();
    await dialog.getByRole("button", "Back", { exact: true }).tap();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Journey model connection");
    await dialog.getByRole("button", "Continue to configuration").tap();
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

// Geometry is asserted at the rendered boundary: visibility alone misses clipped text.
test("long account names and subscription fallback fit a phone", { session: "alice" }, async ({
  app,
  screen,
  browser,
}) => {
  const name = "a".repeat(120);
  const fits = async () => {
    const overflow = await browser.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1);
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
  await screen.getByRole("button", "Add account", { exact: true }).first().tap();
  let dialog = screen.getByRole("dialog", "Add provider");
  await dialog.getByRole("button", "OpenAI API key").tap();
  await dialog.getByRole("button", "Continue", { exact: true }).tap();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", "Continue to configuration").tap();
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
  for (const provider of ["Claude", "ChatGPT"]) {
    await screen.getByRole("button", "Add account", { exact: true }).first().tap();
    dialog = screen.getByRole("dialog", "Add provider");
    await dialog.getByRole("button", new RegExp(`^${provider} Subscription`)).tap();
    await dialog.getByRole("button", `Continue with ${provider}`, { exact: true }).tap();
    await dialog.getByRole("button", `Continue with ${provider}`, { exact: true }).tap();
    const fallback = dialog.getByRole("button", /No terminal here, or on a phone/);
    await expect(fallback).toBeVisible();
    await fits();
    const box = await fallback.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= (await browser.evaluate(() => innerWidth))).toBe(true);
    await fallback.tap();
    await expect(fallback).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("button", "Close", { exact: true }).tap();
  }
});
