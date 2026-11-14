import { expect, test } from "@playwright/test";
import { MOCK, openCreate, signIn } from "./helpers";

test("snapshot progress is readable and build references stay in Details without resubmission", async ({ page }) => {
  const post = async (path: string, body: object = {}) => {
    const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  await post("reset", { novaOrg: true });
  await post("golden-gate", { hold: true });
  await signIn(page, "carol@example.com", "/snapshots");
  const form = await openCreate(page);
  await form.getByLabel("Name", { exact: true }).fill("feedback-snapshot");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build snapshot", exact: true }).click();
  const progress = form.getByRole("status").filter({ hasText: /Snapshot build (queued|is running)/ });
  await expect(progress).toBeVisible();
  await expect(form.getByRole("button", { name: "Build snapshot", exact: true })).toBeDisabled();
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await progress.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/build-feedback-after-${name}.png`, fullPage: true });
  }
  await form.getByRole("button", { name: "Build details", exact: true }).click();
  await expect(form.getByText("Request reference:", { exact: false })).toBeVisible();
  await expect(form.getByText("Build reference:", { exact: false })).toBeVisible();
  expect((await post("state")).goldenCalls).toHaveLength(1);
  await post("golden-release");
  await expect(form.getByRole("status").filter({ hasText: "Ready to launch" })).toBeVisible();
  expect((await post("state")).goldenCalls).toHaveLength(1);
});

test("cancelling a queued build reports confirmed cancellation rather than administrator recovery", async ({
  page,
}) => {
  expect((await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ novaOrg: true }) })).ok).toBe(
    true,
  );
  expect(
    (await fetch(`${MOCK}/__test/golden-gate`, { method: "POST", body: JSON.stringify({ holdQueued: true }) })).ok,
  ).toBe(true);
  await signIn(page, "carol@example.com", "/snapshots");
  const form = await openCreate(page);
  await form.getByLabel("Name", { exact: true }).fill("cancelled-snapshot");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build snapshot", exact: true }).click();
  await form.getByRole("button", { name: "Cancel queued build", exact: true }).click();
  await expect(form.getByRole("status").filter({ hasText: "Queued build cancelled" })).toContainText(
    "No builder was started",
  );
  await expect(form.getByRole("alert")).toHaveCount(0);
});
