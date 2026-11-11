import { expect, test } from "@playwright/test";
import { IDS, MOCK, openLaunch, reset, signIn } from "./helpers";

test.beforeEach(reset);
test.use({ reducedMotion: "reduce" });
async function post(path: string, body: object) {
  expect((await fetch(MOCK + path, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
test("search metadata, select exact workspace and public versions, then launch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await signIn(page, "alice@example.com", "/environments");
  const launch = await openLaunch(page, "shared-golden", { advanced: false });
  await launch.getByRole("button", { name: "Add skills", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose additional skills" });
  await expect(picker.getByRole("option", { name: /Code review/ })).toBeVisible();
  await picker.getByPlaceholder("Search skills").fill("security");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker.getByText("Private", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/skills-picker-desktop.png", animations: "disabled" });
  await picker.getByRole("option", { name: /Code review/ }).click();
  await picker.getByLabel("Version", { exact: true }).selectOption("2.0.0");
  await picker.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(launch.getByRole("button", { name: "Remove review-code@2.0.0" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await launch.getByRole("button", { name: "Add skills", exact: true }).click();
  await picker.getByRole("button", { name: "Public catalog", exact: true }).click();
  await expect(picker.getByRole("option", { name: /Browser testing/ })).toBeVisible();
  await expect(picker.getByText("Public", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/skills-picker-mobile.png", animations: "disabled" });
  await picker.getByRole("option", { name: /Browser testing/ }).click();
  await picker.getByRole("button", { name: "Add skill", exact: true }).click();
  await launch.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const state = await (await fetch(MOCK + "/__test/state")).json();
  expect(state.launches).toHaveLength(1);
  expect(state.launches[0].skills).toEqual(["review-code@2.0.0", "example/browser-testing@1.4.0"]);
});
test("unavailable discovery retains exact-pin fallback and rejects floating versions", async ({ page }) => {
  await post("/__test/skill-catalog-unavailable", { unavailable: true });
  await signIn(page, "alice@example.com", "/environments");
  const launch = await openLaunch(page, "shared-golden", { advanced: false });
  await launch.getByRole("button", { name: "Add skills", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose additional skills" });
  await expect(picker.getByRole("alert")).toContainText("unavailable");
  await picker.getByRole("button", { name: "Enter exact pin" }).click();
  await picker.getByLabel("Exact skill pin").fill("notes@latest");
  await picker.getByRole("button", { name: "Add pin", exact: true }).click();
  await expect(picker.getByRole("alert")).toBeVisible();
  await picker.getByLabel("Exact skill pin").fill("notes@1.0.0");
  await picker.getByRole("button", { name: "Add pin", exact: true }).click();
  await expect(launch.getByRole("button", { name: "Remove notes@1.0.0" })).toBeVisible();
  await launch.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const state = await (await fetch(MOCK + "/__test/state")).json();
  expect(state.launches[0].skills).toEqual(["notes@1.0.0"]);
});
for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 960 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${name}: authorized details render stored receipts and checksum`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await post("/__test/sandbox-lifecycle", {
      id: IDS.running,
      fields: {
        skills: [
          {
            reference: "review-code@2.0.0",
            version: "2.0.0",
            skillId: "internal-id",
            workspaceId: "internal-workspace",
            checksum: `sha256:${"a".repeat(64)}`,
            origin: "https://skillpack.app/v1",
          },
          {
            reference: "example/browser-testing@1.4.0",
            version: "1.4.0",
            checksum: `sha256:${"b".repeat(64)}`,
            origin: "https://skillpack.app/v1",
          },
        ],
      },
    });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    if (name === "mobile") await page.getByRole("button", { name: "Details", exact: true }).click();
    const receipts = page.getByRole("list", { name: "Installed skills" });
    await expect(receipts.getByText("review-code", { exact: true })).toBeVisible();
    await expect(receipts.getByText("2.0.0", { exact: true })).toBeVisible();
    await receipts.getByText("Installation details", { exact: true }).first().click();
    await expect(receipts.getByText(`sha256:${"a".repeat(64)}`)).toBeVisible();
    await expect(receipts).not.toContainText("internal-workspace");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/skills-receipts-${name}.png`, animations: "disabled" });
  });
}
