import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { e2eFixture, fixtureOrigin } from "../../scripts/fixture-ports.ts";

const mock = fixtureOrigin(e2eFixture.mockPort);

async function configureFixture(path: string, body: object) {
  const response = await fetch(`${mock}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture configuration failed: ${path}`);
}

async function ensureFixtureGitHub() {
  const user = "00000000-0000-4000-8000-000000000001";
  const response = await fetch(`${mock}/__test/github-connections`);
  if (!response.ok) throw new Error("Could not read the fixture GitHub connection");
  const accounts: { user_id: string }[] = await response.json();
  if (!accounts.some((account) => account.user_id === user))
    await configureFixture("github-connect", { user, login: "fixture_user" });
}

for (const organization of [
  { session: "alice", name: "Acme", source: "shared-golden", folder: "web", repository: "acme/web" },
  { session: "large", name: "Large", source: "snapshot-002", folder: "fixture" },
]) {
  test(`${organization.name}: launch a task from the single dialog`, { session: organization.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/sandboxes");
    const desktop = await browser.evaluate(() => window.innerWidth >= 768);
    const launch = browser.locator("[data-page-launch]").getByRole("button", /^Launch a sandbox/);
    await expect(launch).toHaveCount(1);
    await expect(screen.getByRole("button", /^Launch a sandbox/)).toHaveCount(desktop ? 2 : 1);
    await launch.tap();
    await screen.getByLabel("Task").fill(`Inspect the ${organization.name} fixture`);
    if (organization.repository) {
      await screen.getByRole("button", "No repository", { exact: true }).tap();
      await screen.getByPlaceholder("Search repos or type owner/repo").fill(organization.repository);
      await screen.getByRole("option", new RegExp(organization.repository)).tap();
    }
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
    const response = await fetch(`${mock}/__test/state`);
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

test("Acme: empty Sandboxes shows launch entry without duplicating mobile shell launch", { session: "alice" }, async ({
  app,
  screen,
  browser,
}) => {
  await configureFixture("sandbox-inventory", { hidden: true });
  try {
    await app.open("/sandboxes");
    const desktop = await browser.evaluate(() => window.innerWidth >= 768);
    await expect(screen.getByText("No sandboxes yet", { exact: true })).toBeVisible();
    await expect(browser.locator("[data-page-launch]").getByRole("button", /^Launch a sandbox/)).toHaveCount(1);
    await expect(screen.getByRole("button", /^Launch a sandbox/)).toHaveCount(desktop ? 3 : 2);
  } finally {
    await configureFixture("sandbox-inventory", { hidden: false });
  }
});

test("Acme: launch is available from a page without a header launch action", { session: "alice" }, async ({
  app,
  screen,
}) => {
  await app.open("/variables");
  const launch = screen.getByRole("button", /^Launch a sandbox/);
  await expect(launch).toHaveCount(1);
  await launch.tap();
  await expect(screen.getByRole("dialog", "Launch a sandbox")).toBeVisible();
});

test("Acme: an agent without an account cannot launch", { session: "alice" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Claude Code ·/).tap();
  await screen.getByRole("radio", "Codex", { exact: true }).tap();
  await browser.keyboard.press("Escape");
  await expect(browser.locator("[data-launch-send]")).toHaveAttribute("aria-disabled", "true");
  await expect(screen.getByRole("link", "Add an account")).toBeVisible();
});

test("Large: a full account cannot be selected", { session: "large" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^(Claude Code|Codex|OpenCode) ·/).tap();
  await screen.getByRole("button", /^(as |Choose an account)/).tap();
  const limited = screen.getByRole("option", /model-account-0-international/);
  await expect(limited).toHaveAttribute("aria-disabled", "true");
  await expect(limited).toContainText("4 agents running");
});

test("Large: launch on the online Docker host", { session: "large" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^From ·/).tap();
  await screen.getByPlaceholder("Search from").fill("Docker host");
  await expect(screen.getByRole("group", /^Docker hosts$/)).toBeVisible();
  await screen.getByRole("option", /^Base Armada image · Large platform/).tap();
  await expect(screen.getByRole("button", /^From · Base Armada image · Large platform/)).toBeVisible();
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
  const response = await fetch(`${mock}/__test/state`);
  if (!response.ok) throw new Error("Could not read fixture launch receipt");
  const state = await response.json();
  expect(state.launches.at(-1)).toMatchObject({
    provider: "docker",
    hostId: "00000000-0000-4000-8000-000000009000",
    harness: "claude",
    prompt: "Inspect the Docker fixture",
  });
});

