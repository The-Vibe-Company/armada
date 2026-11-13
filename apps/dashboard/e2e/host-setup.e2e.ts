import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

const ONLINE = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const PENDING = "11111111-1111-4111-8111-111111111111";
const hosts = [
  { id: ONLINE, name: null, state: "online", lastSeenAt: "2026-11-13T12:00:00Z", sandboxes: 2 },
  { id: PENDING, name: "Office workstation", state: "pending", lastSeenAt: null, sandboxes: 0 },
].map((host) => ({ ...host, createdAt: "2026-11-13T08:00:00Z", revokedAt: null, version: null }));

test.beforeEach(async () => {
  const response = await fetch(`${MOCK}/__test/reset`, {
    method: "POST",
    body: JSON.stringify({ dockerHosts: hosts }),
  });
  expect(response.ok).toBe(true);
});

// Owns the Hosts screen's grouping, not host state classification (docker-hosts.test.ts).
test("unfinished installations stay out of Machines but remain reachable for cleanup", async ({ page }) => {
  await signIn(page, "alice@example.com", "/hosts");
  const list = page.getByRole("list", { name: "Docker hosts", exact: true });
  await page.screenshot({ path: "test-results/host-setup-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/host-setup-mobile.png", animations: "disabled" });
  await expect(list.locator(`[data-host="${ONLINE}"]`)).toContainText("Unnamed machine");
  await expect(list.locator(`[data-host="${PENDING}"]`)).toHaveCount(0);
  await expect(page.getByText("Host 70bde9cd", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Unfinished setup (1)" }).click();
  await expect(list.locator(`[data-host="${PENDING}"]`)).toContainText("Office workstation");
  await expect(list.locator(`[data-host="${ONLINE}"]`)).toHaveCount(0);
  await expect(page.getByText(/These machines have not connected yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke Office workstation", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Machines", exact: true }).click();
  await expect(list.locator(`[data-host="${ONLINE}"]`)).toBeVisible();
});

test("an existing link to unfinished setup still opens its details", async ({ page }) => {
  await signIn(page, "alice@example.com", `/hosts?item=${PENDING}`);
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Office workstation");
  await expect(panel.getByRole("button", { name: "Copy host ID" })).toBeVisible();
});
