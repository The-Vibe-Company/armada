import { expect, type Page, test } from "@playwright/test";
import { createDialog, goldenPanel, goldenRow, LABELS, MOCK, openCreate, reset, signIn } from "./helpers";

type GoldenCall = { route: string; body: Record<string, unknown>; authorized: boolean };
type ToolCall = { name: string; args: Record<string, unknown> };
type CapabilityCall = { body: Record<string, unknown>; authorized: boolean };

async function post(path: string, body: unknown = {}): Promise<Response> {
  const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response;
}

async function mockState(): Promise<{
  goldenCalls: GoldenCall[];
  goldenStatusCalls: Record<string, unknown>[];
  launches: Record<string, unknown>[];
  toolCalls: ToolCall[];
  capabilityCalls: CapabilityCall[];
  goldenRemoveCalls: { body: Record<string, unknown>; authorized: boolean }[];
}> {
  return (await post("/__test/state")).json();
}

test.beforeEach(reset);

test("an admin builds a multi-repo golden: one locked request, a clear result, no token in the body", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", { hold: true });
  await signIn(page, "carol@example.com", "/environments");

  await expect(page.locator('[data-capacity-provider="boat"][data-capacity="available"]')).toContainText("0 of 1");
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("nova-web");
  await expect(form.getByLabel("Everyone in Nova")).toBeChecked();
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByLabel("Branch").fill("develop");
  await form.getByLabel("Directory").fill("app");
  await form.getByRole("button", { name: "Add repository" }).click();
  await form.getByRole("textbox", { name: "Repository 2", exact: true }).fill("https://github.com/acme/api.git");
  await form.getByRole("button", { name: "Add repository" }).click();
  await form.getByRole("button", { name: "Remove repository 3" }).click();
  await expect(form.getByRole("textbox", { name: "Repository 3", exact: true })).toHaveCount(0);
  await form.getByLabel("Init commands").fill("bun install\nmake deps");
  await form.getByLabel("Setup script").fill("echo ready");

  await form.getByRole("button", { name: "Build golden" }).click();
  const busy = form.getByRole("button", { name: "Build golden", exact: true });
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await expect(busy).toBeDisabled();
  // The job id and key are saved under this org's create form only.
  await expect(page).toHaveURL(/[?&]build\.create\.00000000-0000-4000-8000-000000000012=[0-9a-f-]{36}/);
  await expect(page).toHaveURL(/[?&]build-key\.create\.00000000-0000-4000-8000-000000000012=[0-9a-f-]{36}/);
  await busy.click({ force: true });

  // Admission has returned with a durable ID. Polling never resubmits the build.
  await expect.poll(async () => (await mockState()).goldenCalls.length).toBe(1);
  await page.reload();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  expect((await mockState()).goldenCalls).toHaveLength(1);
  await post("/__test/golden-release");
  await expect(form.getByRole("status")).toContainText(/Built Boat golden 'nova-web' and saved snapshot golden-\d+\./);
  await expect(form.getByLabel("Name")).toHaveValue("");

  const { goldenCalls } = await mockState();
  expect(goldenCalls).toHaveLength(1);
  expect(goldenCalls[0]).toEqual({
    route: "golden/create",
    authorized: true,
    body: {
      name: "nova-web",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      org: "00000000-0000-4000-8000-000000000012",
      private: false,
      provider: "boat",
      config: {
        repos: [
          { url: "https://github.com/acme/web.git", branch: "develop", dir: "app" },
          { url: "https://github.com/acme/api.git", branch: "main" },
        ],
        init: ["bun install", "make deps"],
      },
      setup: "echo ready",
    },
  });
  expect(JSON.stringify(goldenCalls[0]?.body)).not.toMatch(/token|bearer|authorization/i);

  const card = await goldenPanel(page, "nova-web");
  await expect(card.getByRole("list", { name: "Repositories of nova-web" })).toContainText("acme/web");
  await expect(card).toContainText("/home/user/app");
  await expect(page.locator('[data-capacity-provider="boat"][data-capacity="full"]')).toContainText("1 of 1");
  // Boat is now full: New says so and offers to rebuild the existing environment instead.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "New", exact: true }).click();
  const full = page.locator("[data-boat-full]");
  await expect(full).toContainText("Every Boat slot is used");
  await full.getByRole("button", { name: "Rebuild nova-web" }).click();
  // The dialog closes onto the environment's panel, which keeps the focus.
  await expect(createDialog(page)).toBeHidden();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/[?&]item=/);
  await expect(page.getByRole("heading", { name: "nova-web", level: 2 })).toBeFocused();
});

