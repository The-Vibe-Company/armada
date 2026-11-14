import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
test.use({ reducedMotion: "reduce" });
test.beforeEach(async () => {
  expect(
    (
      await fetch(`${MOCK}/__test/reset`, {
        method: "POST",
        body: JSON.stringify({
          dockerHosts: [
            {
              id: HOST,
              name: "Office workstation",
              state: "online",
              createdAt: "2026-11-13T08:00:00Z",
              lastSeenAt: "2026-11-13T12:00:00Z",
              revokedAt: null,
              sandboxes: 0,
              version: null,
            },
          ],
        }),
      })
    ).ok,
  ).toBe(true);
});

test("host launch uses the same bounded fields, Advanced and pinned action as snapshot launch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "alice@example.com", `/hosts?item=${HOST}`);
  await page.getByRole("button", { name: "Launch on this host" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch on Office workstation", exact: true });
  await expect(dialog.getByLabel("Task")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/launch-surface-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 664 });
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/launch-surface-mobile.png", animations: "disabled" });
  const launch = dialog.getByRole("button", { name: "Launch", exact: true });
  await expect(launch).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator("[data-docker-unavailable]")).toBeHidden();
  await dialog.getByRole("button", { name: /^Advanced/ }).click();
  await expect(dialog.locator("[data-docker-unavailable]")).toBeVisible();
  await dialog.locator("[data-launch-fields]").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(launch).toBeInViewport({ ratio: 1 });
  await dialog.getByLabel("Task").fill("Check the parser");
  const payload = await dialog
    .locator("form")
    .evaluate((element) => Object.fromEntries(new FormData(element as HTMLFormElement)));
  expect(payload).toMatchObject({
    org: "00000000-0000-4000-8000-000000000010",
    hostId: HOST,
    harness: "claude",
    credential: "00000000-0000-4000-8000-000000000040",
    model: "claude-opus-5-5",
    reasoning_effort: "medium",
    prompt: "Check the parser",
  });
  expect(payload).not.toHaveProperty("image");
});

test("the host shortcut requests one form submission, and an unavailable account keeps it disabled", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", `/hosts?item=${HOST}`);
  await page.getByRole("button", { name: "Launch on this host" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch on Office workstation", exact: true });
  const form = dialog.locator("form");
  // Observe the public submit event without allocating even a mock sandbox.
  await form.evaluate((element) =>
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      (element as HTMLElement).dataset.submissions = String(
        Number((element as HTMLElement).dataset.submissions ?? "0") + 1,
      );
    }),
  );
  await dialog.getByLabel("Task").fill("Check the parser");
  await dialog.getByLabel("Task").press("Control+Enter");
  await expect(form).toHaveAttribute("data-submissions", "1");
  await dialog.getByRole("radio", { name: "Codex", exact: true }).check();
  await expect(dialog.getByRole("button", { name: "Launch", exact: true })).toBeDisabled();
  await dialog.getByLabel("Task").press("Control+Enter");
  await expect(form).toHaveAttribute("data-submissions", "1");
});
