import { expect, test } from "@playwright/test";
import { alert, IDS, LABELS, MOCK, signIn } from "./helpers";

const ACME = "00000000-0000-4000-8000-000000000010";
const ZENITH = "00000000-0000-4000-8000-000000000011";
const THIRD = "00000000-0000-4000-8000-000000000098";

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ multiOrg: true }) });
});

for (const mobile of [false, true]) {
  test(`choosing an org switches at once and persists from a detail (${mobile ? "mobile keyboard" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const select = page.getByLabel("Active organization");
    await expect(select).toHaveValue(ACME);
    if (mobile) {
      // Stepping with an arrow key previews the next org without leaving the page: Escape or leaving the selector
      // drops the preview, Enter switches to it.
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await expect(select).toHaveValue(ZENITH);
      await page.keyboard.press("Escape");
      await expect(select).toHaveValue(ACME);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Tab");
      await expect(select).toHaveValue(ACME);
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await expect(select).toHaveAccessibleDescription(/Press Enter to switch/);
      await expect(page).toHaveURL(new RegExp(`/sandboxes/${IDS.running}$`));
      await page.keyboard.press("Enter");
    } else {
      // Hold the switch in flight: the selector shows the chosen org, busy, and a second choice starts nothing.
      const actions: string[] = [];
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/*", async (route) => {
        if (route.request().headers()["next-action"]) {
          actions.push(route.request().postData() ?? "");
          await held;
        }
        await route.continue();
      });
      // A third org to choose meanwhile: not the one shown, so only the lock can refuse it.
      await select.evaluate((element: HTMLSelectElement, org) => element.append(new Option("Third", org)), THIRD);
      await select.selectOption(ZENITH);
      await expect(select).toHaveAttribute("aria-busy", "true");
      // A busy selector is not disabled (it keeps its focus), so a choice can still reach it, as a person's would.
      await select.evaluate((element: HTMLSelectElement, org) => {
        element.value = org;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, THIRD);
      await expect(select).toHaveValue(ZENITH);
      release();
      await expect(select).toHaveAttribute("aria-busy", "false");
      expect(actions).toHaveLength(1);
      expect(actions[0]).toContain(ZENITH);
      await page.unroute("**/*");
    }
    await expect(page).toHaveURL(/\/sandboxes$/);
    await expect(select).toHaveValue(ZENITH);
    if (mobile) await expect(select).toBeFocused();
    await expect(page.getByRole("link", { name: LABELS.zenith })).toBeVisible();
    await expect(page.getByText(LABELS.running)).toHaveCount(0);
    await expect(
      page.getByLabel("Owner", { exact: true }).getByRole("option", { name: "bob@example.com" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(select).toHaveValue(ZENITH);
    await page.goto("/goldens");
    await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
    await expect(page.locator('[data-golden="shared-golden"]')).toHaveCount(0);
    await page.goto("/credentials");
    await expect(page.locator('[data-credentials="user"]')).toBeVisible();
    await expect(page.locator('[data-credentials="Zenith (org)"]')).toBeVisible();
    await expect(page.locator('[data-credentials="Acme (org)"]')).toHaveCount(0);
    await page.screenshot({ path: `test-results/organization-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.goto("/sandboxes?golden=00000000-0000-4000-8000-000000000023");
    await select.selectOption(ACME);
    await expect(page).toHaveURL(/\/sandboxes$/);
    await expect(page.getByRole("link", { name: LABELS.running })).toBeVisible();
  });
}

test("forged and removed preferences fall back; forged switch is refused server-side", async ({ page, context }) => {
  await signIn(page, "alice@example.com");
  const select = page.getByLabel("Active organization");
  await select.evaluate((element) => {
    const option = document.createElement("option");
    option.value = "00000000-0000-4000-8000-000000000099";
    option.text = "Forged";
    element.append(option);
  });
  await select.selectOption("00000000-0000-4000-8000-000000000099");
  await expect(alert(page)).toContainText("no longer available");
  // A refused switch does not keep showing the refused org: the selector is back on the org the page shows.
  await expect(select).toHaveValue(ACME);
  await expect(select).toHaveAccessibleDescription(/no longer available/);
  await context.addCookies([{ name: "armada-org", value: "forged", url: page.url() }]);
  await page.reload();
  await expect(select).toHaveValue(ACME);
  await select.selectOption(ZENITH);
  await expect(select).toHaveValue(ZENITH);
  // The chosen option shows before the switch is saved; Zenith's sandbox shows only once it is.
  await expect(page.getByRole("link", { name: LABELS.zenith })).toBeVisible();
  await fetch(`${MOCK}/__test/remove-zenith-membership`, { method: "POST" });
  await page.reload();
  await expect(select).toHaveValue(ACME);
  await expect(page.getByText(LABELS.zenith)).toHaveCount(0);
});

test("mutation targets cannot escape the selected org even when the viewer administers the other org", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByLabel("Active organization").selectOption(ZENITH);
  await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
  const golden = page.locator('[data-golden="zenith-golden"]');
  await golden.locator('input[name="golden"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000020";
  });
  await golden.getByRole("button", { name: "Make private" }).click();
  await expect(alert(page)).toContainText("not available in this scope");
  await page.reload();
  await page.getByRole("button", { name: "Launch from zenith-golden" }).click();
  const launch = page.getByRole("dialog");
  await launch.locator('input[name="org"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000010";
  });
  await launch.locator('input[name="golden"]').evaluate((input) => {
    (input as HTMLInputElement).value = "shared-golden";
  });
  await launch.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(launch.getByRole("alert")).toContainText("Switch to that organization first");
  await page.goto("/credentials");
  // The generic one-value form of the personal section (its Modal token form is separate).
  const personal = page
    .locator('[data-credentials="user"] form')
    .filter({ has: page.getByRole("button", { name: "Save credential" }) });
  await personal.locator('input[name="scope"]').evaluate((input) => {
    (input as HTMLInputElement).value = "org";
  });
  await personal.locator('input[name="owner"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000010";
  });
  await personal.getByLabel("Value", { exact: true }).fill("throwaway-test-value");
  await personal.getByRole("button", { name: "Save credential" }).click();
  await expect(alert(page)).toContainText("Switch to that organization first");
});

test("without memberships the shell offers organization setup and no scoped resources", async ({ page }) => {
  await signIn(page, "carol@example.com");
  await expect(page.getByRole("link", { name: "Create an organization", exact: true })).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveCount(0);
  await expect(page.getByRole("link", { name: LABELS.running })).toHaveCount(0);
  await page.getByRole("link", { name: "Create an organization", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create org", exact: true })).toBeVisible();
});
