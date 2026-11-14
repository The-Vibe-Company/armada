import { expect, test } from "@playwright/test";
import { IDS, MOCK, signIn } from "./helpers";

const OPAQUE = `machine-${"opaque".repeat(30)}`;
const LONG_NAME = "Claude Code sandbox · Nov 8, 2026, 10:05:03 UTC";
const MISSING_NAME = "Codex sandbox · Nov 7, 2026, 09:00:00 UTC";

async function post(path: string, body: object) {
  expect((await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
test.beforeEach(async () => {
  await post("reset", {});
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: { provider_sandbox_id: OPAQUE, created_at: "2026-11-08T10:05:03Z" },
  });
  await post("sandbox-lifecycle", {
    id: IDS.failed,
    fields: { provider_sandbox_id: null, created_at: "2026-11-07T09:00:00Z" },
  });
});

test("opaque and missing provider identifiers have readable list names while short aliases stay intact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com");
  await expect(page.getByRole("link", { name: LONG_NAME, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: MISSING_NAME, exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/readable-names-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: LONG_NAME, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: MISSING_NAME, exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/readable-names-mobile.png", fullPage: true, animations: "disabled" });
  await expect(page.getByRole("link", { name: "bx_bob_secret", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Actions for ${LONG_NAME}`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: OPAQUE, exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search sandboxes" }).fill("Claude Code sandbox");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: "bx_bob_secret", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: LONG_NAME, exact: true })).toBeVisible();
});

test("restricted names use public metadata without opening the sandbox", async ({ page }) => {
  await signIn(page, "bob@example.com");
  const row = page.getByRole("row").filter({ hasText: LONG_NAME });
  await expect(row.getByText(LONG_NAME, { exact: true })).toBeVisible();
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(row.getByRole("button", { name: `Actions for ${LONG_NAME}`, exact: true })).toBeVisible();
});

test("preserved underscore aliases wrap inside a phone row rather than clipping", async ({ page }) => {
  const alias = "MMMMMMMM_MMMMMMMM_MMMMMMMM_MMMMMMMM_MMMMMMMM";
  await post("sandbox-lifecycle", { id: IDS.bobSecret, fields: { provider_sandbox_id: alias } });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "alice@example.com");
  const name = page.getByText(alias, { exact: true });
  await expect(name).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: alias });
  const edge = await row.evaluate((element) => element.getBoundingClientRect().right);
  expect(await name.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(edge);
});
