import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

test.beforeEach(reset);

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`Variables overlay keeps list geometry and restores focus (${width}, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await signIn(page, "alice@example.com", "/variables");
      const row = page.locator('[data-vault-item="APP_REGION"]').filter({ visible: true });
      const select = row.locator("[data-select-item]");
      await select.scrollIntoViewIfNeeded();
      const before = await row.boundingBox();
      await select.click();
      const panel = page.locator('[data-vault-panel="APP_REGION"]');
      await expect(panel).toBeVisible();
      await page.screenshot({
        path: `test-results/variables-panel-${width}-${theme}.png`,
        fullPage: false,
        animations: "disabled",
      });
      const sheet = page.getByRole("dialog", { name: "APP_REGION", exact: true });
      await expect(sheet).toBeVisible();
      expect(await row.boundingBox()).toEqual(before);
      await expect(row).toHaveAttribute("data-selected", "true");
      await expect(page.locator("[data-resource-panel-title]")).toBeFocused();
      const bounds = await sheet.boundingBox();
      if (width === 390) expect(bounds?.width).toBe(width);
      else expect(bounds?.x).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(select).toBeFocused();
      await expect(page).toHaveURL(/\/variables$/);
    });
  }
}

test("Variables history, direct links, keyboard navigation and nested confirmation stay coherent", async ({ page }) => {
  await signIn(page, "alice@example.com", "/tools");
  await page.goto("/variables");
  const row = page.locator('[data-vault-item="APP_REGION"]').filter({ visible: true });
  for (const dismiss of ["back", "close", "outside"] as const) {
    await row.locator("[data-select-item]").click();
    const sheet = page.getByRole("dialog", { name: "APP_REGION", exact: true });
    await expect(sheet).toBeVisible();
    if (dismiss === "back") await page.evaluate(() => history.back());
    else if (dismiss === "close") await page.getByRole("button", { name: "Close the panel" }).click();
    else await page.mouse.click(10, 300);
    await expect(sheet).toBeHidden();
    await expect(row.locator("[data-select-item]")).toBeFocused();
  }
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/tools$/);
  // Native row links support new tabs; a direct load closes without leaving Variables.
  await page.goto("/variables");
  const href = await row.locator("[data-select-item]").getAttribute("href");
  expect(href).toContain("item=");
  if (!href) throw new Error("Variable row must be a shareable link");
  await page.goto(new URL(href, page.url()).href);
  const sheet = page.getByRole("dialog", { name: "APP_REGION", exact: true });
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(sheet).toBeVisible();
  const url = page.url();
  await page.keyboard.press("k");
  await expect(page).not.toHaveURL(url);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(url);
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/variables$/);
  await row.locator("[data-select-item]").click();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(confirmation).toBeHidden();
  await expect(sheet).toBeHidden();
  await expect(row.locator("[data-select-item]")).toBeFocused();
});
test("Back discards an unsubmitted secret replacement with its parent panel", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  const row = page.locator('[data-vault-item="ALICE_DEPLOY_TOKEN"]').filter({ visible: true });
  await row.locator("[data-select-item]").click();
  const sheet = page.getByRole("dialog", { name: "ALICE_DEPLOY_TOKEN", exact: true });
  await sheet.getByRole("button", { name: "Replace value" }).click();
  const replacement = page.getByRole("dialog", { name: "Replace ALICE_DEPLOY_TOKEN", exact: true });
  await replacement.getByLabel("Secret value").fill("disposable-unsubmitted-fixture");
  await page.evaluate(() => history.back());
  await expect(replacement).toBeHidden();
  await expect(sheet).toBeHidden();
  await expect(row.locator("[data-select-item]")).toBeFocused();
  await row.locator("[data-select-item]").click();
  await expect(replacement).toBeHidden();
  await sheet.getByRole("button", { name: "Replace value" }).click();
  await expect(replacement.getByLabel("Secret value")).toHaveValue("");
});

test("a delayed Edit read cannot reopen the editor after Back and reopening the same row", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  const row = page.locator('[data-vault-item="APP_REGION"]').filter({ visible: true });
  await row.locator("[data-select-item]").click();
  const sheet = page.getByRole("dialog", { name: "APP_REGION", exact: true });
  let release = () => {};
  let received = () => {};
  let finished = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    received = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(/\/variables(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
    finished();
  });
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await reading;
  await page.evaluate(() => history.back());
  await expect(sheet).toBeHidden();
  await row.locator("[data-select-item]").click();
  await expect(sheet).toBeVisible();
  release();
  await delivered;
  // The genuine response is applied, but its old intent must not reopen Edit.
  await expect(sheet.locator("[data-variable-value]")).toHaveText("eu-west-1");
  await expect(page.getByRole("dialog", { name: "Edit APP_REGION", exact: true })).toBeHidden();
});
