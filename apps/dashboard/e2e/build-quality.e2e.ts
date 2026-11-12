import { expect, test } from "@playwright/test";
import { goldenPanel, goldenRow, reset, signIn } from "./helpers";

test.beforeEach(reset);

for (const width of [1280, 390])
  for (const theme of ["light", "dark"]) {
    test(`Build details retain list width, correct accessible ownership and drafts (${width}, ${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await signIn(page, "alice@example.com", "/environments");
      for (const [route, label] of [
        ["environments", "Environments"],
        ["templates", "Templates"],
        ["tools", "Tools"],
        ["variables", "Variables and secrets"],
      ] as const) {
        await page.goto(`/${route}`);
        const list = page
          .getByRole("list", { name: label, exact: true, includeHidden: true })
          .filter({ visible: true });
        await expect(list).toBeVisible();
        const before = await list.boundingBox();
        const select = list.locator("[data-select-item]").first();
        await select.click();
        const panel = page.locator("[data-resource-panel]").filter({ visible: true });
        await expect(panel).toBeVisible();
        expect((await list.boundingBox())?.width).toBe(before?.width);
        expect(
          await panel.evaluate((node) => {
            const title = document.getElementById(node.getAttribute("aria-labelledby") ?? "");
            return title !== null && node.contains(title);
          }),
        ).toBe(true);
        await expect
          .poll(async () => {
            const bounds = await panel.boundingBox();
            return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
          })
          .toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(select).toBeFocused();
      }
    });
  }

test("a row's blank area selects it, and editing survives selection close and viewport changes", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  const row = goldenRow(page, "alice-private");
  const bounds = await row.boundingBox();
  await row.click({ position: { x: bounds!.width * 0.65, y: bounds!.height / 2 } });
  const panel = await goldenPanel(page, "alice-private");
  const repository = panel.getByRole("textbox", { name: "Repository 1", exact: true });
  await repository.fill("git@github.com:acme/draft.git");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(repository).toHaveValue("git@github.com:acme/draft.git");
  await page.keyboard.press("Escape");
  await goldenPanel(page, "alice-private");
  await expect(repository).toHaveValue("git@github.com:acme/draft.git");
});

test("shared scope radios support keyboard selection without granting organization writes to members", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/skills");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const personal = dialog.getByRole("radio", { name: "Personal", exact: true });
  await personal.focus();
  await page.keyboard.down("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Org (Acme)", exact: true })).toBeChecked();
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("Escape");
  await page.context().clearCookies();
  await signIn(page, "bob@example.com", "/skills");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Org (Acme)", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Personal", exact: true })).toBeChecked();
});

test("a refused org secret keeps kind/scope for retry but clears its one-time value", async ({ page }) => {
  await signIn(page, "alice@example.com", "/variables");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Secret", exact: true }).check();
  await dialog.getByRole("radio", { name: "Org (Acme)", exact: true }).check();
  await dialog.getByLabel("Name", { exact: true }).fill("BAD.NAME");
  await dialog.getByLabel("Secret value", { exact: true }).fill("discard-after-this-attempt");
  await dialog.getByRole("button", { name: "Store secret", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Secret", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Org (Acme)", exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("BAD.NAME");
  await expect(dialog.getByLabel("Secret value", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Name", { exact: true }).fill("RETRY_SCOPE_SECRET");
  await dialog.getByLabel("Secret value", { exact: true }).fill("new-value-for-retry");
  await dialog.getByRole("button", { name: "Store secret", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = page.locator('[data-vault-item="RETRY_SCOPE_SECRET"]');
  await expect(row).toHaveAttribute("data-vault-kind", "secret");
  await expect(row.getByText("Org", { exact: true })).toBeVisible();
});

test("list rows share their columns, whatever the width of each row's action", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await signIn(page, "alice@example.com", "/tools");
  const list = page.getByRole("list", { name: "Tools", exact: true });
  // Retry, Reconnect, Configure and no action at all: the state and fact columns still start at one x.
  const columns = await list.evaluate((node) =>
    [...node.children].map((row) =>
      [...row.children].slice(1, 3).map((cell) => Math.round(cell.getBoundingClientRect().left)),
    ),
  );
  expect(columns.length).toBeGreaterThan(3);
  expect(new Set(columns.map(([state]) => state)).size).toBe(1);
  expect(new Set(columns.map(([, fact]) => fact)).size).toBe(1);

  // On a phone a row without an action keeps the whole width for its name, not the widest action's column.
  await page.setViewportSize({ width: 390, height: 844 });
  const name = list.locator('[data-connection="Alice Linear"] [data-select-item] span');
  await expect(name).toHaveText("Alice Linear");
  expect(await name.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
