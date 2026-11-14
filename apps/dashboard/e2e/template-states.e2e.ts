import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

const DIAGNOSTIC = "HTTP 503: template_id unavailable; digest sha256:example";
async function failure(message: string | null, unsupported = false) {
  expect(
    (
      await fetch(`${MOCK}/__test/template-list-failure`, {
        method: "POST",
        body: JSON.stringify({ message, unsupported }),
      })
    ).ok,
  ).toBe(true);
}
test.beforeEach(reset);

test("Templates hides read diagnostics and reloads a fresh inventory", async ({ page }) => {
  await failure(DIAGNOSTIC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/templates");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("Templates could not be loaded");
  await expect(alert).not.toContainText(DIAGNOSTIC);
  await page.screenshot({ path: "test-results/template-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/template-states-mobile.png", animations: "disabled" });
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await failure(null);
  await alert.getByRole("link", { name: "Reload Templates", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Templates", exact: true })).toContainText("Backend with docs");
});

test("an unsupported template API stays distinct from an empty inventory", async ({ page }) => {
  await failure(DIAGNOSTIC, true);
  await signIn(page, "alice@example.com", "/templates");
  const main = page.getByRole("main");
  await expect(main.getByText("Template management needs an update", { exact: true })).toBeVisible();
  await expect(main).not.toContainText(DIAGNOSTIC);
  await expect(main).not.toContainText("No templates yet");
  await expect(main.getByRole("link", { name: "Reload Templates", exact: true })).toHaveAttribute("href", "/templates");
  await expect(main.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});

test("Templates without an organization offers an organization choice first", async ({ page }) => {
  await signIn(page, "carol@example.com", "/templates");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});

test("a missing published revision keeps its visible header without pretending the inventory is empty", async ({
  page,
}) => {
  expect(
    (await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ missingTemplateRevision: true }) }))
      .ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/templates");
  const list = page.getByRole("list", { name: "Templates", exact: true });
  await expect(list.getByRole("listitem").filter({ hasText: "Modal quick fix" })).toContainText("Details unavailable");
  await expect(list).toContainText("Backend with docs");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("No templates yet");
});
