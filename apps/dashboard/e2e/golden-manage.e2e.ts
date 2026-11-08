import { expect, type Page, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

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
  toolCalls: ToolCall[];
  capabilityCalls: CapabilityCall[];
}> {
  return (await post("/__test/state")).json();
}

function createForm(page: Page) {
  return page.locator('form[data-golden-form="create"]');
}

test.beforeEach(reset);

test("an admin builds a multi-repo golden: one locked request, a clear result, no token in the body", async ({
  page,
}) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", { hold: true });
  await signIn(page, "carol@example.com", "/goldens");

  await expect(page.locator('[data-capacity="available"]')).toContainText("0 of 1");
  const form = createForm(page);
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
  const busy = form.getByRole("button", { name: "Building…" });
  await expect(busy).toBeDisabled();
  await expect(form.getByRole("status")).toContainText("cloning, scanning and snapshotting");
  await expect(form.getByRole("textbox", { name: "Repository 1", exact: true })).toBeDisabled();
  await busy.click({ force: true });

  // The one request is held on the server while the page shows it pending; the forced second click sent nothing.
  await expect.poll(async () => (await mockState()).goldenCalls.length).toBe(1);
  await post("/__test/golden-release");
  await expect(form.getByRole("status")).toContainText(/Built golden 'nova-web' and saved snapshot golden-\d+\./);
  await expect(form.getByLabel("Name")).toHaveValue("");

  const { goldenCalls } = await mockState();
  expect(goldenCalls).toHaveLength(1);
  expect(goldenCalls[0]).toEqual({
    route: "golden/create",
    authorized: true,
    body: {
      name: "nova-web",
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

  const card = page.locator('[data-golden="nova-web"]');
  await expect(card.getByRole("list", { name: "Repositories of nova-web" })).toContainText("acme/web");
  await expect(card).toContainText("/home/user/app");
  await expect(page.locator('[data-capacity="full"]')).toContainText("1 of 1");
  await expect(page.getByText("Show the create form")).toBeVisible();
});

test("a refused build shows the server's reason, keeps the form and is not retried", async ({ page }) => {
  await post("/__test/reset", { novaOrg: true });
  await post("/__test/golden-gate", {
    fail: { status: 409, code: "conflict", message: "This backend has reached its golden capacity." },
  });
  await signIn(page, "carol@example.com", "/goldens");
  const form = createForm(page);
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
  await signIn(page, "carol@example.com", "/goldens");
  const form = createForm(page);
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
  await signIn(page, "carol@example.com", "/goldens");
  const card = page.locator('[data-capacity="available"]');
  await expect(card).toContainText("holds 3 goldens");
  await expect(card).toContainText("0 of 3");

  const { capabilityCalls } = await mockState();
  expect(capabilityCalls.length).toBeGreaterThan(0);
  for (const call of capabilityCalls)
    expect(call).toEqual({ authorized: true, body: { org: "00000000-0000-4000-8000-000000000012", provider: "boat" } });
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
  await signIn(page, "alice@example.com", "/goldens");
  const card = page.locator('[data-capacity="unavailable"]');
  await expect(card).toContainText("Capacity unavailable");
  await expect(card.locator("[data-capacity-reason]")).toHaveText("No Boat credential is configured for this org.");
  await expect(card).not.toContainText(/\d+ of \d+/);
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create a golden" })).toBeVisible();

  // The server denies a foreign org before resolving a provider: also unavailable, never a number.
  await post("/__test/capabilities", {
    fail: { status: 403, code: "forbidden", message: "You are not a member of this org." },
  });
  await page.reload();
  await expect(page.locator('[data-capacity="unavailable"] [data-capacity-reason]')).toHaveText(
    "You are not a member of this org.",
  );
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);

  // A null limit is "none reported", not zero and not one.
  await post("/__test/capabilities", { maxGoldens: null });
  await page.reload();
  const unknown = page.locator('[data-capacity="unknown"]');
  await expect(unknown).toContainText("reports no golden limit");
  await expect(unknown).not.toContainText(/\d+ of \d+/);
  await expect(page.locator("[data-legacy-conflict]")).toHaveCount(0);
  expect((await mockState()).goldenCalls).toHaveLength(0);
});

test("a form the server would refuse is stopped before any request", async ({ page }) => {
  await post("/__test/reset", { novaOrg: true });
  await signIn(page, "carol@example.com", "/goldens");
  const form = createForm(page);
  await form.getByLabel("Name").fill("leaky");
  await form.getByRole("textbox", { name: "Repository 1", exact: true }).fill("https://gitlab.com/acme/web.git");
  await form.getByRole("button", { name: "Build golden" }).click();
  await expect(form.getByRole("alert")).toContainText("GitHub repository");
  expect((await mockState()).goldenCalls).toHaveLength(0);
});

test("legacy rows over the Boat limit are listed and kept, never chosen or merged", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  const conflict = page.locator("[data-legacy-conflict]");
  await expect(conflict).toContainText("2 Boat goldens predate the one-golden limit");
  await expect(conflict).toContainText("does not choose, merge or delete");
  await expect(conflict.getByText("shared-golden")).toBeVisible();
  await expect(conflict.getByText("alice-private")).toBeVisible();
  // Both rows stay, each with its own actions.
  await expect(page.locator('[data-golden="shared-golden"]').getByText("Edit and rebuild")).toBeVisible();
  await expect(page.locator('[data-golden="alice-private"]').getByText("Edit and rebuild")).toBeVisible();
  // Creating another is not the primary path.
  await expect(page.getByRole("heading", { name: "Create another golden" })).toBeVisible();
  await expect(createForm(page)).toBeHidden();
});

