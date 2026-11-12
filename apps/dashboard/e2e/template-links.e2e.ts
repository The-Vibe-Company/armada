import { expect, test } from "@playwright/test";
import { goldenPanel, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

// Owns the new relationship navigation at its browser boundary: real selected-item URLs,
// caller-visible names only, keyboard navigation and phone sheet layout; no test-only app seams.
for (const phone of [false, true]) {
  test(`template ingredients open their resources and environments link back (${phone ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: phone ? 390 : 1280, height: phone ? 844 : 900 });
    await signIn(page, "alice@example.com", "/templates?item=00000000-0000-4000-8000-000000000090");
    const panel = page.locator('[data-template-panel="Backend with docs"]');
    const environment = panel.getByRole("link", { name: "shared-golden on Boat", exact: true });
    const tool = panel.getByRole("link", { name: "Acme Docs", exact: true });
    const variable = panel.getByRole("link", { name: "APP_REGION", exact: true });
    await expect(tool).toHaveAttribute("href", "/tools?item=00000000-0000-4000-8000-000000000060");
    await expect(variable).toHaveAttribute("href", "/variables?item=variable-00000000-0000-4000-8000-000000000080");
    await expect(panel.getByRole("link", { name: /Claude Code/ })).toHaveAttribute("href", "/harness");
    await page.screenshot({
      path: `test-results/template-links-${phone ? "phone" : "desktop"}.png`,
      animations: "disabled",
    });
    await environment.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/environments\?item=00000000-0000-4000-8000-000000000020$/);
    const usage = page.locator('[data-golden-panel="shared-golden"] [data-environment-templates]');
    await expect(usage).toContainText("Used by 1 visible template.");
    await expect(usage).not.toContainText("Bob scratch");
    await usage.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/environment-template-links-${phone ? "phone" : "desktop"}.png`,
      animations: "disabled",
    });
    await usage.getByRole("link", { name: "Backend with docs", exact: true }).click();
    await expect(panel).toBeVisible();
    await variable.click();
    await expect(page.locator('[data-vault-panel="APP_REGION"]')).toBeVisible();
    const reverseUsage = page.locator("[data-template-usage]").filter({ visible: true });
    await expect(reverseUsage).toContainText("Used by 2 visible templates.");
    await reverseUsage.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/library-variable-usage-${phone ? "phone" : "desktop"}.png`,
      animations: "disabled",
    });
    await reverseUsage.getByRole("link", { name: "Backend with docs", exact: true }).click();
    await tool.click();
    await expect(page.locator('[data-connection-panel="Acme Docs"]')).toBeVisible();
    await expect(reverseUsage).toContainText("Used by 1 visible template.");
    await reverseUsage.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/library-tool-usage-${phone ? "phone" : "desktop"}.png`,
      animations: "disabled",
    });
    await page.goBack();
    await variable.click();
    await expect(page).toHaveURL(/\/variables\?item=variable-00000000-0000-4000-8000-000000000080$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1280);
  });
}

test("an unreadable template revision makes usage partial, never a false zero", async ({ page }) => {
  const response = await fetch(`${MOCK}/__test/reset`, {
    method: "POST",
    body: JSON.stringify({ missingTemplateRevision: true }),
  });
  expect(response.ok).toBe(true);
  await signIn(page, "alice@example.com", "/environments");
  const shared = await goldenPanel(page, "shared-golden");
  await expect(shared.locator("[data-environment-templates]")).toContainText("Used by at least 1 visible template.");
  await page.keyboard.press("Escape");
  const modal = await goldenPanel(page, "modal-golden");
  await expect(modal.locator("[data-environment-templates]")).toContainText(
    "No matches in the revisions that could be read.",
  );
  await expect(modal.locator("[data-environment-templates]")).toContainText(
    "Some template revisions could not be read.",
  );
});

// Secret/skill references are metadata, not values or a new skill-picker flow.
test("secret and skill ingredients link to their existing management pages without reading values", async ({
  page,
}) => {
  const response = await fetch(`${MOCK}/__test/reset`, {
    method: "POST",
    body: JSON.stringify({ templateReferenceExtras: true }),
  });
  expect(response.ok).toBe(true);
  await signIn(page, "alice@example.com", "/templates?item=00000000-0000-4000-8000-000000000090");
  const panel = page.locator('[data-template-panel="Backend with docs"]');
  await expect(panel.getByRole("link", { name: "STRIPE_API_KEY", exact: true })).toHaveAttribute(
    "href",
    "/variables?item=secret-00000000-0000-4000-8000-000000000081",
  );
  await expect(panel.getByRole("link", { name: "notes@1.0.0", exact: true })).toHaveAttribute("href", "/skills");
  await expect(panel).toContainText("Manage Skillpack access on the Skills page.");
  await expect(page.locator("body")).not.toContainText("sk_e2e_seeded_org_secret");
  await panel.getByRole("link", { name: "STRIPE_API_KEY", exact: true }).click();
  const usage = page.locator("[data-template-usage]").filter({ visible: true });
  await expect(usage).toContainText("Used by 1 visible template.");
  await page.goto("/skills");
  await expect(page.getByRole("heading", { name: "Templates using skills", exact: true })).toBeVisible();
  await expect(usage.getByRole("link", { name: "Backend with docs", exact: true })).toHaveAttribute(
    "href",
    "/templates?item=00000000-0000-4000-8000-000000000090",
  );
});

// The sheet can clip a row even when document width is correct. Check the actual
// text fragments and version bounds, not class names or only viewport overflow.
test("128-character variable and secret keys wrap completely beside their versions on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await fetch(`${MOCK}/__test/reset`, {
    method: "POST",
    body: JSON.stringify({ longTemplateKeys: true }),
  });
  expect(response.ok).toBe(true);
  await signIn(page, "alice@example.com", "/templates?item=00000000-0000-4000-8000-000000000090");
  const panel = page.locator('[data-template-panel="Backend with docs"]');
  for (const [key, version] of [
    ["V".repeat(128), "v3"],
    ["S".repeat(128), "v1"],
  ] as const) {
    const link = panel.getByRole("link", { name: key, exact: true });
    await link.scrollIntoViewIfNeeded();
    const row = panel.getByRole("listitem").filter({ has: page.getByRole("link", { name: key, exact: true }) });
    await expect(row.getByText(version, { exact: true })).toBeInViewport();
    const metrics = await link.evaluate((element) => {
      const row = element.closest("li");
      if (!row || !element.nextElementSibling) throw new Error("Missing ingredient/version row");
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = element.getBoundingClientRect();
      return {
        lines: range.getClientRects().length,
        textFits: [...range.getClientRects()].every(
          (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
        ),
        linkOverflow: element.scrollWidth - element.clientWidth,
        rowOverflow: row.scrollWidth - row.clientWidth,
        versionRight: element.nextElementSibling.getBoundingClientRect().right,
        rowRight: row.getBoundingClientRect().right,
      };
    });
    expect(metrics.lines).toBeGreaterThan(1);
    expect(metrics.textFits).toBe(true);
    expect(metrics.linkOverflow).toBeLessThanOrEqual(1);
    expect(metrics.rowOverflow).toBeLessThanOrEqual(1);
    expect(metrics.versionRight).toBeLessThanOrEqual(metrics.rowRight + 1);
  }
  await page.screenshot({ path: "test-results/template-links-long-keys-phone.png", animations: "disabled" });
});
