import { expect, type Page, test } from "@playwright/test";
import { alert, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

/** Disposable values in the Skillpack format: they must never come back from the server or stay in the page. */
const KEY = `cmp_pat_${"5e".repeat(24)}`;
const ORG_KEY = `cmp_pat_${"0c".repeat(24)}`;
const ACME = "00000000-0000-4000-8000-000000000010";

const row = (page: Page, scope: "user" | "org") => page.locator(`[data-skillpack-key="${scope}"]`);

async function calls(): Promise<{ route: string; body: Record<string, unknown> }[]> {
  const { calls } = await (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: "{}" })).json();
  return calls.filter((call: { route: string }) => call.route === "creds/set" || call.route === "creds/rm");
}

async function stored(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = await (await fetch(`${MOCK}/__test/credentials`, { method: "POST" })).json();
  return rows.filter((item) => item.kind === "skillpack");
}

async function openAdd(page: Page) {
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Skillpack key" });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const [device, width, height] of [
  ["laptop", 1280, 720],
  ["tablet", 768, 1024],
  ["phone", 390, 844],
] as const) {
  test(`Build > Skills shows both keys and adds one in a dialog that fits (${device})`, async ({ page }) => {
    const mobile = device === "phone";
    await page.setViewportSize({ width, height });
    await signIn(page, "alice@example.com", "/skills");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: /Skills/ })).toHaveAttribute("aria-current", "page");
    await expect(row(page, "user")).toContainText("Not set");
    await expect(row(page, "org")).toContainText("Not set");
    await expect(row(page, "org")).toContainText("Acme key");
    // Every row's action stays on screen at any width.
    await expect(row(page, "org").getByRole("button", { name: "Add the organization's Skillpack key" })).toBeInViewport(
      {
        ratio: 1,
      },
    );

    const dialog = await openAdd(page);
    // Least privilege is advice, not a restriction on valid keys.
    await expect(dialog.locator("[data-skillpack-scope-note]")).toContainText("skills:read");
    await expect(dialog.locator("[data-skillpack-scope-note]")).toContainText("recommend a read-only key");
    await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeChecked();
    if (!mobile) await expect(dialog.getByRole("button", { name: "Store key" })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add key", exact: true })).toBeFocused();
  });
}

test("a key is stored write-only: never in an answer, the page or the form afterwards; replaced and removed", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/skills");
  let dialog = await openAdd(page);
  const field = dialog.getByLabel("Key", { exact: true });
  await expect(field).toHaveAttribute("type", "password");

  // A malformed key is refused before anything is sent, without repeating it.
  await field.fill("not-a-skillpack-key");
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(alert(page)).toContainText("cmp_pat_");
  await expect(alert(page)).not.toContainText("not-a-skillpack-key");
  expect(await calls()).toEqual([]);

  await field.fill(KEY);
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-slot=toast-title]", { hasText: "Your Skillpack key is stored." })).toBeVisible();
  await expect(row(page, "user")).toHaveAttribute("data-skillpack-state", "active");
  await expect(row(page, "user")).toContainText("value hidden");
  expect(await calls()).toEqual([
    { route: "creds/set", body: { scope: "user", org: ACME, kind: "skillpack", value: "[sent]" } },
  ]);
  const sealed = await stored();
  expect(sealed).toHaveLength(1);
  expect(JSON.stringify(sealed)).not.toContain(KEY);
  expect(await page.content()).not.toContain(KEY);

  // Replace from the row: the same dialog, on that scope, says it replaces the stored key and starts empty.
  await row(page, "user").getByRole("button", { name: "Replace your Skillpack key" }).click();
  dialog = page.getByRole("dialog", { name: "Add a Skillpack key" });
  await expect(dialog.locator("[data-skillpack-replaces]")).toContainText("replaces the personal key");
  await expect(dialog.getByLabel("Key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Key", { exact: true }).fill(ORG_KEY);
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(dialog).toBeHidden();
  expect(await stored()).toHaveLength(1);

  // The organization's key, by its admin.
  await row(page, "org").getByRole("button", { name: "Add the organization's Skillpack key" }).click();
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeChecked();
  await dialog.getByLabel("Key", { exact: true }).fill(ORG_KEY);
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "org")).toHaveAttribute("data-skillpack-state", "active");

  await row(page, "user").getByRole("button", { name: "Remove your Skillpack key" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("the organization's key");
  await confirm.getByRole("button", { name: "Remove key" }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page, "user")).toHaveAttribute("data-skillpack-state", "not-set");
  await expect(row(page, "user").getByRole("button", { name: "Add your Skillpack key" })).toBeFocused();
  expect((await calls()).map((call) => [call.route, call.body.scope])).toEqual([
    ["creds/set", "user"],
    ["creds/set", "user"],
    ["creds/set", "org"],
    ["creds/rm", "user"],
  ]);
  expect(await stored()).toMatchObject([{ scope: "org" }]);
});

test("a member sees the organization's key but only an admin changes it", async ({ page }) => {
  await fetch(`${MOCK}/__test/accounts`, {
    method: "POST",
    body: JSON.stringify({
      seed: [
        {
          id: crypto.randomUUID(),
          scope: "org",
          owner_id: ACME,
          kind: "skillpack",
          value_enc: "\\x0102",
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
          status: "revoked",
        },
      ],
    }),
  });
  await signIn(page, "bob@example.com", "/skills");
  await expect(row(page, "org")).toHaveAttribute("data-skillpack-state", "unusable");
  await expect(row(page, "org")).toContainText("Expired or revoked");
  await expect(row(page, "org")).toContainText("Only an admin changes it.");
  await expect(row(page, "org").getByRole("button")).toHaveCount(0);
  const dialog = await openAdd(page);
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeDisabled();
});
