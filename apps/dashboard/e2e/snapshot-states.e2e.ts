import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: provider_snapshot_id unavailable; digest sha256:example";
async function configure(options: object) {
  expect((await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify(options) })).ok).toBe(true);
}

test.beforeEach(reset);

test("Snapshots hides provider diagnostics and reloads a fresh provider observation", async ({ page }) => {
  await fetch(`${MOCK}/__test/provider-status-fail`, {
    method: "POST",
    body: JSON.stringify({ fail: { status: 503, message: DIAGNOSTIC } }),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/environments");
  const alert = page.locator('[data-setup-state="unavailable"]');
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/snapshot-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/snapshot-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("list", { name: "Snapshots", exact: true })).toContainText("shared-golden");
  await fetch(`${MOCK}/__test/provider-status-fail`, { method: "POST", body: JSON.stringify({ fail: null }) });
  await alert.getByRole("link", { name: "Reload Snapshots", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("Self-hosted snapshots could not be loaded");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
});

test("an unreadable self-hosted inventory stays unknown, even with no connected machines", async ({ page }) => {
  await configure({ dockerHosts: [], emptyGoldens: true, snapshotListFailure: DIAGNOSTIC });
  await signIn(page, "alice@example.com", "/environments");
  const main = page.getByRole("main");
  await expect(main).toContainText("Self-hosted snapshots could not be loaded");
  await expect(main).not.toContainText(DIAGNOSTIC);
  await expect(main).not.toContainText("No snapshots yet");
  await expect(main).toContainText("Snapshots are not fully loaded");
  await fetch(`${MOCK}/__test/snapshot-list-failure`, { method: "POST", body: JSON.stringify({ message: null }) });
  await main.getByRole("link", { name: "Reload Snapshots", exact: true }).first().click();
  await expect(main).toContainText("No snapshots yet");
  await expect(main).not.toContainText("Snapshots are not fully loaded");
});

test("a self-hosted read failure preserves available cloud snapshots", async ({ page }) => {
  await configure({ dockerHosts: [], snapshotListFailure: DIAGNOSTIC });
  await signIn(page, "alice@example.com", "/environments");
  await expect(page.getByRole("main")).toContainText("Self-hosted snapshots could not be loaded");
  await expect(page.getByRole("list", { name: "Snapshots", exact: true })).toContainText("shared-golden");
  await expect(page.getByRole("button", { name: "Launch from shared-golden" })).toBeVisible();
});

test("Snapshots without an organization offers an organization choice first", async ({ page }) => {
  await signIn(page, "carol@example.com", "/environments");
  await expect(
    page.getByRole("main").getByRole("link", { name: "Choose an organization", exact: true }),
  ).toHaveAttribute("href", "/orgs");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});

test("unknown cloud provider status does not suggest an empty inventory or a missing connection", async ({ page }) => {
  await configure({ emptyGoldens: true });
  await fetch(`${MOCK}/__test/provider-status-fail`, {
    method: "POST",
    body: JSON.stringify({ fail: { status: 503, message: DIAGNOSTIC } }),
  });
  await signIn(page, "alice@example.com", "/environments");
  const main = page.getByRole("main");
  await expect(main).toContainText("Snapshots are not fully loaded");
  await expect(main).not.toContainText("No snapshots yet");
  await expect(main).not.toContainText("Connect a sandbox provider");
  await expect(main).not.toContainText(DIAGNOSTIC);
  await expect(main.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});
