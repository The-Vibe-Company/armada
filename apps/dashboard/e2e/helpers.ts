import { expect, type Locator, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:54399";
export const IDS = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  running: "00000000-0000-4000-8000-000000000030",
  failed: "00000000-0000-4000-8000-000000000031",
  bobSecret: "00000000-0000-4000-8000-000000000032",
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
