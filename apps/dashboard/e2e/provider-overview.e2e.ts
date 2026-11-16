import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const hosts = [
  {
    id: HOST,
    name: "Office workstation",
    state: "online",
    createdAt: "2026-11-13T08:00:00Z",
    lastSeenAt: "2026-11-13T12:00:00Z",
    revokedAt: null,
    sandboxes: 0,
    version: null,
    canManageLimits: true,
    limitsSupported: true,
    retentionSeconds: 86400,
    running: 0,
    resources: {
      machine: { cpus: 16, memoryBytes: 34359738368 },
      perSandbox: { cpus: 4, memoryBytes: 8589934592, pids: 4096 },
      capacity: 4,
      heldBack: 0,
      mode: "automatic",
    },
  },
];

test.beforeEach(async () => {
  expect(
    (await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ dockerHosts: hosts }) })).ok,
  ).toBe(true);
});

// Owns Machines' catalog navigation and existing controls; state parsing stays in docker-hosts.test.ts.
test("Machines keeps cloud and host actions in catalog drawers at desktop and mobile sizes", async ({ page }) => {
  await signIn(page, "alice@example.com", "/providers/cloud");
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cloud providers", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Docker hosts", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await page.getByRole("button", { name: "View Boat", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Replace key");
  await page.getByRole("button", { name: "Close details" }).click();
  const host = page.getByRole("button", { name: "View Office workstation", exact: true });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await host.click();
    await expect(page).toHaveURL(new RegExp(`item=${HOST}`));
    await expect(page.getByRole("dialog")).toContainText("Cleanup retention");
    await expect(page.getByRole("dialog")).toContainText("Limits and usage");
    await page.getByRole("dialog").getByLabel("Retention in seconds", { exact: false }).fill("3600");
    await page.keyboard.press("Escape");
    await host.click();
    await expect(page.getByRole("dialog").getByLabel("Retention in seconds", { exact: false })).toHaveValue("3600");
    await page.keyboard.press("Escape");
    await expect(host).toBeFocused();
  }
  await page.getByRole("button", { name: "Register a Docker host", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Register a Docker host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get install command" })).toBeVisible();
});

test("a direct machine link restores card focus on close and members cannot manage cloud keys", async ({ page }) => {
  await signIn(page, "bob@example.com", `/providers/cloud?item=${HOST}`);
  await expect(page.getByRole("dialog")).toContainText("Office workstation");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "View Office workstation", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "View Boat", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Replace key" })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Disconnect" })).toHaveCount(0);
});
