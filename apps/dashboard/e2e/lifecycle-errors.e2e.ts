import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test("an unconfirmed stop hides provider diagnostics and leaves the current sandbox observable", async ({ page }) => {
  await reset();
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const diagnostic = "HTTP 502: sandbox_id container_digest sha256:example";
  expect(
    (
      await fetch(`${MOCK}/__test/fail-next-tool`, {
        method: "POST",
        body: JSON.stringify({ message: diagnostic }),
      })
    ).ok,
  ).toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop sandbox", exact: true }).click();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText("Stop request not confirmed");
  await expect(toast).toContainText("check its current state before trying again");
  await expect(toast).not.toContainText(diagnostic);
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/lifecycle-after-${name}.png`, fullPage: true });
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  // The failure is consumed; the existing confirmed-stop path must still work.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop sandbox", exact: true }).click();
  await expect(page.locator('[data-slot="toast"]')).toContainText("Stop requested.");
});
