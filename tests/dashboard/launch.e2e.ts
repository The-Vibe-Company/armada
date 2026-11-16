import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const organization of [
  { session: "alice", name: "Acme", source: "shared-golden", folder: "web" },
  { session: "large", name: "Large", source: "snapshot-002", folder: "fixture" },
]) {
  test(`${organization.name}: launch a task from the single dialog`, { session: organization.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/sandboxes");
    await screen.getByRole("button", "Launch a sandbox").tap();
    await screen.getByLabel("Task").fill(`Inspect the ${organization.name} fixture`);
    await screen.getByRole("button", /^Starts from:/).tap();
    await screen.getByPlaceholder("Search starts from").fill(organization.source);
    await screen.getByRole("option", new RegExp(organization.source)).tap();
    await expect(screen.getByRole("button", /^Agent settings:/)).toBeVisible();
    await screen.getByRole("button", /^Account:/).tap();
    // Account and model are one picker; an enabled model pins both together.
    await screen
      .getByRole("option", /Claude Opus/, { disabled: false })
      .first()
      .tap();
    await expect(screen.getByRole("button", /^Agent settings:/)).toContainText(/opus/i);
    await expect(screen.getByRole("button", /^Account:/)).not.toContainText("Choose an account");
    await screen.getByRole("button", /^Folder:/).tap();
    await screen.getByRole("option", new RegExp(`^${organization.folder || "default"}(?: Selected)?$`)).tap();
    await screen.getByRole("button", /^Runs for up to:/).tap();
    await screen.getByRole("option", "1 hour").tap();
    await screen.getByRole("button", "Launch", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/sandboxes\/[0-9a-f-]+$/);
    await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
    const response = await fetch("http://127.0.0.1:54399/__test/state");
    if (!response.ok) throw new Error("Could not read fixture launch receipt");
    const state = await response.json();
    expect(state.launches.at(-1)).toMatchObject({
      golden: organization.source,
      provider: "boat",
      harness: "claude",
      model: "claude-opus-5-5",
      prompt: `Inspect the ${organization.name} fixture`,
      repo: organization.folder,
      ttlSeconds: 3600,
    });
  });
}

test("Acme: an agent without an account cannot launch", { session: "alice" }, async ({ app, screen }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Agent settings:/).tap();
  await screen.getByRole("button", /^Agent:/).tap();
  await screen.getByRole("option", "Codex", { exact: true }).tap();
  await expect(screen.getByRole("button", "Launch", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("link", "Add an account")).toBeVisible();
});

test("Large: a full account cannot be selected", { session: "large" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Account:/).tap();
  const limited = browser.locator("[cmdk-group]").filter({ hasText: "model-account-0-international" });
  await expect(limited.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");
  await expect(limited).toContainText("4 agents running");
});

test("Large: launch on the online Docker host", { session: "large" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Starts from:/).tap();
  await screen.getByPlaceholder("Search starts from").fill("Empty machine");
  await screen.getByRole("option", /^Empty machine · Large platform/).tap();
  await screen.getByLabel("Task").fill("Inspect the Docker fixture");
  await screen.getByRole("button", /^Account:/).tap();
  await screen
    .getByRole("option", /Claude Opus/, { disabled: false })
    .first()
    .tap();
  await screen.getByRole("button", "Launch", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/sandboxes\/[0-9a-f-]+$/);
  await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
  const response = await fetch("http://127.0.0.1:54399/__test/state");
  if (!response.ok) throw new Error("Could not read fixture launch receipt");
  const state = await response.json();
  expect(state.launches.at(-1)).toMatchObject({
    provider: "docker",
    hostId: "00000000-0000-4000-8000-000000009000",
    harness: "claude",
    prompt: "Inspect the Docker fixture",
  });
});

test("Acme: a disconnected tool cannot be selected", { session: "alice" }, async ({ app, screen }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Tools/).tap();
  await expect(screen.getByRole("checkbox", "Acme Sentry")).toBeDisabled();
});
