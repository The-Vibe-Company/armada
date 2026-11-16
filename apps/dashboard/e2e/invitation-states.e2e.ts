import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

// Owns the screen's unknown-inventory/recovery contract; invitation lifecycle remains in invitations.e2e.ts.
test("an invitation read failure hides diagnostics, preserves members and reloads fresh data", async ({ page }) => {
  const diagnostic = "HTTP 503: invitation_token_enc digest sha256:example";
  expect(
    (
      await fetch(`${MOCK}/__test/reset`, {
        method: "POST",
        body: JSON.stringify({ invitationListFailure: diagnostic }),
      })
    ).ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/orgs/00000000-0000-4000-8000-000000000010");
  const alert = page.getByRole("alert").filter({ hasText: "Pending invitations could not be loaded" });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText(diagnostic);
  await expect(page.getByText("No pending invitations.", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-member="bob@example.com"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite a member", exact: true })).toBeVisible();
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/invitations-after-${name}.png`, fullPage: true });
  }
  expect(
    (
      await fetch(`${MOCK}/__test/invitation-list-failure`, {
        method: "POST",
        body: JSON.stringify({ message: null }),
      })
    ).ok,
  ).toBe(true);
  await alert.getByRole("link", { name: "Reload organization", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByText("No pending invitations.", { exact: true })).toBeVisible();
});
