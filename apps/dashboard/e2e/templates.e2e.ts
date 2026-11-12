import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const row = (page: Page, name: string) => page.locator(`[data-template="${name}"]`);
const panelOf = (page: Page, name: string) => page.locator(`[data-template-panel="${name}"]`);

async function panel(page: Page, name: string) {
  const shown = panelOf(page, name);
  if (!(await shown.isVisible())) {
    const current = page.getByRole("dialog").filter({ has: page.locator("[data-resource-panel]") });
    if (await current.isVisible()) await page.keyboard.press("Escape");
    await row(page, name).getByRole("link", { name, exact: true }).click();
  }
  await expect(shown).toBeVisible();
  return shown;
}

type TemplateCall = { route: string; body: Record<string, unknown>; authorized: boolean };

async function mockState(): Promise<{
  templateCalls: TemplateCall[];
  templates: { id: string; name: string; status: string; currentRevision: number; scope: string }[];
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
    if (mobile) await page.getByRole("button", { name: /Navigation/ }).click();
    await expect(nav.getByRole("link", { name: /Templates/ })).toHaveAttribute("aria-current", "page");
    if (mobile) await page.keyboard.press("Escape");
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
    await expect(
      dialog.getByText(
        "Only names and scope are shown. Values are delivered as environment variables to the selected agent.",
      ),
    ).toBeVisible();
    if (!mobile) await expect(dialog.getByRole("button", { name: "Publish template" })).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: `test-results/templates-create-2-${mobile ? "phone" : "desktop"}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
  });
}

test("a missing agent account warns before publication and choosing a usable agent clears it", async ({ page }) => {
  await fetch(`${MOCK}/__test/accounts`, {
    method: "POST",
    body: JSON.stringify({
      user: [],
      org: [
        {
          id: "00000000-0000-4000-8000-000000000799",
          kind: "openai",
          name: "Organization Codex",
          version: 1,
          status: "active",
          updatedAt: "2026-11-11T00:00:00.000Z",
        },
      ],
    }),
  });
  await signIn(page, "alice@example.com", "/templates");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New template" });
  const warning = dialog.getByRole("status");
  await expect(warning).toContainText("No usable Claude Code account is available to you in this organization.");
  await expect(warning.getByRole("link", { name: "Account > Models" })).toHaveAttribute("href", "/harness");
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await expect(warning).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Claude Code" }).check();
  await expect(warning).toBeVisible();
  // A warning is not a publication ban: another launcher may already have an account.
  await dialog.getByLabel("Name").fill("Needs Claude account");
  await dialog.getByLabel("Environment").selectOption({ label: "shared-golden on Boat" });
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await dialog.getByRole("button", { name: "Publish template" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Needs Claude account")).toBeVisible();
});

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
  const secrets = dialog.getByRole("group", { name: /^Secrets/ });
  await expect(secrets.getByRole("checkbox", { name: /ALICE_DEPLOY_TOKEN/ })).toHaveCount(0);
  await secrets.getByRole("checkbox", { name: /STRIPE_API_KEY/ }).check();
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
      secrets: [{ key: "STRIPE_API_KEY", secretId: "00000000-0000-4000-8000-000000000081", version: 1 }],
    },
  });
  // A revoked selection remains visible and checked until explicitly removed.
  await fetch(`${MOCK}/__test/vault-revoke`, {
    method: "POST",
    body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000081" }),
  });
  await page.reload();
  const shown = await panel(page, "Sentry triage");
  await expect(shown).toContainText("STRIPE_API_KEY is expired, revoked, removed or inaccessible");
  await shown.getByRole("button", { name: "New revision" }).click();
  const edit = page.getByRole("dialog", { name: "New revision of Sentry triage" });
  await edit.getByRole("button", { name: "Next: tools and variables" }).click();
  const retained = edit.getByRole("group", { name: /^Secrets/ }).getByRole("checkbox", { name: /STRIPE_API_KEY/ });
  await expect(retained).toBeChecked();
  await expect(edit).toContainText("Unavailable — remove to publish");
  await retained.uncheck();
  await edit.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(edit).toBeHidden();
});

test("a new revision starts from the current one; the old revision stays and the warning clears", async ({ page }) => {
  await fetch(`${MOCK}/__test/accounts`, {
    method: "POST",
    body: JSON.stringify({
      user: [],
      org: [1, 2].map((number) => ({
        id: `00000000-0000-4000-8000-00000000079${number}`,
        kind: "openai",
        name: `Codex ${number}`,
        version: 1,
        status: "active",
        updatedAt: "2026-11-11T00:00:00.000Z",
      })),
    }),
  });
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
  const accountWarning = dialog.getByRole("status");
  const keepAccount = dialog.getByRole("checkbox", { name: /Keep its pinned model account/ });
  // The implicit default is irrelevant while this revision keeps its explicit account.
  await expect(accountWarning).toHaveCount(0);
  await keepAccount.uncheck();
  await expect(accountWarning).toContainText("Several Codex accounts are available. Set a default");
  await keepAccount.check();
  await expect(accountWarning).toHaveCount(0);
  // Changing harness drops the pin; publishing that revision must warn just like creating it.
  await dialog.getByRole("radio", { name: "Claude Code" }).check();
  await expect(accountWarning).toContainText("No usable Claude Code account is available");
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await expect(accountWarning).toHaveCount(0);
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await expect(dialog.getByRole("checkbox", { name: /APP_REGION/ })).toBeChecked();
  await expect(dialog.locator('[data-pick="variables"]')).toContainText("as DEPLOY_REGION, FALLBACK_REGION");
  await dialog.getByRole("button", { name: "Publish revision 2" }).click();
  // Its pinned model account has moved on: the refusal says how to go on, and nothing is published.
  await expect(dialog.getByRole("alert")).toContainText("Untick “Keep its pinned model account”");
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByRole("checkbox", { name: /Keep its pinned model account/ }).uncheck();
  await expect(accountWarning).toContainText("Several Codex accounts are available. Set a default");
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await dialog.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Modal quick fix")).toContainText("Ready");
  const state = await mockState();
  const revisions = state.templateRevisions.filter((r) => r.templateId === "00000000-0000-4000-8000-000000000091");
  expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(revisions.map((r) => (r.definition.variables as { version: number }[])[0]?.version)).toEqual([2, 3]);
  expect(revisions[1]?.definition).not.toHaveProperty("modelAccount");
  // Both keys bound to the one variable are kept: only their version moves.
  expect(revisions[1]?.definition.variables).toEqual([
    { key: "DEPLOY_REGION", variableId: "00000000-0000-4000-8000-000000000080", version: 3 },
    { key: "FALLBACK_REGION", variableId: "00000000-0000-4000-8000-000000000080", version: 3 },
  ]);
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
    ["id", "org", "prompt", "repo", "requestKey", "revision", "ttlSeconds", "modelAccount"].sort(),
  );
});

test("a refused launch says why and takes a fresh key; a successful one opens the sandbox", async ({ page }) => {
  await signIn(page, "alice@example.com", "/templates");
  await row(page, "Backend with docs").getByRole("button", { name: "Launch from Backend with docs" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch Backend with docs" });
  await expect(dialog.getByLabel("Account", { exact: true })).toBeVisible();
  await outcome({
    state: "failed",
    reason: "credential_busy",
    message: "This subscription account is busy. Choose another account.",
    busyAccount: {
      id: "00000000-0000-4000-8000-000000000040",
      name: "Personal Codex",
      sandboxId: "00000000-0000-4000-8000-000000000070",
    },
  });
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("This subscription account is busy. Choose another account.");
  await expect(dialog.getByRole("alert")).toContainText("Account: Personal Codex");
  await expect(dialog.getByRole("link", { name: "Open its sandbox" })).toHaveAttribute(
    "href",
    "/sandboxes/00000000-0000-4000-8000-000000000070",
  );
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

test("Enter on the first step goes to the next one; a taken name is refused in words, choices kept", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/templates");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New template" });
  await dialog.getByLabel("Name").fill("Modal quick fix");
  await dialog.getByLabel("Environment").selectOption({ label: "modal-golden on Modal" });
  await dialog.getByLabel("Model").selectOption("claude-sonnet-5-5");
  await dialog.getByLabel("Name").press("Enter");
  await expect(dialog.getByRole("heading", { name: /Step 2 of 2/ })).toBeFocused();
  expect((await mockState()).templateCalls.filter((call) => call.route === "templates/create")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Publish template" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/A template with this name already exists/);
  // The refusal kept every choice: back on step 1, the model is still the one chosen.
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByLabel("Model")).toHaveValue("claude-sonnet-5-5");
});

test("a retry after an unknown outcome sends the same size, and no launch manifest reaches the page", async ({
  page,
}) => {
  expect(
    (await fetch(`${MOCK}/__test/reset`, { method: "POST", body: JSON.stringify({ sizePolicies: true }) })).ok,
  ).toBe(true);
  await signIn(page, "alice@example.com", "/templates");
  await row(page, "Backend with docs").getByRole("button", { name: "Launch from Backend with docs" }).click();
  const dialog = page.getByRole("dialog", { name: "Launch Backend with docs" });
  await dialog.getByLabel("Machine size").selectOption("xlarge");
  await outcome({ state: "reconciling", reason: "allocation_or_start_unknown" });
  await dialog.getByRole("button", { name: /Launch/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not confirm");
  await expect(dialog.getByLabel("Machine size")).toHaveValue("xlarge");
  await dialog.getByRole("button", { name: /Launch/ }).click();
  const launchCalls = async () => (await mockState()).templateCalls.filter((call) => call.route === "templates/launch");
  await expect.poll(async () => (await launchCalls()).length).toBe(2);
  const [first, second] = await launchCalls();
  expect(first?.body.size).toBe("xlarge");
  expect(second?.body).toEqual(first?.body);
  await expect(dialog.getByRole("alert")).toContainText("could not confirm");
  expect(await page.content()).not.toContain("manifest-canary-5e1d");
});

test("a new revision cannot be published while its tools cannot be read: nothing is dropped silently", async ({
  page,
}) => {
  await fetch(`${MOCK}/__test/fail-connection-list`, { method: "POST" });
  await signIn(page, "alice@example.com", "/templates");
  const shown = await panel(page, "Backend with docs");
  await shown.getByRole("button", { name: "New revision" }).click();
  const dialog = page.getByRole("dialog", { name: "New revision of Backend with docs" });
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await expect(dialog.locator("[data-template-lost]")).toHaveText(/this revision's tools would be lost/);
  await expect(dialog.getByRole("button", { name: "Publish revision 3" })).toBeDisabled();
  // Enter cannot publish either, and the server action refuses on its own.
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByLabel("Environment").press("Enter");
  expect((await mockState()).templateCalls.filter((call) => call.route === "templates/publish")).toHaveLength(0);
});

test("template picker publishes exact pins and keeps earlier revisions immutable when preserving or clearing them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await signIn(page, "alice@example.com", "/templates");
  await (await panel(page, "Backend with docs")).getByRole("button", { name: "New revision" }).click();
  const dialog = page.getByRole("dialog", { name: "New revision of Backend with docs" });
  await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
  await dialog.getByRole("button", { name: "Add skills", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose additional skills" });
  await picker.getByRole("option", { name: /Code review/ }).click();
  await picker.getByLabel("Version", { exact: true }).selectOption("2.0.0");
  await picker.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove review-code@2.0.0" })).toBeVisible();
  await dialog.screenshot({ path: "test-results/template-skill-picker.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Publish revision 3" }).click();
  await expect(dialog).toBeHidden();

  for (const revision of [4, 5]) {
    await (await panel(page, "Backend with docs")).getByRole("button", { name: "New revision" }).click();
    await dialog.getByRole("button", { name: "Next: tools and variables" }).click();
    await expect(dialog.getByRole("button", { name: "Remove review-code@2.0.0" })).toBeVisible();
    if (revision === 5) await dialog.getByRole("button", { name: "Remove review-code@2.0.0" }).click();
    await dialog.getByRole("button", { name: `Publish revision ${revision}` }).click();
    await expect(dialog).toBeHidden();
  }
  const state = await mockState();
  const template = state.templates.find((t) => t.name === "Backend with docs");
  const revisions = state.templateRevisions.filter((r) => r.templateId === template?.id);
  expect(revisions.map((r) => r.definition.skills ?? [])).toEqual([
    [],
    [],
    ["review-code@2.0.0"],
    ["review-code@2.0.0"],
    [],
  ]);
});