test("an admin edits and rebuilds the existing golden from what it records", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  const card = page.locator('[data-golden="shared-golden"]');
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
  await expect(form.getByRole("status")).toContainText(/Rebuilt golden 'shared-golden' and saved snapshot/);

  const { goldenCalls } = await mockState();
  expect(goldenCalls).toHaveLength(1);
  expect(goldenCalls[0]?.route).toBe("golden/update");
  expect(goldenCalls[0]?.body).toEqual({
    name: "shared-golden",
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
  await signIn(page, "bob@example.com", "/goldens");
  await expect(page.locator('[data-golden="shared-golden"] [data-rebuild-blocked]')).toHaveText(
    "Only an org admin rebuilds an org golden.",
  );
  await page.getByText("Show the create form").click();
  const form = createForm(page);
  await expect(form.getByLabel("Everyone in Acme")).toBeDisabled();
  await expect(form.getByLabel("Only me")).toBeChecked();
  await expect(form).toContainText("Only an org admin creates org goldens.");
});

test("the launch form starts the agent in a recorded repository, sent as repo", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  const dialog = page.getByRole("dialog");
  const select = dialog.getByLabel("Working directory");
  await expect(select.locator("option")).toHaveText(["No repository (default directory)", "acme/web", "acme/api"]);
  await select.selectOption("acme/api");
  await dialog.getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);

  const launches = (await mockState()).toolCalls.filter((call) => call.name === "launch");
  expect(launches).toHaveLength(1);
  expect(launches[0]?.args).toMatchObject({ golden: "shared-golden", provider: "boat", repo: "acme/api" });
  expect(String(launches[0]?.args.prompt ?? "")).not.toContain("acme/api");
});

test("a launch with no repository chosen keeps the legacy behaviour", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Launch" }).click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const launches = (await mockState()).toolCalls.filter((call) => call.name === "launch");
  expect(launches[0]?.args).not.toHaveProperty("repo");
});

test("the main navigation groups Run, Build and Account and marks the current page", async ({ page }) => {
  await signIn(page, "alice@example.com", "/goldens");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Goldens" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Goldens" })).toHaveAttribute("title", "Repositories and snapshots");
  await expect(nav.getByText("Build", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Credentials" }).click();
  await page.waitForURL("**/credentials");
  await expect(nav.getByRole("link", { name: "Credentials" })).toHaveAttribute("aria-current", "page");
});
