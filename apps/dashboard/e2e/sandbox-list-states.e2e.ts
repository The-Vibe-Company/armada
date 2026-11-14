import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const UNKNOWN = "00000000-0000-4000-8000-000000000799";
async function post(path: string, body: object) {
  expect((await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
test.beforeEach(reset);

test("Sandboxes without an organization explains the first step before offering launch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "carol@example.com");
  const main = page.getByRole("main");
  await expect(main).toContainText("No organization yet");
  await expect(page.getByLabel("Search sandboxes")).toHaveCount(0);
  await page.screenshot({ path: "test-results/sandbox-list-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/sandbox-list-states-mobile.png", animations: "disabled" });
  await expect(main).toContainText("No organization yet");
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("link", { name: "Launch a sandbox", exact: true })).toHaveCount(0);
  await expect(main).not.toContainText("No sandboxes yet");
});

test("a confirmed empty fleet gives a plain first-launch step", async ({ page }) => {
  await post("reset", { emptySandboxes: true });
  await signIn(page, "alice@example.com");
  const main = page.getByRole("main");
  await expect(main).toContainText("No sandboxes yet");
  await expect(main).toContainText("Choose a snapshot to launch your first sandbox.");
  await expect(main).not.toContainText("<golden>");
  await main.getByRole("link", { name: "Launch a sandbox", exact: true }).last().click();
  await expect(page).toHaveURL(/\/environments$/);
  await expect(page.getByRole("heading", { name: "Snapshots", exact: true, level: 1 })).toBeVisible();
});

test("an unreadable fleet stays unknown and reload can recover repaired rows", async ({ page }) => {
  await post("reset", { emptySandboxes: true });
  await post("add-sandboxes", {
    rows: [{ id: UNKNOWN, provider: "future-provider", provider_sandbox_id: "recovered-workspace" }],
  });
  await signIn(page, "alice@example.com");
  const main = page.getByRole("main");
  await expect(main).toContainText("Sandboxes could not be shown");
  await expect(main).not.toContainText("No sandboxes yet");
  await expect(main).not.toContainText(UNKNOWN);
  await post("sandbox-lifecycle", { id: UNKNOWN, fields: { provider: "boat" } });
  await main.getByRole("link", { name: "Reload Sandboxes", exact: true }).click();
  await expect(main.getByRole("table")).toContainText("recovered-workspace");
  await expect(main).not.toContainText("Sandboxes could not be shown");
});