test("Acme: a disconnected tool cannot be selected", { session: "alice" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", /^Tools ·/).tap();
  const attention = screen.getByRole("region", "Needs attention");
  await expect(attention.getByText("Acme Sentry", { exact: true })).toBeVisible();
  await expect(screen.getByRole("switch", "Acme Sentry")).toHaveCount(0);
});

test("Large: build a Docker snapshot in the composer and launch with the same task", { session: "large" }, async ({
  app,
  screen,
  browser,
}) => {
  await ensureFixtureGitHub();
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  const task = screen.getByLabel("Task");
  await task.fill("Inspect the new Docker repository");
  await screen.getByRole("button", "No repository", { exact: true }).tap();
  await screen.getByPlaceholder("Search repos or type owner/repo").fill("example/new-docker-repo");
  await screen.getByRole("option", /Use example\/new-docker-repo/).tap();
  await screen.getByRole("button", "Create a snapshot", { exact: true }).tap();
  const build = screen.getByRole("region", "Snapshot build");
  const host = build.getByRole("button", /^Docker host Large platform/);
  await host.tap();
  await expect(build.getByText(/Runs once while building this Docker snapshot/)).toBeVisible();
  await build.getByRole("button", "Build snapshot", { exact: true }).tap();
  await expect(screen.getByText("new-docker-repo is ready and selected.", { exact: true })).toBeVisible();
  await expect(task).toHaveValue("Inspect the new Docker repository");
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
  const response = await fetch(`${mock}/__test/state`);
  if (!response.ok) throw new Error("Could not read fixture launch receipt");
  const state = await response.json();
  expect(state.launches.at(-1)).toMatchObject({
    provider: "docker",
    snapshotId: expect.any(String),
    prompt: "Inspect the new Docker repository",
  });
  expect(state.launches.at(-1)).not.toHaveProperty("repo");
});

test("Acme: recover a saved inline cloud snapshot when launch discovery is delayed", { session: "alice" }, async ({
  app,
  screen,
  browser,
}) => {
  const name = "composer-cloud-recovery";
  await ensureFixtureGitHub();
  await configureFixture("capabilities", { provider: "boat", maxGoldens: null });
  await configureFixture("snapshot-visibility", { hidden: name });
  try {
    await app.open("/sandboxes");
    await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
    const task = screen.getByLabel("Task");
    await task.fill("Review the new cloud repository");
    await screen.getByRole("button", /^Stops in /).tap();
    await screen.getByRole("option", "1 hour").tap();
    await screen.getByRole("button", "No repository", { exact: true }).tap();
    await screen.getByPlaceholder("Search repos or type owner/repo").fill(`example/${name}`);
    await screen.getByRole("option", new RegExp(`Use example/${name}`)).tap();
    await screen.getByRole("button", "Create a snapshot", { exact: true }).tap();
    const build = screen.getByRole("region", "Snapshot build");
    await expect(build.getByRole("textbox", "Snapshot name")).toHaveValue(name);
    await build.getByRole("button", "Build snapshot", { exact: true }).tap();
    const retry = build.getByRole("button", "Select saved snapshot");
    await expect(retry).toBeVisible();
    await expect(browser).toHaveURL(/build-key\.composer/);
    await configureFixture("snapshot-visibility", {});
    await retry.tap();
    await expect(screen.getByText(`${name} is ready and selected.`, { exact: true })).toBeVisible();
    await expect(browser).toHaveURL("/sandboxes");
    await expect(task).toHaveValue("Review the new cloud repository");
    await expect(screen.getByRole("button", "Stops in 1 hour")).toBeVisible();
  } finally {
    await configureFixture("snapshot-visibility", {});
    await configureFixture("capabilities", { provider: "boat", maxGoldens: 1 });
  }
});

test("Large: a repository with only a failed Docker snapshot explains why launch is held", {
  session: "large",
}, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  await browser.locator("[data-page-launch]").getByRole("button", "Launch a sandbox").tap();
  await screen.getByRole("button", "No repository", { exact: true }).tap();
  await screen.getByPlaceholder("Search repos or type owner/repo").fill("example/failed-fixture");
  await screen.getByRole("option", /^example\/failed-fixture/).tap();
  await expect(screen.getByRole("button", /^From · host-snapshot-2/)).toBeVisible();
  await expect(
    screen.getByRole("alert").filter({ hasText: "Fixture build failed: repository checkout unavailable." }),
  ).toBeVisible();
  await expect(screen.getByRole("link", "Open Snapshots")).toBeVisible();
  await expect(browser.locator("[data-launch-send]")).toHaveAttribute("aria-disabled", "true");
});
