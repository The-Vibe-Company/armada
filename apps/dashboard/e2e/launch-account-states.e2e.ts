import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test("unreadable launch accounts hide diagnostics and never fall back to server billing defaults", async ({ page }) => {
  await reset();
  const diagnostic = "HTTP 503: model_account_id credential_version digest sha256:example";
  expect(
    (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: JSON.stringify({ listFailure: diagnostic }) })).ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/snapshots");
  await page.getByRole("button", { name: "Launch from shared-golden on Boat", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Model accounts could not be checked");
  await expect(dialog).not.toContainText(diagnostic);
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByText("Model accounts could not be checked", { exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/launch-account-after-${name}.png`, fullPage: true });
  }
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toHaveAccessibleDescription(
    /Model accounts could not be checked/,
  );
  const state = await (await fetch(`${MOCK}/__test/state`)).json();
  expect(state.launches).toHaveLength(0);
});
