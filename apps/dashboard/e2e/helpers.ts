import { expect, type Locator, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:54399";
export const IDS = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  running: "00000000-0000-4000-8000-000000000030",
  failed: "00000000-0000-4000-8000-000000000031",
  bobSecret: "00000000-0000-4000-8000-000000000032",
  zenith: "00000000-0000-4000-8000-000000000033",
  zenithCarol: "00000000-0000-4000-8000-000000000034",
};

/** How the list names a sandbox: the #680 metadata's provider display ID. */
export const LABELS = {
  running: "bx_alice_running",
  failed: "bx_alice_failed",
  bobSecret: "bx_bob_secret",
  zenith: "bx_zenith",
};

/** The alert of the page itself, not the route announcer Next adds. */
export function alert(page: Page) {
  return page.locator('p[role="alert"]');
}

export async function reset(): Promise<void> {
  const response = await fetch(`${MOCK}/__test/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
}

/** Signs in through the real login form: the mock accepts the code 123456 for its known users. */
export async function signIn(page: Page, email: string, next = "/sandboxes"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**${next}`);
}

/** Opens the launch dialog of a golden and its Advanced area, where the overrides live. */
export async function openLaunch(page: Page, golden: string, { advanced = true } = {}): Promise<Locator> {
  await page.getByRole("button", { name: `Launch from ${golden}` }).click();
  const dialog = page.getByRole("dialog");
  if (advanced) await dialog.locator("[data-launch-advanced] > summary").click();
  return dialog;
}

/** An environment's row in the list; a name may exist once on each provider. */
export function goldenRow(page: Page, name: string, provider?: "boat" | "modal"): Locator {
  return page.locator(`[data-golden="${name}"]${provider ? `[data-golden-provider="${provider}"]` : ""}`);
}

/** Selects an environment's row, unless its detail panel already shows, and returns the panel. */
export async function goldenPanel(page: Page, name: string, provider?: "boat" | "modal"): Promise<Locator> {
  const panel = page.locator(`[data-golden-panel="${name}"]${provider ? `[data-golden-provider="${provider}"]` : ""}`);
  if (!(await panel.isVisible())) {
    await leaveCreate(page);
    await goldenRow(page, name, provider).locator("[data-select-item]").click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** Goes back from the create view to the list, when the create view shows. */
export async function leaveCreate(page: Page): Promise<void> {
  const view = page.locator("[data-create-view]");
  if (!(await view.isVisible())) return;
  await view.getByRole("button", { name: /^Back to / }).click();
  await expect(view).toBeHidden();
}

/** Opens the create view, and its form when Boat is full and it starts folded; returns the create form. */
export async function openCreate(page: Page): Promise<Locator> {
  const form = page.locator('form[data-golden-form="create"]');
  if (!(await page.locator('[data-panel="new"]').isVisible()))
    await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator('[data-panel="new"]')).toBeVisible();
  if (!(await form.isVisible())) await page.getByText("Show the create form").click();
  await expect(form).toBeVisible();
  return form;
}
