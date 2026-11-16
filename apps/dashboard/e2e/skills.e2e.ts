import { expect, type Page, test } from "@playwright/test";
import { alert, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

/** Disposable values in the Skillpack format: they must never come back from the server or stay in the page. */
const KEY = `cmp_pat_${"5e".repeat(24)}`;
const ORG_KEY = `cmp_pat_${"0c".repeat(24)}`;
const ACME = "00000000-0000-4000-8000-000000000010";

const row = (page: Page, scope: "user" | "org") => page.locator(`[data-skillpack-key="${scope}"]`);

async function openDetails(page: Page, scope: "user" | "org") {
  const close = page.getByRole("button", { name: "Close details", exact: true });
  if (await close.isVisible()) await close.click();
  await row(page, scope).getByRole("button").click();
  const drawer = page.getByRole("dialog", {
    name: scope === "user" ? "Your Skillpack key" : "The organization’s key",
    exact: true,
  });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function calls(): Promise<{ route: string; body: Record<string, unknown> }[]> {
  const { calls } = await (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: "{}" })).json();
  return calls.filter((call: { route: string }) => call.route === "creds/set" || call.route === "creds/rm");
}

async function stored(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = await (await fetch(`${MOCK}/__test/credentials`, { method: "POST" })).json();
  return rows.filter((item) => item.kind === "skillpack");
}

async function openAdd(page: Page) {
  await page.getByRole("button", { name: "Add a key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Skillpack key" });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const [device, width, height] of [
  ["laptop", 1280, 720],
  ["tablet", 768, 1024],
  ["phone", 390, 844],
] as const) {
  test(`Skills shows both keys and adds one in a dialog that fits (${device})`, async ({ page }) => {
    const mobile = device === "phone";
    await page.setViewportSize({ width, height });
    await signIn(page, "alice@example.com", "/skills");
    const nav = page.getByRole("navigation", { name: "Main" });
    if (mobile) await page.getByRole("button", { name: /Navigation/ }).click();
    await expect(nav.getByRole("link", { name: /Skills/ })).toHaveAttribute("aria-current", "page");
    if (mobile) await page.keyboard.press("Escape");
    await expect(row(page, "user")).toContainText("Not set");
    await expect(row(page, "org")).toContainText("Not set");
    await expect(row(page, "org")).toContainText("Everyone in Acme");
    // Each card stays inspectable at any width; key actions live in its drawer.
    await expect(row(page, "org").getByRole("button")).toBeInViewport({ ratio: 1 });

    const dialog = await openAdd(page);
    // Least privilege is advice, not a restriction on valid keys.
    await expect(dialog.locator("[data-skillpack-scope-note]")).toContainText("skills:read");
    await expect(dialog.locator("[data-skillpack-scope-note]")).toContainText("recommend a read-only key");
    await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeChecked();
    if (!mobile) await expect(dialog.getByRole("button", { name: "Store key" })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add a key", exact: true })).toBeFocused();
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

  // Replace from the details drawer: the same dialog, on that scope, says it replaces the stored key and starts empty.
  let details = await openDetails(page, "user");
  await details.getByRole("button", { name: "Replace your Skillpack key" }).click();
  dialog = page.getByRole("dialog", { name: "Add a Skillpack key" });
  await expect(dialog.locator("[data-skillpack-replaces]")).toContainText("replaces the personal key");
  await expect(dialog.getByLabel("Key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Key", { exact: true }).fill(ORG_KEY);
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(dialog).toBeHidden();
  expect(await stored()).toHaveLength(1);

  // The organization's key, by its admin.
  details = await openDetails(page, "org");
  await details.getByRole("button", { name: "Add the organization's Skillpack key" }).click();
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeChecked();
  await dialog.getByLabel("Key", { exact: true }).fill(ORG_KEY);
  await dialog.getByRole("button", { name: "Store key" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "org")).toHaveAttribute("data-skillpack-state", "active");

  details = await openDetails(page, "user");
  await details.getByRole("button", { name: "Remove your Skillpack key" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("the organization's key");
  await confirm.getByRole("button", { name: "Remove key" }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page, "user")).toHaveAttribute("data-skillpack-state", "not-set");
  await expect(row(page, "user").getByRole("button")).toBeFocused();
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
  const details = await openDetails(page, "org");
  await expect(details).toContainText("Only an admin changes it.");
  await expect(details.getByRole("button", { name: /^(Add|Replace|Remove) .*Skillpack key$/ })).toHaveCount(0);
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  const dialog = await openAdd(page);
  await expect(dialog.getByRole("radio", { name: /Org \(Acme\)/ })).toBeDisabled();
});

test("an unconfirmed key change hides diagnostics and still clears the pasted key", async ({ page }) => {
  await signIn(page, "alice@example.com", "/skills");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Key", { exact: true }).fill(KEY);
  const diagnostic = "HTTP 503: credential_enc scope_id digest sha256:example";
  expect(
    (
      await fetch(`${MOCK}/__test/fail-next-skillpack`, {
        method: "POST",
        body: JSON.stringify({ message: diagnostic }),
      })
    ).ok,
  ).toBe(true);
  await dialog.getByRole("button", { name: "Store key", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reload Skills");
  await expect(dialog.getByRole("alert")).not.toContainText(diagnostic);
  await expect(dialog.getByLabel("Key", { exact: true })).toHaveValue("");
  expect(await page.content()).not.toContain(KEY);
  expect(await stored()).toHaveLength(0);
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/skill-action-after-${name}.png`, fullPage: true });
  }
  await dialog.getByLabel("Key", { exact: true }).fill(KEY);
  await dialog.getByRole("button", { name: "Store key", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "user")).toHaveAttribute("data-skillpack-state", "active");
});
