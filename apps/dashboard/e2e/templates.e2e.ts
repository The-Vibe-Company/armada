import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const row = (page: Page, name: string) => page.locator(`[data-template="${name}"]`);
const panelOf = (page: Page, name: string) => page.locator(`[data-template-panel="${name}"]`);

async function panel(page: Page, name: string) {
  const shown = panelOf(page, name);
  if (!(await shown.isVisible())) await row(page, name).locator("[data-select-item]").click();
  await expect(shown).toBeVisible();
  return shown;
}

type TemplateCall = { route: string; body: Record<string, unknown>; authorized: boolean };

async function mockState(): Promise<{
  templateCalls: TemplateCall[];
  templates: { name: string; status: string; currentRevision: number; scope: string }[];
  templateRevisions: { templateId: string; revision: number; definition: Record<string, unknown> }[];
}> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}

async function outcome(body: Record<string, unknown>) {
  expect((await fetch(`${MOCK}/__test/template-outcome`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(
    true,
  );
}

for (const mobile of [false, true]) {
  test(`templates are listed with their four choices at a glance, and New opens a two-step dialog (${mobile ? "phone" : "laptop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    await signIn(page, "alice@example.com", "/templates");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: /Templates/ })).toHaveAttribute("aria-current", "page");
    // What needs the viewer first, then what is ready; Bob's personal template is not Alice's to see.
    await expect(page.getByRole("list", { name: "Templates" }).locator(":scope > li")).toHaveText([
      /Modal quick fix/,
      /Backend with docs/,
    ]);
    await expect(row(page, "Bob scratch")).toHaveCount(0);
    const backend = row(page, "Backend with docs");
    await expect(backend).toContainText("Org");
    await expect(backend).toContainText("shared-golden on Boat · Claude Opus 5.5 · 1 tool · 1 variable");
    await expect(backend).toContainText("Ready");
    await expect(row(page, "Modal quick fix")).toContainText("Variable changed");
    if (!mobile) await expect(backend).toContainText("Everyone in Acme");
    // A stale variable is a warning, not a failure: nothing in red.
    await expect(page.locator(".text-destructive:visible, p[role=alert]:visible")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
    await page.screenshot({
      animations: "disabled",
      path: `test-results/templates-${mobile ? "phone" : "desktop"}.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New template" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: /Who can use it/ })).toContainText("Cannot be changed later");
    // On a laptop each step reads whole, its button in view, without scrolling.
    if (!mobile) await expect(dialog.getByRole("button", { name: "Next: tools and variables" })).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: `test-results/templates-create-1-${mobile ? "phone" : "desktop"}.png`,
    });
    await dialog.getByLabel("Name").fill("Laptop fit");
    await dialog.getByLabel("Environment").selectOption({ label: "shared-golden on Boat" });
    await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
    await expect(dialog.getByText("Secrets are not available in templates yet.")).toBeVisible();
    if (!mobile) await expect(dialog.getByRole("button", { name: "Publish template" })).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: `test-results/templates-create-2-${mobile ? "phone" : "desktop"}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
  });
}

test("an admin creates an org template from org resources only; it is published as revision 1", async ({ page }) => {
  await signIn(page, "alice@example.com", "/templates");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New template" });
  // Step 1 says what is missing before going on.
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Name the template.");
  await dialog.getByLabel("Name").fill("Sentry triage");
  await dialog.getByRole("radio", { name: /Org \(Acme\)/ }).check();
  // A private environment is not offered to an org template; one without a snapshot cannot be chosen.
  await expect(dialog.getByLabel("Environment").locator("option", { hasText: "alice-private" })).toHaveCount(0);
  await dialog.getByLabel("Environment").selectOption({ label: "modal-golden on Modal" });
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await dialog.getByLabel("Reasoning effort").selectOption("medium");
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await expect(dialog.getByRole("heading", { name: /Step 2 of 2/ })).toBeFocused();
  const tools = dialog.getByRole("group", { name: /Tools/ });
  // Org tools only; one not connected is shown but cannot be chosen.
  await expect(tools).not.toContainText("Alice Linear");
  await expect(tools.getByRole("checkbox", { name: /Acme Sentry/ })).toBeDisabled();
  await tools.getByRole("checkbox", { name: /Acme Docs/ }).check();
  const variables = dialog.getByRole("group", { name: /Variables/ });
  await variables.getByRole("checkbox", { name: /APP_REGION/ }).check();
  await expect(variables).toContainText("1 chosen");
  await dialog.getByRole("button", { name: "Publish template" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Sentry triage is published (revision 1).", { exact: true })).toBeVisible();
  await expect(row(page, "Sentry triage")).toContainText("modal-golden on Modal · GPT-6.1 Sol · 1 tool · 1 variable");

  const { templateCalls } = await mockState();
  const create = templateCalls.find((call) => call.route === "templates/create");
  expect(create?.authorized).toBe(true);
  expect(create?.body).toEqual({
    org: "00000000-0000-4000-8000-000000000010",
    name: "Sentry triage",
    scope: "org",
    definition: {
      goldenId: "00000000-0000-4000-8000-000000000026",
      provider: "modal",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      connections: ["00000000-0000-4000-8000-000000000060"],
      variables: [{ key: "APP_REGION", variableId: "00000000-0000-4000-8000-000000000080", version: 3 }],
    },
  });
});

test("a new revision starts from the current one; the old revision stays and the warning clears", async ({ page }) => {
  await signIn(page, "alice@example.com", "/templates");
  const shown = await panel(page, "Modal quick fix");
  await expect(shown.locator("[data-template-problems]")).toContainText("APP_REGION changed since this revision");
  // Launch waits until the template is fixed.
  await expect(row(page, "Modal quick fix").getByRole("button", { name: /Launch/ })).toHaveCount(0);
  await shown.getByRole("button", { name: "New revision" }).click();
  const dialog = page.getByRole("dialog", { name: "New revision of Modal quick fix" });
  await expect(dialog.getByLabel("Environment")).toHaveValue("00000000-0000-4000-8000-000000000026");
  await expect(dialog.getByRole("radio", { name: "Codex" })).toBeChecked();
  await expect(dialog.getByLabel("Reasoning effort")).toHaveValue("high");
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await expect(dialog.getByRole("checkbox", { name: /APP_REGION/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Modal quick fix")).toContainText("Ready");
  const state = await mockState();
  const revisions = state.templateRevisions.filter((r) => r.templateId === "00000000-0000-4000-8000-000000000091");
  expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(revisions.map((r) => (r.definition.variables as { version: number }[])[0]?.version)).toEqual([2, 3]);
  const publish = state.templateCalls.find((call) => call.route === "templates/publish");
  expect(publish?.body.expectedRevision).toBe(1);
});

test("a member launches an org template but cannot change it; delete is for its owner", async ({ page }) => {
  await signIn(page, "bob@example.com", "/templates");
  const shown = await panel(page, "Backend with docs");
  await expect(shown).toContainText("Managed by Acme's admins.");
  await expect(shown.getByRole("button", { name: "New revision" })).toHaveCount(0);
  await expect(shown.getByRole("button", { name: "Delete" })).toHaveCount(0);
  // Bob's own personal template is his to delete.
  const mine = await panel(page, "Bob scratch");
  await mine.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Bob scratch?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "Bob scratch")).toHaveCount(0);
  const { templates } = await mockState();
  expect(templates.find((t) => t.name === "Bob scratch")?.status).toBe("deleted");
});

test("launch from a template: only the run is chosen, the revision is pinned and a retry reuses its key", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/templates");
  await row(page, "Backend with docs").getByRole("button", { name: "Launch from Backend with docs" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch Backend with docs" });
  const preset = dialog.locator("[data-template-preset]");
  await expect(preset).toContainText("shared-golden on Boat");
  await expect(preset).toContainText("Claude Code · Claude Opus 5.5 · High");
  await expect(preset).toContainText("Acme Docs");
  await expect(preset).toContainText("APP_REGION");
  // The template's choices are not fields here.
  await expect(dialog.getByLabel("Model")).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "test-results/templates-launch-desktop.png" });

  // An outcome the server cannot confirm keeps the key: launching again repeats the same request.
  await outcome({ state: "reconciling", reason: "allocation_or_start_unknown" });
  await dialog.getByLabel("Task").fill("Fix the flaky test");
  await dialog.getByLabel("Project").selectOption("api");
  await dialog.getByLabel("Runs for").selectOption("3600");
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not confirm whether the sandbox started");
  await expect(dialog.getByLabel("Task")).toHaveValue("Fix the flaky test");
  await dialog.getByRole("button", { name: /Launch/ }).click();
  const launchCalls = async () => (await mockState()).templateCalls.filter((call) => call.route === "templates/launch");
  await expect.poll(async () => (await launchCalls()).length).toBe(2);
  await expect(dialog.getByRole("alert")).toContainText("could not confirm");

  const launches = await launchCalls();
  expect(launches[0]?.body.requestKey).toBe(launches[1]?.body.requestKey);
  expect(launches[0]?.body).toMatchObject({
    id: "00000000-0000-4000-8000-000000000090",
    revision: 2,
    prompt: "Fix the flaky test",
    repo: "api",
    ttlSeconds: 3600,
  });
  expect(Object.keys(launches[0]?.body ?? {}).sort()).toEqual(
    ["id", "org", "prompt", "repo", "requestKey", "revision", "ttlSeconds"].sort(),
  );
});

test("a refused launch says why and takes a fresh key; a successful one opens the sandbox", async ({ page }) => {
  await signIn(page, "alice@example.com", "/templates");
  await row(page, "Backend with docs").getByRole("button", { name: "Launch from Backend with docs" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch Backend with docs" });
  await outcome({ state: "failed", reason: "connection_unavailable" });
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/A tool it uses is not connected/);
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launches = (await mockState()).templateCalls.filter((call) => call.route === "templates/launch");
  expect(launches).toHaveLength(2);
  expect(launches[0]?.body.requestKey).not.toBe(launches[1]?.body.requestKey);
});

test("the environment's launch dialog offers its templates; choosing one preselects everything", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  await page.getByRole("button", { name: "Launch from shared-golden on Boat" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch from shared-golden" });
  await expect(dialog.getByLabel("Model")).toHaveCount(1);
  await dialog.getByLabel("Start from").selectOption({ label: "Backend with docs (revision 2)" });
  await expect(dialog.locator("[data-template-preset]")).toContainText("Acme Docs");
  await expect(dialog.getByLabel("Model")).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "test-results/templates-environment-launch-desktop.png" });
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launch = (await mockState()).templateCalls.find((call) => call.route === "templates/launch");
  expect(launch?.body).toMatchObject({ id: "00000000-0000-4000-8000-000000000090", revision: 2 });
});
