import { expect, type Page } from "@playwright/test";

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
