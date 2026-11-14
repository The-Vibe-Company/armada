import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

const hosts = [
  { id: "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2", name: "Office workstation", state: "online" },
  { id: "11111111-1111-4111-8111-111111111111", name: "Build machine", state: "offline" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Unfinished machine", state: "pending" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Retired machine", state: "revoked" },
].map((host) => ({
  ...host,
  createdAt: "2026-11-13T08:00:00Z",
  lastSeenAt: host.state === "pending" ? null : "2026-11-13T12:00:00Z",
  revokedAt: host.state === "revoked" ? "2026-11-13T12:00:00Z" : null,
  sandboxes: 0,
  version: null,
}));

async function seed(dockerHosts?: typeof hosts) {
  expect((await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ dockerHosts }) })).ok).toBe(
    true,
  );
}

test("provider overview presents cloud accounts and connected machines without setup ghosts", async ({ page }) => {
  await seed(hosts);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", "/providers/cloud");
  await expect(page.locator('[data-provider-row="boat"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Providers", exact: true, level: 1 })).toBeVisible();
  const machines = page.getByRole("list", { name: "Self-hosted machines", exact: true });
  await expect(machines).toContainText("Office workstation");
  await expect(machines).toContainText("Online");
  await expect(machines).toContainText("Build machine");
  await expect(machines).toContainText("Offline");
  await expect(machines).not.toContainText("Unfinished machine");
  await expect(machines).not.toContainText("Retired machine");
  await expect(page.getByRole("main")).not.toContainText("Unfinished setup");
  await expect(page.getByRole("heading", { name: "Cloud accounts", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Self-hosted machines", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: "View Office workstation" })).toHaveAttribute(
    "href",
    `/hosts?item=${hosts[0]?.id}`,
  );
  await page.screenshot({ path: "test-results/provider-overview-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/provider-overview-mobile.png", fullPage: true, animations: "disabled" });
  await page.locator('[data-provider-row="modal"]').getByRole("button", { name: "Connect Modal" }).click();
  await expect(page.getByLabel("Token ID", { exact: true })).toBeVisible();
});

test("members can view machine setup but cannot manage cloud accounts", async ({ page }) => {
  await seed([]);
  await signIn(page, "bob@example.com", "/providers/cloud");
  const machines = page.locator("[data-provider-machines]");
  await expect(machines).toContainText("Ask an organization admin");
  await expect(machines.getByRole("link", { name: "View machines" })).toHaveAttribute("href", "/hosts");
  await expect(page.getByRole("button", { name: "Connect Modal" })).toHaveCount(0);
  await expect(machines.getByRole("link", { name: "Manage machines" })).toHaveCount(0);
});

test("cloud-only deployments do not offer unavailable machine setup", async ({ page }) => {
  await seed();
  await signIn(page, "alice@example.com", "/providers/cloud");
  await expect(page.locator("[data-provider-machines]")).toHaveCount(0);
  await expect(page.locator('[data-provider-row="boat"]')).toBeVisible();
});

test("an unreadable machine list is partial evidence, not a new-machine empty state", async ({ page }) => {
  await seed([
    {
      id: "invalid",
      name: "Unreadable machine",
      state: "online",
      createdAt: "2026-11-13T08:00:00Z",
      lastSeenAt: null,
      revokedAt: null,
      sandboxes: 0,
      version: null,
    },
  ]);
  await signIn(page, "alice@example.com", "/providers/cloud");
  const machines = page.locator("[data-provider-machines]");
  await expect(machines).toContainText("Some machines could not be shown.");
  await expect(machines).toContainText("No machines available to show");
  await expect(machines).not.toContainText("No machines connected yet");
  await expect(machines.getByRole("link", { name: "View machines" })).toHaveAttribute("href", "/hosts");
  await expect(machines.getByRole("link", { name: "Manage machines" })).toHaveCount(0);
});

test("pending registrations are absent from the provider overview but remain manageable", async ({ page }) => {
  await seed(hosts.filter((host) => host.state === "pending"));
  await signIn(page, "alice@example.com", "/providers/cloud");
  const machines = page.locator("[data-provider-machines]");
  await expect(machines).toContainText("No machines connected yet");
  await expect(machines).not.toContainText("Unfinished");
  await expect(machines.getByRole("link", { name: "Manage machines", exact: true })).toHaveAttribute("href", "/hosts");
  await machines.getByRole("link", { name: "Manage machines", exact: true }).click();
  await page.getByRole("link", { name: "Unfinished setup (1)", exact: true }).click();
  await expect(page.getByRole("list", { name: "Docker hosts", exact: true })).toContainText("Unfinished machine");
});
