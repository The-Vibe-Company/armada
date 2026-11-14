import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

for (const operation of ["set", "default"] as const) {
  test(`Models hides ${operation} diagnostics and preserves the observed saved state`, async ({ page }) => {
    await signIn(page, "alice@example.com", "/harness");
    await page.getByRole("button", { name: "Add a model account", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Provider", { exact: true }).selectOption("claude_oauth");
    await dialog.getByLabel("Name").fill("Example account");
    const token = ["sk", "ant", "oat01", "example_key"].join("-");
    await dialog.getByLabel("OAuth token").fill(token);
    if (operation === "default") await dialog.getByLabel(/Make it the default/).check();
    const diagnostic = "HTTP 503: credential_version account_id digest sha256:example";
    expect(
      (
        await fetch(`${MOCK}/__test/accounts`, {
          method: "POST",
          body: JSON.stringify({ actionFailure: { operation, message: diagnostic } }),
        })
      ).ok,
    ).toBe(true);
    await dialog.getByRole("button", { name: "Add subscription", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Reload Models");
    await expect(dialog.getByRole("alert")).not.toContainText(diagnostic);
    await expect(dialog.getByLabel("OAuth token")).toHaveValue("");
    expect(await page.content()).not.toContain(token);
    if (operation === "default") {
      await expect(dialog.getByRole("alert")).toContainText("was saved");
      for (const [name, width] of [
        ["desktop", 1280],
        ["mobile", 390],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await dialog.getByRole("button", { name: "Add subscription", exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: `test-results/model-action-after-${name}.png`, fullPage: true });
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-account="Example account"]')).toHaveCount(operation === "default" ? 1 : 0);
  });
}
