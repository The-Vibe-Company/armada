import { expect, test } from "@playwright/test";
import { IDS, LABELS, MOCK, reset, signIn } from "./helpers";

const acmeRows = [IDS.running, IDS.failed, IDS.bobSecret];
async function status(id: string, value: string) {
  expect(
    (
      await fetch(`${MOCK}/__test/sandbox-lifecycle`, {
        method: "POST",
        body: JSON.stringify({ id, fields: { status: value } }),
      })
    ).ok,
  ).toBe(true);
}
async function capture(page: import("@playwright/test").Page, name: string) {
  for (const [size, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/fleet-${name}-after-${size}.png`, fullPage: true });
  }
}

test.beforeEach(reset);

test("without an organization the list offers organization choice before filters or launch", async ({ page }) => {
  await signIn(page, "carol@example.com");
  await expect(page.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(page.getByRole("link", { name: "Launch a sandbox", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Search sandboxes")).toHaveCount(0);
  await capture(page, "no-org");
});

test("unreadable inventory is not empty or filter absence, and reload sees a repaired row", async ({ page }) => {
  for (const id of acmeRows) await status(id, "future");
  await signIn(page, "alice@example.com");
  await expect(page.getByText("Sandboxes are not fully loaded", { exact: true })).toBeVisible();
  await expect(page.getByText("No sandboxes yet", { exact: true })).toHaveCount(0);
  await capture(page, "unknown");
  await page.goto("/sandboxes?status=ready");
  await expect(page.getByText("Sandboxes are not fully loaded", { exact: true })).toBeVisible();
  await expect(page.getByText("No sandbox matches these filters", { exact: true })).toHaveCount(0);
  await status(IDS.running, "ready");
  const reload = page.getByRole("link", { name: "Reload Sandboxes", exact: true });
  await expect(reload).toHaveAttribute("href", /status=ready/);
  await reload.click();
  await expect(page.getByRole("link", { name: LABELS.running, exact: true })).toBeVisible();
  await expect(page.getByText("Sandboxes are not fully loaded", { exact: true })).toHaveCount(0);
});

test("confirmed empty inventory points to Snapshots while a filtered list keeps clear-filter recovery", async ({
  page,
}) => {
  for (const id of acmeRows) await status(id, "deleted");
  await signIn(page, "alice@example.com");
  await expect(page.getByText("No sandboxes yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Choose a snapshot, then tell an agent what to do.");
  await expect(page.getByRole("main")).not.toContainText("armada launch");
  await expect(page.getByRole("link", { name: "Launch a sandbox", exact: true }).last()).toHaveAttribute(
    "href",
    "/snapshots",
  );
  await page.goto("/sandboxes?q=missing");
  await expect(page.getByRole("link", { name: "Clear filters", exact: true })).toHaveAttribute("href", "/sandboxes");
});