test("closing the dialog leaves the build running: New follows it and the list shows the golden once built", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", { hold: true });
  // Poll timers run on a controlled clock, advanced explicitly below instead of waiting.
  await page.clock.install();
  await signIn(page, "carol@example.com", "/environments");
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("nova-web");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await page.keyboard.press("Escape");
  await expect(createDialog(page)).toBeHidden();
  const follower = page.locator("[data-create-build]");
  await expect(follower).toContainText("Building");

  await post("/__test/golden-release");
  await page.clock.runFor(2_500);
  await expect(follower).toHaveText("Built nova-web");
  await expect(goldenRow(page, "nova-web")).toBeVisible();
  // Only status reads: the build was sent once.
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("a refused build shows the server's reason, keeps the form and is not retried", async ({ page }) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", {
    fail: { status: 409, code: "conflict", message: "This backend has reached its golden capacity." },
  });
  await signIn(page, "carol@example.com", "/environments");
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("second");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();

  await expect(form.getByRole("alert")).toContainText("reached its golden capacity");
  await expect(form.getByRole("alert")).toContainText("rebuild the existing golden");
  await expect(form.getByLabel("Name")).toHaveValue("second");
  await expect(form.getByRole("textbox", { name: "Repository 1", exact: true })).toHaveValue("acme/web");
  await expect(form.getByRole("button", { name: "Build golden" })).toBeEnabled();
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("a build whose gateway gives up says it may still finish, and is not retried", async ({ page }) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", { fail: { status: 504, message: "upstream request timeout" } });
  await signIn(page, "carol@example.com", "/environments");
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("slow");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();

  await expect(form.getByRole("alert")).toContainText("may still finish: refresh before trying again");
  await expect(form.getByLabel("Name")).toHaveValue("slow");
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("the capacity is the number the server reads for the selected org, fetched with the session only", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/capabilities", { maxGoldens: 3 });
  await signIn(page, "carol@example.com", "/environments");
  const card = page.locator('[data-capacity-provider="boat"][data-capacity="available"]');
  await expect(card).toContainText("0 of 3");

  const { capabilityCalls } = await mockState();
  expect(capabilityCalls.length).toBeGreaterThan(0);
  // One read per provider, each scoped to the selected org and that provider.
  for (const call of capabilityCalls)
    expect(call).toEqual({
      authorized: true,
      body: { org: "00000000-0000-4000-8000-000000000012", provider: expect.stringMatching(/^(boat|modal)$/) },
    });
  // Nova has connected Boat only: Modal's capacity is not read.
  expect(new Set(capabilityCalls.map((call) => call.body.provider))).toEqual(new Set(["boat"]));
  // Only the number reached the browser: no provider SDK, no token, no raw answer.
  const html = await page.content();
  expect(html).not.toMatch(/maxGoldens|boatdev|BOAT_API_KEY/);
});

