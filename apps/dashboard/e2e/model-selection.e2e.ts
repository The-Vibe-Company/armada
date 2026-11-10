import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

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
    page.getByText("Model selection changed: Work may already have occurred. Do not retry automatically.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("Requested: claude-fable-5-2 · Observed: claude-sonnet-5", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/model-selection-mobile.png", fullPage: true });
});

test("unknown observed model is neutral, never a failure banner", async ({ page }) => {
  await page.route(`**/api/sandboxes/${IDS.running}/events*`, (route) =>
    route.fulfill({
      json: {
        status: "ready",
        events: [],
        hasMore: false,
        prompt: {
          requestedModel: null,
          observedModel: null,
          modelSelectionReason: "model_selection_unverified",
          modelSelectionMessage: "Model evidence is unavailable.",
        },
      },
    }),
  );
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const label = page.getByText("Model not verified: Model evidence is unavailable.", { exact: true });
  await expect(label).toBeVisible();
  await expect(label).not.toHaveClass(/text-destructive/);
});

test("status telemetry failure leaves the successfully read conversation visible", async ({ page }) => {
  await fetch(`${MOCK}/__test/sandbox-lifecycle`, {
    method: "POST",
    body: JSON.stringify({ id: IDS.running, fields: { test_status_read_unavailable: true } }),
  });
  await fetch(`${MOCK}/__test/sandbox-events`, {
    method: "POST",
    body: JSON.stringify({
      sandbox: IDS.running,
      events: [{ id: "answer", at: 1, kind: "message", text: "The log read succeeded", partial: false, tools: [] }],
    }),
  });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByText("The log read succeeded")).toBeVisible();
  await expect(page.getByText("Status unavailable", { exact: true })).toHaveCount(0);
});
