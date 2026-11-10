import { expect, test } from "@playwright/test";
import { IDS, reset, signIn } from "./helpers";

test.beforeEach(reset);

// This owns client rendering, not model classification (covered at the server boundary).
test("a settled model mismatch keeps requested and observed visible without retry", async ({ page }) => {
  await page.route(`**/api/sandboxes/${IDS.running}/events*`, async (route) => {
    await route.fulfill({
      json: {
        status: "ready",
        configured: true,
        events: [],
        cursor: null,
        hasMore: false,
        prompt: {
          requestedModel: "claude-fable-5-2",
          observedModel: "claude-sonnet-5",
          modelSelectionReason: "model_selection_mismatch",
          modelSelectionMessage: "Work may already have occurred. Do not retry automatically.",
        },
      },
    });
  });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(
    page.getByText("Requested: claude-fable-5-2 · Observed: claude-sonnet-5", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("model_selection_mismatch: Work may already have occurred. Do not retry automatically.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("Requested: claude-fable-5-2 · Observed: claude-sonnet-5", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/model-selection-mobile.png", fullPage: true });
});