test("a capacity the server cannot read is shown as unavailable, with no invented limit or legacy claim", async ({
  page,
}) => {
  // Alice sees two Boat goldens; a hardcoded limit of one would call them legacy.
  await post("/__test/capabilities", {
    fail: { status: 503, code: "unavailable", message: "No Boat credential is configured for this org." },
  });
  await signIn(page, "alice@example.com", "/environments");
  const card = page.locator('[data-capacity-provider="boat"][data-capacity="unavailable"]');
  await expect(card).toContainText("Boat: capacity unavailable");
  await expect(card.locator("[data-capacity-reason]")).toHaveText("No Boat credential is configured for this org.");
  await expect(card).not.toContainText(/\d+ of \d+/);
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  await openCreate(page);
  await expect(page.getByRole("heading", { name: "Create a golden" })).toBeVisible();

  // The server denies a foreign org before resolving a provider: also unavailable, never a number.
  await post("/__test/capabilities", {
    fail: { status: 403, code: "forbidden", message: "You are not a member of this org." },
  });
  await page.reload();
  await expect(
    page.locator('[data-capacity-provider="boat"][data-capacity="unavailable"] [data-capacity-reason]'),
  ).toHaveText("You are not a member of this org.");
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);

  // A null limit is "none reported", not zero and not one.
  await post("/__test/capabilities", { maxGoldens: null });
  await page.reload();
  const unknown = page.locator('[data-capacity-provider="boat"][data-capacity="unknown"]');
  await expect(unknown).toContainText("Boat: no limit");
  await expect(unknown).not.toContainText(/\d+ of \d+/);
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  expect((await mockState()).goldenCalls).toHaveLength(0);
});

test("a form the server would refuse is stopped before any request", async ({ page }) => {
  await post("/__test/reset", { novaOrg: true });
  await signIn(page, "carol@example.com", "/environments");
  const form = await openCreate(page);
  await form.getByLabel("Name").fill("leaky");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("https://gitlab.com/acme/web.git");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("alert")).toContainText("GitHub repository");
  expect((await mockState()).goldenCalls).toHaveLength(0);
});

test("live unbound rows require reconciliation without automatic rebuild guidance", async ({ page }) => {
  await post("/__test/capabilities", {
    bindings: [
      { goldenId: "00000000-0000-4000-8000-000000000020", relation: "unbound" },
      { goldenId: "00000000-0000-4000-8000-000000000021", relation: "other_backend" },
    ],
  });
  await signIn(page, "alice@example.com", "/environments");
  const conflict = page.locator("[data-legacy-conflict]");
  await expect(conflict).toContainText("2 Boat goldens need backend reconciliation");
  await expect(conflict).toContainText("does not choose, merge or delete");
  await expect(conflict.getByText("shared-golden")).toBeVisible();
  await expect(conflict.getByText("alice-private")).toBeVisible();
  // Both rows stay, each with its own actions.
  await expect((await goldenPanel(page, "shared-golden")).getByText("Edit and rebuild")).toBeVisible();
  await expect((await goldenPanel(page, "alice-private")).getByText("Edit and rebuild")).toBeVisible();
  // Reconciliation is separate from current-backend usage, which is zero.
  await openCreate(page);
  await expect(page.getByRole("heading", { name: "Create a golden" })).toBeVisible();
});

