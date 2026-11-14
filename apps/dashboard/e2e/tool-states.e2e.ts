import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: connection_id unavailable; digest sha256:example";
async function failure(operation: "list" | "catalog" | "status", message: string | null) {
  expect(
    (await fetch(`${MOCK}/__test/mcp-read-failure`, { method: "POST", body: JSON.stringify({ operation, message }) }))
      .ok,
  ).toBe(true);
}
test.beforeEach(reset);

test("Tools read failure stays unknown, hides diagnostics and reloads fresh data", async ({ page }) => {
  await failure("list", DIAGNOSTIC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/tools");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/tool-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/tool-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toHaveCount(0);
  await failure("list", null);
  await alert.getByRole("link", { name: "Reload Tools", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText("Tools could not be loaded", { exact: true })).toHaveCount(0);
});

test("an unavailable service catalog leaves existing tools and custom setup usable without raw errors", async ({
  page,
}) => {
  await failure("catalog", DIAGNOSTIC);
  await signIn(page, "alice@example.com", "/tools");
  await expect(page.locator('[data-connection="Alice Linear"]')).toBeVisible();
  const notice = page.getByRole("region", { name: "Services", exact: true }).locator("[data-catalog-unavailable]");
  await expect(notice).not.toContainText(DIAGNOSTIC);
  await expect(notice).toContainText("You can still use Add server");
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeVisible();
});

test("an unverified sign-in lookup does not claim the connection was lost or not saved", async ({ page }) => {
  await failure("status", DIAGNOSTIC);
  await signIn(page, "alice@example.com", "/tools?connection=00000000-0000-4000-8000-000000000061&oauth=returned");
  const notice = page.locator('[data-oauth-return="failed"]').filter({ visible: true });
  await expect(notice).toContainText("Sign-in status could not be checked");
  await expect(notice).not.toContainText(DIAGNOSTIC);
  await expect(notice).not.toContainText("could not be found");
  await expect(notice.getByRole("link", { name: "Reload Tools", exact: true })).toHaveAttribute("href", "/tools");
});

test("Tools without an organization gives a clear organization next step", async ({ page }) => {
  await signIn(page, "carol@example.com", "/tools");
  const main = page.getByRole("main");
  await expect(main.getByText("No organization yet", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("button", { name: "Add server", exact: true })).toHaveCount(0);
});
