import { expect, test } from "@playwright/test";
import { MOCK, signIn } from "./helpers";

test("a host snapshot refusal hides diagnostics while retaining the exact build request", async ({ page }) => {
  const diagnostic = "HTTP 503: snapshot_image_digest host_id sha256:example";
  expect(
    (
      await fetch(`${MOCK}/__test/reset`, {
        method: "POST",
        body: JSON.stringify({
          dockerSnapshotCreateFailure: diagnostic,
          dockerHosts: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Build workstation",
              state: "online",
              createdAt: "2026-11-14T12:00:00Z",
              lastSeenAt: "2026-11-14T12:00:00Z",
              revokedAt: null,
              sandboxes: 0,
              version: null,
            },
          ],
        }),
      })
    ).ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/snapshots");
  await page.getByRole("button", { name: "New snapshot", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a snapshot" });
  await dialog.getByLabel("Build on", { exact: true }).selectOption("docker");
  await dialog.getByLabel("Name", { exact: true }).fill("host-example");
  await dialog.getByLabel("Snapshot JSON file").setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
    ),
  });
  const request = dialog.locator('input[name="requestId"]');
  const key = await request.inputValue();
  await dialog.getByRole("button", { name: "Build snapshot", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByRole("alert").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/docker-snapshot-after-${name}.png`, fullPage: true });
  }
  await expect(dialog.getByRole("alert")).not.toContainText(diagnostic);
  await expect(dialog.getByRole("alert")).toContainText("Reload Snapshots");
  await expect(request).toHaveValue(key);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("host-example");
  await expect(dialog.getByLabel("Snapshot JSON file")).toHaveValue(/snapshot\.json$/);
  expect(JSON.parse(await dialog.locator('input[name="config"]').inputValue())).toMatchObject({
    repos: [{ dir: "web" }],
  });
  await expect(dialog.getByLabel("Host", { exact: true })).toHaveValue("11111111-1111-4111-8111-111111111111");
});