test("an admin edits and rebuilds the existing golden from what it records", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  const card = await goldenPanel(page, "shared-golden");
  await card.getByText("Edit and rebuild").click();
  const form = card.locator('form[data-golden-form="update"]');
  await expect(form.getByRole("textbox", { name: "Repository 1", exact: true })).toHaveValue("acme/web");
  await expect(form.getByRole("textbox", { name: "Repository 2", exact: true })).toHaveValue("acme/api");
  await expect(form.getByLabel("Branch").nth(1)).toHaveValue("develop");
  await expect(form.getByLabel("Init commands")).toHaveValue("bun install");
  await expect(form.getByLabel("Name")).toHaveCount(0);

  await form.getByRole("button", { name: "Remove repository 2" }).click();
  await form.getByLabel("Branch").fill("release");
  await form.getByRole("button", { name: "Rebuild golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Rebuilt Boat golden 'shared-golden' and saved snapshot/);

  const { goldenCalls } = await mockState();
  expect(goldenCalls).toHaveLength(1);
  expect(goldenCalls[0]?.route).toBe("golden/update");
  expect(goldenCalls[0]?.body).toEqual({
    name: "shared-golden",
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    org: "00000000-0000-4000-8000-000000000010",
    provider: "boat",
    config: {
      repos: [{ url: "https://github.com/acme/web.git", branch: "release", dir: "web" }],
      init: ["bun install"],
    },
  });
  await expect(card.getByRole("list", { name: "Repositories of shared-golden" })).not.toContainText("acme/api");
});

test("a member sees why they cannot rebuild an org golden or create one for the org", async ({ page }) => {
  await signIn(page, "bob@example.com", "/environments");
  await expect((await goldenPanel(page, "shared-golden")).locator("[data-rebuild-blocked]")).toHaveText(
    "Only an org admin rebuilds an org golden.",
  );
  const form = await openCreate(page);
  await expect(form.getByLabel("Everyone in Acme")).toBeDisabled();
  await expect(form.getByLabel("Only me")).toBeChecked();
  await expect(form).toContainText("Only an org admin creates org goldens.");
});

test("the launch form starts the agent in a recorded repository, sent as repo", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  const dialog = page.getByRole("dialog");
  // A golden with several repositories asks for the project next to the agent, without opening Advanced.
  const select = dialog.getByLabel("Project");
  await expect(select.locator("option")).toHaveText(["Default directory", "web", "api"]);
  await select.selectOption("api");
  await dialog.getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  const launches = (await mockState()).launches;
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ golden: "shared-golden", provider: "boat", repo: "api" });
  expect(String(launches[0]?.prompt ?? "")).not.toContain("acme/api");
});

test("a launch with no repository chosen keeps the legacy behaviour", async ({ page }) => {
  await signIn(page, "alice@example.com", "/environments");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launches = (await mockState()).launches;
  expect(launches).toHaveLength(1);
  expect(launches[0]).not.toHaveProperty("repo");
});

test("an admin builds a Modal golden: the request names Modal and Modal's unbounded capacity is no limit", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true, novaModal: true });
  await signIn(page, "carol@example.com", "/environments");
  const modalCard = page.locator('[data-capacity-provider="modal"]');
  await expect(modalCard).toHaveAttribute("data-capacity", "unknown");
  await expect(modalCard).toContainText("Modal: no limit");
  await expect(modalCard).not.toContainText(/\d+ of \d+/);

  const form = await openCreate(page);
  const modal = form.getByRole("radio", { name: /Modal/ });
  await expect(form.getByRole("radio", { name: /Boat/ })).toBeChecked();
  await expect(form.locator('[data-provider-choice="modal"]')).toContainText("No golden limit reported.");
  await modal.check();
  await form.getByLabel("Name").fill("nova-docs");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/docs");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Built Modal golden 'nova-docs' and saved snapshot/);

  const { goldenCalls } = await mockState();
  expect(goldenCalls).toEqual([
    {
      route: "golden/create",
      authorized: true,
      body: {
        name: "nova-docs",
        org: "00000000-0000-4000-8000-000000000012",
        private: false,
        provider: "modal",
        config: { repos: [{ url: "https://github.com/acme/docs.git", branch: "main" }], init: [] },
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    },
  ]);
  await expect(goldenRow(page, "nova-docs", "modal")).toContainText("Ready");
  await expect(await goldenPanel(page, "nova-docs", "modal")).toContainText("golden-");
  // A Modal golden does not use the Boat account's one slot.
  await expect(page.locator('[data-capacity-provider="boat"]')).toContainText("0 of 1");
  await page.screenshot({ path: "test-results/goldens-modal-desktop.png", fullPage: true });
});

