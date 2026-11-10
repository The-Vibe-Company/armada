import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, MOCK, openCreate, reset, signIn } from "./helpers";

/** The #808 skeleton shared by Environments and Tools: strip, sorted list, panel (a sheet on a phone), New. */

const ALICE_PRIVATE = "00000000-0000-4000-8000-000000000021";

async function large(): Promise<void> {
  const response = await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ large: true }) });
  expect(response.ok).toBe(true);
}

test.beforeEach(reset);

test("the strip names what blocks launching and opens its fix; the list puts what needs action first", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  const strip = page.locator("[data-readiness]");
  await expect(strip).toContainText("2 things block launching");
  await expect(strip.getByRole("link")).toHaveText([/^Connect Modal/, /^Snapshot alice-private/]);
  await expect(strip.getByRole("link", { name: /^Connect Modal/ })).toHaveAttribute("href", "/settings");
  // Needs action (by name), then ready.
  await expect(page.locator("[data-golden]")).toHaveText([/^alice-private/, /^modal-golden/, /^shared-golden/]);

  // The snapshot fix opens the environment's panel on its build form, and the URL keeps the selection.
  await strip.getByRole("link", { name: /^Snapshot alice-private/ }).click();
  const panel = page.locator('[data-golden-panel="alice-private"]');
  await expect(panel.locator('form[data-golden-form="update"]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${ALICE_PRIVATE}`));
  await page.reload();
  await expect(panel).toBeVisible();

  // Its row action leads to the same form.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await goldenRow(page, "alice-private").getByRole("button", { name: "Snapshot alice-private on Boat" }).click();
  await expect(panel.locator('form[data-golden-form="update"]')).toBeVisible();
});

test("keyboard: a row is focusable, Enter opens its panel, Escape closes it and gives the focus back", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  const select = goldenRow(page, "shared-golden").locator("[data-select-item]");
  await select.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-golden-panel="shared-golden"]');
  await expect(panel).toBeVisible();
  await expect(page.getByRole("heading", { name: "shared-golden", level: 2 })).toBeFocused();
  await expect(select).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(select).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]item=/);

  // New opens the create form in the same panel.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create a golden" })).toBeFocused();
  await openCreate(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
});

test("a long list offers a filter by name, provider or repository", async ({ page }) => {
  await large();
  await signIn(page, "alice@example.com", "/environments");
  const rows = page.locator("[data-golden]");
  await expect(rows).toHaveCount(10);
  const filter = page.getByRole("searchbox", { name: "Filter environments" });
  await filter.fill("modal");
  await expect(rows).toHaveText([/^ml-research/, /^modal-golden/]);
  await filter.fill("acme/proto");
  await expect(rows).toHaveText([/^api-backend/]);
  await filter.fill("nothing-like-this");
  await expect(page.getByText("Nothing matches")).toBeVisible();

  await page.goto("/tools");
  await page.getByRole("searchbox", { name: "Filter tools" }).fill("figma");
  await expect(page.locator("[data-connection]")).toHaveText([/Figma/]);
});

test("on a phone the list fits the width and the panel is a sheet over it", async ({ page }) => {
  await large();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com", "/environments");
  const row = goldenRow(page, "web-frontend");
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByRole("button", { name: "Launch from web-frontend" })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const panel = await goldenPanel(page, "web-frontend");
  const sheet = page.locator("#resource-panel");
  const box = await sheet.boundingBox();
  expect(box?.width).toBe(390);
  await expect(panel.getByRole("list", { name: "Repositories of web-frontend on Boat" })).toContainText(
    "acme/design-system",
  );
  await page.screenshot({ path: "test-results/environments-sheet-mobile.png", animations: "disabled" });
  await page.getByRole("button", { name: "Close the panel" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/tools");
  await page.locator('[data-connection="Datadog"] [data-select-item]').click();
  await expect(page.locator('[data-connection-panel="Datadog"]')).toContainText("The grant expired.");
  expect((await sheet.boundingBox())?.width).toBe(390);
});
