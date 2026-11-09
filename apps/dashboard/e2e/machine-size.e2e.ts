import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT ?? "54399"}`;
type State = {
  launches: Record<string, unknown>[];
  sizePolicyCalls: Record<string, unknown>[];
  sizedRefusals: Record<string, unknown>[];
  launchRoutes: string[];
  goldenCalls: unknown[];
};

async function reset(flags: Record<string, unknown>): Promise<void> {
  await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify(flags) });
}
async function mockState(): Promise<State> {
  return (await (await fetch(`${MOCK}/__test/state`, { method: "POST", body: "{}" })).json()) as State;
}
const golden = (page: Page, provider: "boat" | "modal") =>
  page.locator(`[data-golden-group="${provider}"] [data-golden="shared-golden"]`);

test("the launch shows the repository then golden default, keeps an override and sends it as size", async ({
  page,
}) => {
  await reset({ sizePolicies: true, modalTwin: true, acmeModal: true });
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden on Boat" }).click();
  const dialog = page.getByRole("dialog");
  const size = dialog.getByLabel("Machine size");
  const hint = dialog.locator("[data-size-source]");
  await expect(size.locator("option")).toHaveText([
    "Default · Medium (golden)",
    "Small · 2 vCPU · 4 GiB",
    "Medium · 4 vCPU · 8 GiB",
    "Large · 8 vCPU · 16 GiB",
    "Extra large · 16 vCPU · 32 GiB",
  ]);
  await expect(hint).toHaveAttribute("data-size-source", "golden");
  await dialog.getByLabel("Working directory").selectOption("api");
  await expect(hint).toHaveAttribute("data-size-source", "repository");
  await expect(hint).toContainText("Large, the default for api. 8 vCPU · 16 GiB · 111 GB disk.");
  await expect(size.locator("option").first()).toHaveText("Default · Large (repository)");

  await size.selectOption("small");
  await dialog.getByLabel("Working directory").selectOption("web");
  await expect(size).toHaveValue("small");
  await expect(hint).toContainText("Overrides the default (Medium, the golden's default).");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/machine-size-launch-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  // An explicit size goes only to the fail-closed versioned route.
  expect((await mockState()).launchRoutes[0]).toBe("sandbox/launch-sized-v1");
  expect((await mockState()).launches[0]).toMatchObject({
    sizePolicyVersion: 1,
    provider: "boat",
    repo: "web",
    size: "small",
  });
  await expect(page.locator("dd", { hasText: "Small (chosen at launch)" })).toHaveText(
    "Small (chosen at launch) · 2 vCPU · 4 GiB · 51 GB disk",
  );

  // Modal, no defaults: the provider decides, nothing is invented and no size is sent.
  await page.goto("/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden on Modal" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByLabel("Machine size").locator("option")).toHaveText([
    "Default (Modal decides)",
    "Small · 1 physical core · 4 GiB",
    "Medium · 2 physical cores · 8 GiB",
    "Large · 4 physical cores · 16 GiB",
    "Extra large · 8 physical cores · 32 GiB",
  ]);
  await expect(modal.locator("[data-size-source]")).toHaveText(
    "No default set: Modal uses its own size, which Armada does not record.",
  );
  await modal.getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launches = (await mockState()).launches;
  // No defaults and no override: no sizing is promised, so the legacy route is the same launch.
  expect((await mockState()).launchRoutes[1]).toBe("sandbox/launch");
  expect(launches[1]).toMatchObject({ provider: "modal" });
  expect(launches[1]).not.toHaveProperty("size");
  expect(launches[1]).not.toHaveProperty("sizePolicyVersion");
  await expect(page.locator("dd", { hasText: "Modal default" })).toHaveText("Modal default, not recorded");
});

test("an admin saves defaults for one provider's golden without rebuilding it, and the next launch uses them", async ({
  page,
}) => {
  await reset({ sizePolicies: true, modalTwin: true, acmeModal: true });
  await signIn(page, "alice@example.com", "/goldens");
  const card = golden(page, "modal");
  await expect(card.locator("[data-size-summary]")).toHaveText("No defaults: Modal decides");
  await card.getByText("Machine size defaults").click();
  await card.getByLabel("Golden default").selectOption("small");
  await card.getByLabel("When starting in docs").selectOption("large");
  await card.getByRole("button", { name: "Save size defaults" }).click();
  await expect(card.getByRole("status")).toContainText("Size defaults saved");
  await expect(card.locator("[data-size-summary]")).toHaveText("Golden: Small · docs: Large");
  await expect(card.getByLabel("When starting in docs")).toHaveValue("large");
  const state = await mockState();
  expect(state.sizePolicyCalls.at(-1)).toEqual({
    golden: "shared-golden",
    org: "00000000-0000-4000-8000-000000000010",
    provider: "modal",
    policy: { version: 1, golden: "small", repositories: { docs: "large" } },
  });
  expect(state.goldenCalls).toHaveLength(0);
  // The Boat golden of the same name keeps its own defaults.
  await expect(golden(page, "boat").locator("[data-size-summary]")).toHaveText("Golden: Medium · api: Large");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/machine-size-defaults-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Launch from shared-golden on Modal" }).click();
  await expect(page.getByRole("dialog").locator("[data-size-source]")).toContainText(
    "Large, the default for docs. 4 physical cores (8 vCPU) · 16 GiB, capped.",
  );
});

test("a member sees an org golden's defaults read-only; the owner edits their private golden's", async ({ page }) => {
  await reset({ sizePolicies: true });
  await signIn(page, "bob@example.com", "/goldens");
  const shared = page.locator('[data-golden="shared-golden"]');
  await expect(shared.locator('[data-size-defaults="read-only"]')).toHaveText(
    "Size defaults: Golden: Medium · api: Large. Only an org admin changes an org golden's size defaults.",
  );
  await expect(shared.getByRole("button", { name: "Save size defaults" })).toHaveCount(0);
  await expect(page.locator('[data-golden="bob-private"] [data-size-defaults="editable"]')).toBeVisible();
});

test("a refused size says what can be changed, and an older server allocates nothing for a sized launch", async ({
  page,
}) => {
  await reset({ sizePolicies: true, refuseSize: "xlarge" });
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden on Boat" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Machine size").selectOption("xlarge");
  await expect(dialog.locator("[data-size-source]")).toContainText("Extra large needs a Boat plan that includes it.");
  await dialog.getByRole("button", { name: "Launch" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Requested size cannot be allocated. If Boat refused Extra large, choose another size or the default.",
  );
  expect((await mockState()).launches.at(-1)).toMatchObject({ size: "xlarge" });

  // The database has the columns but this replica predates #653: the sized route is unknown there, so the launch
  // fails before allocation and is never retried on the legacy route, whether a size was chosen or a default kept.
  await reset({ sizePolicies: true, olderServer: true });
  await page.context().clearCookies();
  await signIn(page, "alice@example.com", "/goldens");
  for (const choice of ["large", ""]) {
    await page.getByRole("button", { name: "Launch from shared-golden on Boat" }).click();
    const launch = page.getByRole("dialog");
    await launch.getByLabel("Machine size").selectOption(choice);
    await launch.getByRole("button", { name: "Launch" }).click();
    await expect(launch.getByRole("alert")).toHaveText(
      "This Armada server does not offer launching with machine sizes yet.",
    );
    await page.keyboard.press("Escape");
  }
  const older = await mockState();
  expect(older.launches).toHaveLength(0);
  expect(older.sizedRefusals).toHaveLength(2);
  expect(older.sizedRefusals[0]).toMatchObject({ size: "large", sizePolicyVersion: 1 });
  expect(older.sizedRefusals[1]).not.toHaveProperty("size");

  await page.goto("/goldens");
  const card = page.locator('[data-golden="shared-golden"]');
  await card.getByText("Machine size defaults").click();
  await card.getByLabel("Golden default").selectOption("large");
  await card.getByRole("button", { name: "Save size defaults" }).click();
  await expect(card.getByRole("alert")).toHaveText("This Armada server does not offer machine size defaults yet.");

  // Before the migration: no size anywhere.
  await reset({});
  await page.context().clearCookies();
  await signIn(page, "alice@example.com", "/goldens");
  await expect(page.locator("[data-size-defaults]")).toHaveCount(0);
  await page.getByRole("button", { name: "Launch from shared-golden on Boat" }).click();
  await expect(page.getByRole("dialog").getByLabel("Machine size")).toHaveCount(0);
});
