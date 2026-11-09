import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("the list shows the sandboxes a member may see and filters them", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await expect(page.getByRole("link", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.getByRole("link", { name: "bx_alice_failed" })).toBeVisible();
  await expect(page.getByText("bx_bob_secret")).toHaveCount(0);

  await page.getByLabel("Harness").selectOption("codex");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/harness=codex/);
  await expect(page.getByRole("link", { name: "bx_alice_failed" })).toBeVisible();
  await expect(page.getByText("bx_alice_running")).toHaveCount(0);

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/sandboxes$/);
  await page.getByLabel("Status").selectOption("running");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("link", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.getByText("bx_alice_failed")).toHaveCount(0);
});

test("another member's private sandbox is not found", async ({ page }) => {
  await signIn(page, "alice@example.com");
  const response = await page.goto(`/sandboxes/${IDS.bobSecret}`);
  expect(response?.status()).toBe(404);
});

test("the logs of a running sandbox refresh without reloading the page", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await page.getByRole("link", { name: "bx_alice_running" }).click();
  await expect(page.getByRole("heading", { name: "bx_alice_running" })).toBeVisible();
  await expect(page.getByText("Fix the failing test")).toBeVisible();
  await expect(page.getByText("Looking at the test suite.")).toBeVisible();
  await expect(page.getByTestId("live-indicator")).toBeVisible();

  await fetch(`${MOCK}/__test/append-event`, {
    method: "POST",
    body: JSON.stringify({ sandbox: IDS.running, text: "All tests pass now." }),
  });
  await expect(page.getByText("All tests pass now.")).toBeVisible({ timeout: 10_000 });
});

test("a usage limit is explained in plain words", async ({ page }) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.failed}`);
  await expect(page.getByText("Usage limit reached")).toBeVisible();
  await expect(page.getByText("hit its plan or billing limit")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage credentials" })).toBeVisible();
});

test("stopping a sandbox asks first, then stops it", async ({ page }) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Stop this sandbox?")).toBeVisible();
  await page.getByRole("button", { name: "Stop sandbox" }).click();
  await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "stopped", { timeout: 10_000 });
});

test("a message sent from the dashboard reaches the sandbox", async ({ page }) => {
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await page.getByRole("button", { name: "Send a message" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Also update the changelog");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Sent. The reply appears in the logs.")).toBeVisible();
  await expect(page.getByText("Also update the changelog")).toBeVisible({ timeout: 10_000 });
});

test("a launch from a golden sends the chosen model and effort, and a send can override them once", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/goldens");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await page.screenshot({ path: "test-results/launch-model-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog")).toBeInViewport();
  await page.screenshot({ path: "test-results/launch-model-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByLabel("Model")).toHaveValue("claude-opus-5-5");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("medium");
  // Repository context of a multi-repo golden: default first, reset when the dialog is reopened.
  const repo = page.getByLabel("Working directory");
  await expect(repo).toHaveValue("");
  await expect(repo.locator("option")).toHaveText(["No repository (default directory)", "web", "api"]);
  await expect(
    page.getByText(
      "A chosen repository is where the agent starts; with none, it starts in the default directory. All repositories remain available.",
    ),
  ).toBeVisible();
  await repo.selectOption("web");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Launch from shared-golden" }).click();
  await expect(page.getByLabel("Working directory")).toHaveValue("");
  await page.getByLabel("Working directory").selectOption("api");
  await page.getByLabel("Agent").selectOption("codex");
  await expect(page.getByLabel("Model")).toHaveValue("gpt-6.1-sol");
  await page.getByLabel("Model").selectOption("gpt-6-luna");
  await expect(page.getByLabel("Reasoning effort").locator("option[value=ultra]")).toHaveCount(0);
  await page.getByLabel("Reasoning effort").selectOption("high");
  await page.getByRole("button", { name: "Launch", exact: true }).click();

  await expect(page).toHaveURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByText("gpt-6-luna")).toBeVisible();
  const facts = page.locator("dl").first();
  await expect(facts.getByText("Repository context")).toBeVisible();
  await expect(facts.getByText("api", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send a message" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Now the docs");
  await page.getByLabel("Reasoning effort").selectOption("low");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Sent. The reply appears in the logs.")).toBeVisible();

  await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
  await page.getByLabel("Model").selectOption("gpt-6-luna");
  await expect(page.getByLabel("Reasoning effort").locator('option[value=""]')).toHaveText("As launched");
  await page.getByLabel("Model").selectOption("gpt-6.1-terra");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
  await expect(page.getByLabel("Reasoning effort").locator('option[value=""]')).toHaveText(
    "Default for selected model (medium)",
  );
  await page.getByRole("textbox", { name: "Message" }).fill("Continue with model default");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  const { launches, toolCalls } = (await (await fetch(`${MOCK}/__test/state`)).json()) as {
    launches: Record<string, unknown>[];
    toolCalls: { name: string; args: Record<string, unknown> }[];
  };
  // The canonical POST /api/v1/sandbox/launch body.
  expect(launches).toEqual([
    {
      golden: "shared-golden",
      provider: "boat",
      org: expect.any(String),
      harness: "codex",
      model: "gpt-6-luna",
      reasoningEffort: "high",
      visibility: "org",
      connections: [],
      repo: "api",
    },
  ]);
  expect(toolCalls).toEqual([
    { name: "send", args: { id: expect.any(String), prompt: "Now the docs", reasoning_effort: "low" } },
    { name: "send", args: { id: expect.any(String), prompt: "Continue with model default", model: "gpt-6.1-terra" } },
  ]);
});

test("a sandbox's lifetime is a quiet fact, and a missed deadline is a notice, never a stopped status", async ({
  page,
}) => {
  const lifecycle = (fields: Record<string, unknown>) =>
    fetch(`${MOCK}/__test/sandbox-lifecycle`, { method: "POST", body: JSON.stringify({ id: IDS.running, fields }) });
  await lifecycle({
    expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    effective_ttl_seconds: 8 * 3600,
    requested_ttl_seconds: null,
    last_observed_at: new Date().toISOString(),
    lifecycle_error: null,
  });
  await signIn(page, "alice@example.com");
  await expect(page.locator('[data-lifecycle="remaining"]')).toHaveText(/^1 h \d+ min left$/);
  await page.getByRole("link", { name: "bx_alice_running" }).click();
  const facts = page.locator("dl").first();
  await expect(facts.getByText("8 h (default)")).toBeVisible();
  await expect(facts.getByText("Last checked")).toBeVisible();
  await expect(page.locator("[data-lifecycle-notice]")).toHaveCount(0);

  await lifecycle({
    expires_at: new Date(Date.now() - 600_000).toISOString(),
    lifecycle_error: "The provider did not answer the stop request.",
  });
  await page.reload();
  const notice = page.locator('[data-lifecycle-notice="retrying"]');
  await expect(notice).toContainText("The provider did not answer the stop request.");
  await expect(notice).toContainText("only once the provider confirms");
  await expect(page.locator("h1 + [data-status]")).toHaveAttribute("data-status", "running");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/sandbox-lifecycle-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/sandboxes");
  await expect(page.locator('[data-lifecycle="retrying"]')).toHaveText("Stop retrying");
});
