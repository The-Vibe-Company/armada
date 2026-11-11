import { expect, test } from "@playwright/test";
import { createDialog, goldenPanel, goldenRow, MOCK, openCreate, reset, signIn } from "./helpers";

/** The #808 skeleton shared by Environments and Tools: strip, sorted list, panel (a sheet on a phone), New in a dialog (#898). */

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
  await expect(strip).toContainText("2 items need attention");
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

  // New opens the create dialog over the list; Escape closes it and gives the focus back.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(createDialog(page)).toBeVisible();
  await openCreate(page);
  await page.keyboard.press("Escape");
  await expect(createDialog(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
});

for (const mobile of [false, true]) {
  test(`New opens the create form in a dialog over the list, whole on a laptop (${mobile ? "phone" : "laptop"})`, async ({
    page,
  }) => {
    // The default laptop viewport, and a Boat with room: no full-capacity notice above the form.
    const width = mobile ? 390 : 1280;
    await page.setViewportSize({ width, height: mobile ? 844 : 720 });
    await fetch(`${MOCK}/__test/capabilities`, { method: "POST", body: JSON.stringify({ maxGoldens: null }) });
    await signIn(page, "alice@example.com", "/environments");
    const form = await openCreate(page);
    // A dialog over the list, never the side panel beside it.
    await expect(page.locator("[data-resource-panel]")).toBeHidden();
    await expect(page.locator("[data-golden]").first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // The one choice nothing changes later says so beside it.
    await expect(form.locator("[data-permanent]")).toHaveText("Cannot be changed later");
    await page.screenshot({
      path: `test-results/environments-create-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    // On a laptop the whole form reads without scrolling; on a phone the dialog scrolls inside itself.
    const scrolls = await createDialog(page).evaluate((dialog) => dialog.scrollHeight > dialog.clientHeight);
    expect(scrolls).toBe(mobile);
    if (!mobile) {
      await expect(form.getByLabel("Name")).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole("button", { name: "Build golden" })).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole("button", { name: "Recover admission by key" })).toBeInViewport({ ratio: 1 });
    }
    await page.keyboard.press("Escape");
    await expect(createDialog(page)).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]item=/);
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();

    // With a row's panel open beside the list, closing the dialog still gives the focus back to New.
    if (!mobile) {
      await goldenPanel(page, "shared-golden");
      await openCreate(page);
      await page.keyboard.press("Escape");
      await expect(createDialog(page)).toBeHidden();
      await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
    }
  });
}

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
  const sheet = page.locator("[data-resource-panel]");
  const box = await sheet.boundingBox();
  expect(box?.width).toBe(390);
  await expect(panel.getByRole("list", { name: "Repositories of web-frontend on Boat" })).toContainText(
    "acme/design-system",
  );
  // A modal sheet: named by its title, the list behind it out of reach, Tab kept inside.
  await expect(page.getByRole("dialog", { name: "web-frontend" })).toBeVisible();
  await expect(page.locator("[inert]").filter({ has: row })).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: "test-results/environments-sheet-mobile.png", animations: "disabled" });
  await page.getByRole("button", { name: "Close the panel" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/tools");
  await page.locator('[data-connection="Datadog"] [data-select-item]').click();
  await expect(page.locator('[data-connection-panel="Datadog"]')).toContainText("The grant expired.");
  expect((await sheet.boundingBox())?.width).toBe(390);
});
