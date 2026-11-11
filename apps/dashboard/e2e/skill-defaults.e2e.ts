import { expect, type Locator, type Page, test } from "@playwright/test";
import { goldenPanel, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);
test.use({ reducedMotion: "reduce" });
async function post(path: string, body: object) {
  expect((await fetch(MOCK + path, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
async function exactPin(page: Page, dialog: Locator, pin: string) {
  await dialog.getByRole("button", { name: "Add skills", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose additional skills" });
  await picker.getByRole("button", { name: "Enter exact pin" }).click();
  await picker.getByLabel("Exact skill pin").fill(pin);
  await picker.getByRole("button", { name: "Add pin", exact: true }).click();
}
test("all defaults scopes save and clear; opt-out retains explicit launch pins", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await signIn(page, "alice@example.com", "/skills");
  for (const [regionName, dialogName, pin] of [
    ["Your default skills", "Edit your default skills", "review-code@2.0.0"],
    ["Organization default skills", "Edit organization default skills", "example/browser-testing@1.4.0"],
  ] as const) {
    const region = page.getByRole("region", { name: regionName, exact: true });
    await expect(region.getByText("No default skills configured.")).toBeVisible();
    await region.getByRole("button", { name: "Edit defaults" }).click();
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog.getByRole("button", { name: "Save defaults" })).toBeEnabled();
    await exactPin(page, dialog, pin);
    if (regionName === "Your default skills")
      await dialog.screenshot({ path: "test-results/default-skills-personal.png", animations: "disabled" });
    await dialog.getByRole("button", { name: "Save defaults" }).click();
    await expect(dialog).toBeHidden();
    await expect(region).toContainText(pin);
  }
  await page.screenshot({ path: "test-results/default-skills-overview.png", animations: "disabled", fullPage: true });
  await page.goto("/environments");
  const details = await goldenPanel(page, "shared-golden", "boat");
  const environment = details.getByRole("region", {
    name: "Environment default skills",
  });
  await environment.getByRole("button", { name: "Edit defaults" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit environment default skills" });
  await expect(dialog.getByRole("button", { name: "Save defaults" })).toBeEnabled();
  await exactPin(page, dialog, "environment@1.0.0");
  await dialog.screenshot({ path: "test-results/default-skills-environment.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Save defaults" }).click();
  await expect(dialog).toBeHidden();
  await expect(environment).toContainText("environment@1.0.0");
  await details.getByRole("button", { name: "Launch from shared-golden on Boat", exact: true }).click();
  const launch = page.getByRole("dialog", { name: "Launch from shared-golden", exact: true });
  await launch
    .locator("[data-launch-advanced]")
    .getByRole("button", { name: /^Advanced/ })
    .click();
  await expect(launch.getByLabel("Apply default skills")).toBeChecked();
  await launch.getByLabel("Apply default skills").uncheck();
  await exactPin(page, launch, "explicit@1.0.0");
  await launch.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  await page.goto("/skills");
  await page
    .getByRole("region", { name: "Your default skills", exact: true })
    .getByRole("button", { name: "Edit defaults" })
    .click();
  const clear = page.getByRole("dialog", { name: "Edit your default skills" });
  await clear.getByRole("button", { name: "Remove review-code@2.0.0" }).click();
  await clear.getByRole("button", { name: "Save defaults" }).click();
  await expect(clear).toBeHidden();
  const state = await (await fetch(MOCK + "/__test/state")).json();
  const writes = state.skillDefaultCalls.filter((call: { route: string }) => call.route.endsWith("/set"));
  expect(writes.map((call: { body: unknown }) => call.body)).toEqual([
    expect.objectContaining({ scope: "personal", skills: ["review-code@2.0.0"] }),
    expect.objectContaining({ scope: "org", skills: ["example/browser-testing@1.4.0"] }),
    expect.objectContaining({ scope: "golden", goldenId: expect.any(String), skills: ["environment@1.0.0"] }),
    expect.objectContaining({ scope: "personal", skills: [] }),
  ]);
  expect(state.launches[0]).toMatchObject({ skipSkillDefaults: true, skills: ["explicit@1.0.0"] });
});
test("read failures never become empty editable records", async ({ page }) => {
  await post("/__test/skill-defaults-read-failure", { enabled: true });
  await signIn(page, "alice@example.com", "/skills");
  const region = page.getByRole("region", { name: "Your default skills", exact: true });
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByText("No default skills configured.")).toHaveCount(0);
  await region.getByRole("button", { name: "Edit defaults" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit your default skills" });
  await expect(dialog.getByRole("button", { name: "Save defaults" })).toBeDisabled();
  await post("/__test/skill-defaults-read-failure", { enabled: false });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("button", { name: "Save defaults" })).toBeEnabled();
  const state = await (await fetch(MOCK + "/__test/state")).json();
  expect(state.skillDefaultCalls.filter((call: { route: string }) => call.route.endsWith("/set"))).toEqual([]);
});
test("members read shared defaults without an organization editor", async ({ page }) => {
  await signIn(page, "bob@example.com", "/skills");
  const region = page.getByRole("region", { name: "Organization default skills", exact: true });
  await expect(region.getByText("No default skills configured.")).toBeVisible();
  await expect(region.getByRole("button", { name: "Edit defaults" })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Your default skills", exact: true })
      .getByRole("button", { name: "Edit defaults" }),
  ).toBeVisible();
});
