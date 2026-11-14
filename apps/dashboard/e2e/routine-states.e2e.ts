import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

async function configure(body: object) {
  expect((await fetch(`${MOCK}/__test/routines`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
test.beforeEach(reset);

test("Routines reloads a fresh saved state after a read failure without offering creation", async ({ page }) => {
  await configure({ failure: { status: 503, code: "unavailable", message: "HTTP 503: routine_id unavailable" } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/routines");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("Routines could not be loaded");

  await expect(alert.getByRole("link", { name: "Reload Routines", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/routine-states-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/routine-states-mobile.png", animations: "disabled" });
  await expect(alert).not.toContainText("routine_id");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await configure({ failure: null });
  await alert.getByRole("link", { name: "Reload Routines", exact: true }).click();
  await expect(page.getByRole("list", { name: "Routines", exact: true })).toContainText("Morning review");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
});

test("unavailable template choices preserve existing schedules and offer reload instead of a dead-end form", async ({
  page,
}) => {
  expect(
    (
      await fetch(`${MOCK}/__test/template-list-failure`, {
        method: "POST",
        body: JSON.stringify({ message: "HTTP 503: template_id unavailable" }),
      })
    ).ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/routines");
  await expect(page.getByRole("list", { name: "Routines", exact: true })).toContainText("Morning review");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Reload Routines", exact: true })).toHaveAttribute("href", "/routines");
  await expect(page.getByRole("main")).not.toContainText("template_id");
});

test("a known empty template list directs setup without hiding existing routines", async ({ page }) => {
  await configure({ templatesEmpty: true });
  await signIn(page, "alice@example.com", "/routines");
  await expect(page.getByRole("list", { name: "Routines", exact: true })).toContainText("Morning review");
  await expect(page.getByRole("link", { name: "Create a template", exact: true })).toHaveAttribute(
    "href",
    "/templates",
  );
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});

test("Routines without an organization offers organization setup first", async ({ page }) => {
  await signIn(page, "carol@example.com", "/routines");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Choose an organization", exact: true })).toHaveAttribute(
    "href",
    "/orgs",
  );
  await expect(main.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});

test("an unsupported routine API offers update guidance instead of a new schedule", async ({ page }) => {
  await configure({ failure: { status: 404, message: "HTTP 404: routine_id route unavailable" } });
  await signIn(page, "alice@example.com", "/routines");
  const main = page.getByRole("main");
  await expect(main.getByText("Routine management needs an update", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Reload Routines", exact: true })).toHaveAttribute("href", "/routines");
  await expect(main.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(main).not.toContainText("routine_id");
});