test("with only Boat connected, Boat is used without a choice and a forged Modal build never reaches the server", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await signIn(page, "carol@example.com", "/environments");
  await expect(page.locator("[data-capacity-provider]")).toHaveCount(1);
  await expect(page.locator('[data-capacity-provider="boat"][data-capacity="available"]')).toContainText("0 of 1");

  const form = await openCreate(page);
  await expect(form.locator('[data-provider-fixed="boat"]')).toContainText("Boat");
  await expect(form.locator('[data-provider-fixed="boat"] [data-permanent]')).toHaveText("Cannot be changed later");
  await expect(form.locator("[data-provider-choice]")).toHaveCount(0);
  await form.getByLabel("Name").fill("nova-docs");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/docs");
  // A post naming Modal, which Nova has not connected, is refused by the action itself.
  await form.locator('input[name="provider"]').evaluate((input) => {
    (input as HTMLInputElement).value = "modal";
  });
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "Modal is not connected for this organization. An admin connects it in Settings.",
  );
  expect((await mockState()).goldenCalls).toHaveLength(0);
  await expect(page.locator('[data-golden="nova-docs"]')).toHaveCount(0);
});

test("same-name goldens on Boat and Modal are listed apart, and rebuild and launch target their own provider", async ({
  page,
}) => {
  await post("/__test/reset", { modalTwin: true, acmeModal: true });
  await signIn(page, "alice@example.com", "/environments");
  await expect(goldenRow(page, "shared-golden")).toHaveCount(2);
  // Different providers: not flagged as a shared name, and each records its own repositories.
  await expect(page.getByText("Name shared by another golden")).toHaveCount(0);
  const boat = await goldenPanel(page, "shared-golden", "boat");
  await expect(boat.getByRole("list", { name: "Repositories of shared-golden on Boat" })).toContainText("acme/web");
  const modal = await goldenPanel(page, "shared-golden", "modal");
  await expect(modal.getByRole("list", { name: "Repositories of shared-golden on Modal" })).toContainText("acme/docs");

  await modal.getByText("Edit and rebuild").click();
  const form = modal.locator('form[data-golden-form="update"]');
  await expect(form).toHaveAttribute("aria-label", "Rebuild shared-golden on Modal");
  await expect(form.getByRole("textbox", { name: "Repository 1", exact: true })).toHaveValue("acme/docs");
  await form.getByLabel("Branch").fill("next");
  await form.getByRole("button", { name: "Rebuild golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Rebuilt Modal golden 'shared-golden'/);
  expect((await mockState()).goldenCalls).toEqual([
    {
      route: "golden/update",
      authorized: true,
      body: {
        name: "shared-golden",
        org: "00000000-0000-4000-8000-000000000010",
        provider: "modal",
        config: { repos: [{ url: "https://github.com/acme/docs.git", branch: "next", dir: "docs" }], init: [] },
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    },
  ]);
  // The Boat twin was not touched.
  await goldenPanel(page, "shared-golden", "boat");
  await expect(boat.getByRole("list", { name: "Repositories of shared-golden on Boat" })).toContainText("develop");

  await page.getByRole("button", { name: "Launch from shared-golden on Modal" }).click();
  const dialog = page.getByRole("dialog");
  // A single repository is the default project; choosing another directory stays in Advanced.
  await expect(dialog.getByLabel("Project")).toHaveValue("docs");
  await expect(dialog.getByLabel("Project").locator("option")).toHaveText(["Default directory", "docs"]);
  const summary = dialog.locator("[data-launch-summary]");
  await expect(summary).toContainText("docs");
  await dialog
    .locator("[data-launch-advanced]")
    .getByRole("button", { name: /^Advanced/ })
    .click();
  await dialog.getByLabel("Project").selectOption("");
  await expect(summary).toContainText("Default directory");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/goldens-providers-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Launch from shared-golden on Modal" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launches = (await mockState()).launches;
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ golden: "shared-golden", provider: "modal" });
});

const NOVA = "00000000-0000-4000-8000-000000000012";

async function fillCreate(page: Page, name: string, repo: string) {
  const form = await openCreate(page);
  await form.getByLabel("Name").fill(name);
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill(repo);
  return form;
}

test("an admission whose answer is lost is recovered by its saved key after a reload, and never sent again", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  // The server admits the job, then a gateway in front of it loses the 202.
  await post("/__test/golden-gate", { hold: true, loseAnswer: true });
  await signIn(page, "carol@example.com", "/environments");
  const form = await fillCreate(page, "nova-web", "acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("alert")).toContainText("may still finish");
  const key = new URL(page.url()).searchParams.get(`build-key.create.${NOVA}`);
  expect(key).toMatch(/^[0-9a-f-]{36}$/);

  await post("/__test/golden-gate", { hold: true });
  await page.reload();
  // The saved key reads the admitted job back; the build is not submitted again.
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  const recovered = await mockState();
  expect(recovered.goldenCalls).toHaveLength(1);
  expect(recovered.goldenStatusCalls[0]).toEqual({ org: NOVA, idempotencyKey: key });
  await expect(page).toHaveURL(new RegExp(`[?&]build\\.create\\.${NOVA}=[0-9a-f-]{36}`));

  await post("/__test/golden-release");
  await expect(form.getByRole("status")).toContainText(/Built Boat golden 'nova-web' and saved snapshot golden-\d+\./);
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("a status read that fails pauses polling and keeps the job locked; checking again resumes, nothing is resent", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", { hold: true });
  await signIn(page, "carol@example.com", "/environments");
  const form = await fillCreate(page, "nova-web", "acme/web");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);

  await post("/__test/golden-gate", { hold: true, failStatus: true });
  await expect(form.getByRole("alert")).toContainText("Polling paused. Check this job again; do not resubmit.");
  // Still the same admitted job: not cancelled, not succeeded, and nothing can be sent again meanwhile.
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await expect(form.getByRole("button", { name: "Build golden", exact: true })).toBeDisabled();
  await expect(form.getByLabel("Name")).toBeDisabled();

  await post("/__test/golden-gate", { hold: false });
  await form.getByRole("button", { name: "Check build status" }).click();
  await expect(form.getByRole("status")).toContainText(/Built Boat golden 'nova-web'/);
  await expect(form.getByRole("alert")).toHaveCount(0);
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("a build is tracked by its own form: never by the twin on the other provider, the create form or another org", async ({
  page,
}) => {
  await post("/__test/reset", { modalTwin: true, multiOrg: true, acmeModal: true });
  await post("/__test/golden-gate", { hold: true });
  await signIn(page, "alice@example.com", "/environments");
  const modal = await goldenPanel(page, "shared-golden", "modal");
  await modal.getByText("Edit and rebuild").click();
  const modalForm = modal.locator('form[data-golden-form="update"]');
  await modalForm.getByLabel("Branch").fill("next");
  await modalForm.getByRole("button", { name: "Rebuild golden" }).click();
  await expect(modalForm.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  const tracked = new URL(page.url());

  await page.reload();
  // The reload reopens the panel of the golden whose build the URL follows.
  await expect(modal).toBeVisible();
  await modal.getByText("Edit and rebuild").click();
  await expect(modalForm.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  // The Boat twin's rebuild and the create form show no build and stay usable.
  const boat = await goldenPanel(page, "shared-golden", "boat");
  await boat.getByText("Edit and rebuild").click();
  const boatForm = boat.locator('form[data-golden-form="update"]');
  await expect(boatForm.getByRole("status")).toHaveCount(0);
  await expect(boatForm.getByRole("button", { name: "Rebuild golden" })).toBeEnabled();
  await expect((await openCreate(page)).getByRole("status")).toHaveCount(0);
  // Recorded under this golden's rebuild only.
  expect([...tracked.searchParams.keys()].filter((name) => name.startsWith("build."))).toEqual([
    "build.rebuild.00000000-0000-4000-8000-000000000024",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/golden-build-scoped-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  // In another org, the same URL reads and resubmits nothing.
  await page.getByLabel("Active organization").selectOption("00000000-0000-4000-8000-000000000011");
  // The switch is done only when its action has redirected to the bare page and Zenith's rows are shown: the
  // Goldens heading was already visible, and navigating before the action finishes would abort it.
  await expect(page).toHaveURL(/\/environments$/);
  await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
  const before = (await mockState()).goldenStatusCalls.length;
  await page.goto(`/environments?${tracked.searchParams.toString()}`);
  await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
  await expect(page.locator("form[data-golden-form] [role=status]")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect((await mockState()).goldenStatusCalls).toHaveLength(before);
  expect((await mockState()).goldenCalls).toHaveLength(1);
});

test("an org switch that re-renders the page in place leaves the old org's create build behind", async ({
  page,
  context,
}) => {
  await post("/__test/reset", { multiOrg: true, acmeModal: true });
  await post("/__test/golden-gate", { hold: true });
  // Poll timers run on a controlled clock, advanced explicitly below instead of waiting.
  await page.clock.install();
  await signIn(page, "alice@example.com", "/environments");
  const form = await openCreate(page);
  await form.getByRole("radio", { name: /Modal/ }).check();
  await form.getByLabel("Name").fill("acme-docs");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("acme/docs");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("status")).toContainText(/Build .*: (queued|running)/);
  await expect(form.getByLabel("Name")).toBeDisabled();
  const tracked = page.url();

  // Another tab selects Zenith. This tab still shows Acme until its page is next rendered.
  const other = await context.newPage();
  await other.goto("/environments");
  await other.getByLabel("Active organization").selectOption("00000000-0000-4000-8000-000000000011");
  await expect(other.locator('[data-golden="zenith-golden"]')).toBeVisible();
  await other.close();

  // The build finishes; this tab's poll revalidates the page, which re-renders in place for Zenith (same URL).
  await post("/__test/golden-release");
  await page.clock.runFor(2_500);
  // The create dialog stays open over the re-rendered list, which now holds Zenith's golden.
  await expect(page.locator('[data-golden="zenith-golden"]')).toBeVisible();
  expect(page.url()).toBe(tracked);
  await openCreate(page);
  // Zenith's create form starts clean: no Acme job, unlocked, nothing to recover.
  await expect(form.getByRole("status")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "New build request" })).toHaveCount(0);
  await expect(form.getByLabel("Name")).toBeEnabled();
  await expect(form.getByLabel("Name")).toHaveValue("");
  await expect(form.getByRole("button", { name: "Build golden", exact: true })).toBeEnabled();

  // Well past several poll intervals: no status read and no build request comes from Zenith's page.
  const before = await mockState();
  await page.clock.runFor(10_000);
  const after = await mockState();
  expect(after.goldenStatusCalls.slice(before.goldenStatusCalls.length)).toEqual([]);
  expect(after.goldenCalls).toHaveLength(1);
});

test("removing a golden asks first, retires only the golden, and keeps its sandboxes and history", async ({
  page,
  context,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  // A crafted link cannot announce a removal: neither a live golden's id nor a bare name shows a confirmation.
  for (const removed of ["00000000-0000-4000-8000-000000000020", "shared-golden"]) {
    await page.goto(`/environments?removed=${removed}`);
    await expect(page.locator('[data-golden="shared-golden"]')).toBeVisible();
    await expect(page.locator("[data-golden-removed]")).toHaveCount(0);
  }
  // Another tab still shows the launch dialog of the golden about to be removed.
  const stale = await context.newPage();
  await stale.goto("/environments");
  await stale.getByRole("button", { name: "Launch from shared-golden" }).click();

  const card = await goldenPanel(page, "shared-golden");
  await card.getByRole("button", { name: "Remove golden" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove shared-golden on Boat?");
  await expect(confirm).toContainText("Sandboxes already started from it stay, with their conversations and logs");
  await page.screenshot({ path: "test-results/golden-remove-confirm.png", animations: "disabled" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
  expect((await mockState()).goldenRemoveCalls).toEqual([]);

  await card.getByRole("button", { name: "Remove golden" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove golden" }).click();
  await expect(page).toHaveURL(/\/environments\?removed=00000000-0000-4000-8000-000000000020$/);
  await expect(page.locator("[data-golden-removed]")).toContainText("Removed shared-golden");
  // The tombstone stays readable in the database; the page itself must leave it out.
  await expect(page.locator('[data-golden="shared-golden"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Launch from shared-golden/ })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-golden="shared-golden"]')).toHaveCount(0);
  // Retirement keeps the provider slot (#566): the Boat count still includes it and says removing does not free it.
  const boat = page.locator('[data-capacity-provider="boat"]');
  await expect(boat).toHaveAttribute("data-capacity", "legacy");
  await expect(boat).toHaveAttribute("data-capacity-removed", "1");
  await expect(boat).toContainText("2 of 1");
  await expect(boat.locator("[data-capacity-line]")).toHaveText("Boat: 2 of 1 slot used, 1 by removed environment");
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  // One request, by id in the selected org, with the session; never a delete of anything else.
  expect((await mockState()).goldenRemoveCalls).toEqual([
    {
      body: { id: "00000000-0000-4000-8000-000000000020", org: "00000000-0000-4000-8000-000000000010" },
      authorized: true,
    },
  ]);

  // A launch prepared before the removal is refused by the dashboard's own selection, before the server.
  await stale.getByRole("dialog").getByRole("button", { name: "Launch", exact: true }).click();
  await expect(stale.getByRole("dialog").getByRole("alert")).toContainText(
    "That golden is not available in this organization.",
  );
  expect((await mockState()).launches).toEqual([]);
  await stale.close();

  // Its sandboxes keep their history, and the sandbox's own page still names the golden it started from (the list's
  // metadata names no golden, #680).
  await page.goto("/sandboxes");
  await page.getByRole("link", { name: LABELS.running }).click();
  await expect(page.getByRole("heading", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.locator("dl").first()).toContainText("shared-golden (removed)");
  await expect(page.getByText("Fix the failing test")).toBeVisible();
});

test("only the owner or an org admin is offered removal, and a forged removal is refused before the server", async ({
  page,
}) => {
  await signIn(page, "bob@example.com", "/environments");
  await expect((await goldenPanel(page, "shared-golden")).getByRole("button", { name: "Remove golden" })).toHaveCount(
    0,
  );
  const own = await goldenPanel(page, "bob-private");
  await own.getByRole("button", { name: "Remove golden" }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.locator('input[name="golden"]').evaluate((input) => {
    (input as HTMLInputElement).value = "00000000-0000-4000-8000-000000000020";
  });
  await confirm.getByRole("button", { name: "Remove golden" }).click();
  await expect(confirm.getByRole("alert")).toContainText("Only an org admin removes an org golden.");
  expect((await mockState()).goldenRemoveCalls).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-golden="bob-private"]')).toBeVisible();
});

test("removed unbound history is not a slot or a reconciliation warning; old metadata has no usage", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/environments");
  await (await goldenPanel(page, "shared-golden")).getByRole("button", { name: "Remove golden" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove golden" }).click();
  await expect(page.locator("[data-golden-removed]")).toBeVisible();
  await post("/__test/capabilities", {
    bindings: [
      { goldenId: "00000000-0000-4000-8000-000000000020", relation: "unbound" },
      { goldenId: "00000000-0000-4000-8000-000000000021", relation: "current_backend" },
    ],
  });
  await page.reload();
  await expect(page.locator('[data-capacity-provider="boat"]')).toContainText("1 of 1");
  await expect(page.locator('[data-capacity-provider="boat"]')).toHaveAttribute("data-capacity-removed", "0");
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  await post("/__test/capabilities", { bindings: null });
  await page.reload();
  await expect(page.locator('[data-capacity-provider="boat"]')).toHaveAttribute("data-capacity", "unavailable");
});
