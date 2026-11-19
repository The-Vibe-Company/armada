import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const organization of [
  { session: "alice", name: "Acme", source: "shared-golden", folder: "web", repository: "acme/web" },
  { session: "large", name: "Large", source: "snapshot-002", folder: "fixture", repository: "example/fixture" },
]) {
  test(`${organization.name}: launch a task from the single dialog`, { session: organization.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/sandboxes");
    await screen.getByRole("button", "Launch a sandbox").tap();
    await screen.getByLabel("Task").fill(`Inspect the ${organization.name} fixture`);
    await screen.getByRole("button", "No repository", { exact: true }).tap();
    await screen.getByPlaceholder("Search or type owner/repo").fill(organization.repository);
    await screen.getByRole("option", new RegExp(organization.repository)).tap();
    await screen.getByRole("button", /^From ·/).tap();
    await screen.getByPlaceholder("Search from").fill(organization.source);
    await screen.getByRole("option", new RegExp(organization.source)).tap();
    await screen.getByRole("button", /^Claude Code ·/).tap();
    if (organization.session === "large") {
      await screen.getByRole("button", /^(as |Choose an account)/).tap();
      await screen.getByRole("option", /^model-account-006/).tap();
    }
    await screen
      .getByRole("option", /Claude Opus/, { disabled: false })
      .first()
      .tap();
    await expect(screen.getByRole("button", /^Claude Code ·/)).toContainText(/opus/i);

    await screen.getByRole("button", /^Stops in /).tap();
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

test("Acme: an agent without an account cannot launch", { session: "alice" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Claude Code ·/).tap();
  await screen.getByRole("radio", "Codex", { exact: true }).tap();
  await browser.keyboard.press("Escape");
  await expect(browser.locator("[data-launch-send]")).toHaveAttribute("aria-disabled", "true");
  await expect(screen.getByRole("link", "Add an account")).toBeVisible();
});

test("Large: a full account cannot be selected", { session: "large" }, async ({ app, screen }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^(Claude Code|Codex|OpenCode) ·/).tap();
  await screen.getByRole("button", /^(as |Choose an account)/).tap();
  const limited = screen.getByRole("option", /model-account-0-international/);
  await expect(limited).toHaveAttribute("aria-disabled", "true");
  await expect(limited).toContainText("4 agents running");
});

test("Large: launch on the online Docker host", { session: "large" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await screen.getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^From ·/).tap();
  // Search by the displayed group term: the group label and its search keywords share one wording.
  await screen.getByPlaceholder("Search from").fill("Docker host");
  await expect(screen.getByRole("group", /^Docker hosts$/)).toBeVisible();
  await screen.getByRole("option", /^Empty machine · Large platform/).tap();
  await expect(screen.getByRole("button", /^From · Empty machine · Large platform/)).toBeVisible();
  await screen.getByLabel("Task").fill("Inspect the Docker fixture");
  await screen.getByRole("button", /^(Claude Code|Codex|OpenCode) ·/).tap();
  await screen.getByRole("radio", "Claude Code", { exact: true }).tap();
  await screen.getByRole("button", /^(as |Choose an account)/).tap();
  await screen.getByRole("option", /^model-account-006/).tap();
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
  await screen.getByRole("button", /^Tools ·/).tap();
  const attention = screen.getByRole("region", "Needs attention");
  await expect(attention.getByText("Acme Sentry", { exact: true })).toBeVisible();
  await expect(screen.getByRole("switch", "Acme Sentry")).toHaveCount(0);
});
