import { expect, type Page, test } from "@playwright/test";
import { IDS, MOCK, signIn } from "./helpers";

const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const NAME = "workstation-task";
async function post(path: string, body: object) {
  expect((await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
async function seed({ hosts = true, expired = false } = {}) {
  await post("reset", {
    dockerHosts: hosts
      ? [
          {
            id: HOST,
            name: "Office workstation",
            state: "online",
            createdAt: "2026-11-13T08:00:00Z",
            lastSeenAt: "2026-11-13T12:00:00Z",
            revokedAt: null,
            sandboxes: 1,
            version: null,
          },
        ]
      : undefined,
  });
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      provider: "docker",
      golden_id: null,
      docker_host_id: HOST,
      provider_sandbox_id: NAME,
      status: "stopped",
      status_reason: "idle_paused",
      expires_at: new Date(Date.now() + (expired ? -1 : 1) * 3600_000).toISOString(),
    },
  });
  await post("add-sandboxes", {
    rows: [{ id: "00000000-0000-4000-8000-000000000709", provider_sandbox_id: "waiting-example", status: "ready" }],
  });
}
function row(page: Page) {
  return page.getByRole("row").filter({ hasText: NAME });
}

test("the list names readable Docker hosts and explains paused and waiting states without hovering", async ({
  page,
}) => {
  await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com");
  await expect(row(page).getByText("Office workstation", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(row(page).getByText("Wakes when you message", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/list-hosts-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row(page).getByText("Office workstation", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(row(page).getByText("Wakes when you message", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/list-hosts-mobile.png", fullPage: true, animations: "disabled" });
  await expect(row(page)).toContainText("Office workstation");
  await expect(row(page)).toContainText("Wakes when you message");
  await expect(page.getByRole("row").filter({ hasText: "waiting-example" })).toContainText("Waiting for you");
  await expect(row(page)).not.toContainText(HOST);
});

test("another member sees sandbox metadata but no private machine association", async ({ page }) => {
  await seed();
  await signIn(page, "bob@example.com");
  await expect(row(page)).toContainText("Machine details private");
  await expect(row(page).getByLabel("Paused to save resources", { exact: true })).toBeVisible();
  await expect(row(page)).not.toContainText("Office workstation");
  await expect(row(page)).not.toContainText("Wakes when you message");
  await expect(row(page).getByRole("link")).toHaveCount(0);
});

test("an unavailable host listing does not break the sandbox list or invent a machine name", async ({ page }) => {
  await seed({ hosts: false });
  await signIn(page, "alice@example.com");
  await expect(row(page)).toContainText("Machine name unavailable");
  await expect(row(page)).not.toContainText(HOST);
});

test("an expired idle pause never promises to wake on the next message", async ({ page }) => {
  await seed({ expired: true });
  await signIn(page, "alice@example.com");
  await expect(row(page)).toContainText("Office workstation");
  await expect(row(page)).not.toContainText("Wakes when you message");
});
