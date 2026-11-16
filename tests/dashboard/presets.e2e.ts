import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const org of [
  {
    session: "alice",
    name: "Acme",
    snapshot: "shared-golden",
    account: "Anthropic API key",
    routineTemplate: "Modal quick fix",
    history: "Morning review",
  },
  {
    session: "large",
    name: "Large",
    snapshot: "snapshot-002",
    account: "model-account-006",
    routineTemplate: "template-001",
    history: "routine-0-international-platform-observability-and-release-engineering-with-a-very-long-unbroken-suffix",
  },
]) {
  test(`${org.name}: save, launch, change and remove a template`, { session: org.session }, async ({
    app,
    screen,
    browser,
  }) => {
    const name = "Journey review preset";
    await app.open("/templates");
    await screen.getByRole("button", "New template").tap();
    await screen.getByRole("textbox", "Template name").fill(name);
    if (org.session === "large") {
      await screen.getByRole("button", /^Snapshot:/).tap();
      await screen.getByPlaceholder("Search snapshot").fill(org.snapshot);
      await screen.getByRole("option", new RegExp(`^${org.snapshot} · Boat cloud`)).tap();
    } else await screen.getByRole("button", new RegExp(`^${org.snapshot} · Boat cloud`)).tap();
    await screen.getByRole("button", /^Model account:/).tap();
    await screen.getByRole("option", org.account).tap();
    await screen.getByRole("button", "Save template").tap();
    await expect(screen.getByRole("dialog", "New template")).toBeHidden();
    await screen.getByRole("button", `Launch from ${name}`).tap();
    await screen.getByLabel("Task").fill("Review the saved fixture setup");
    await screen.getByRole("button", "Launch", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/sandboxes\/[0-9a-f-]+$/);
    await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
    await app.open("/templates");
    await screen.getByRole("link", name, { exact: true }).tap();
    await screen.getByRole("button", "Change", { exact: true }).tap();
    await screen.getByRole("button", "low", { exact: true }).tap();
    await screen.getByRole("button", "Save as version 2").tap();
    await expect(screen.getByRole("dialog", `Change ${name}`)).toBeHidden();
    await expect(browser.locator(`[data-template-panel="${name}"]`)).toContainText(
      "2 (published versions never change)",
    );
    await screen.getByRole("button", "Remove", { exact: true }).tap();
    await screen.getByRole("button", "Remove template").tap();
    await expect(browser.locator(`[data-template="${name}"]`)).toHaveCount(0);
  });

  test(`${org.name}: create, enable and delete a routine`, { session: org.session }, async ({
    app,
    screen,
    browser,
  }) => {
    const name = "Journey scheduled review";
    await app.open("/routines");
    await screen.getByRole("button", "New routine").tap();
    await screen.getByLabel("Interval in hours").fill("12");
    await screen.getByRole("radio", org.routineTemplate, { exact: true }).check();
    await screen.getByLabel("Task", { exact: true }).fill("Review the fixture changes");
    await screen.getByLabel("Name", { exact: true }).fill(name);
    await screen.getByRole("button", "Create routine").tap();
    await expect(screen.getByRole("dialog", "New routine")).toBeHidden();
    await screen.getByRole("button", "Dismiss").first().tap();
    await screen.getByRole("switch", `Switch ${name} on`).tap();
    await expect(screen.getByRole("switch", `Switch ${name} off`)).toHaveAttribute("aria-checked", "true");
    await screen.getByRole("button", "Dismiss").first().tap();
    await browser.locator(`[data-routine="${name}"]`).getByRole("button", "See runs").tap();
    await expect(screen.getByRole("region", "Run history")).toContainText("No runs");
    await screen.getByRole("button", "Delete routine").tap();
    await screen.getByRole("button", "Delete routine").tap();
    await expect(browser.locator(`[data-routine="${name}"]`)).toHaveCount(0);
  });

  test(`${org.name}: inspect a routine's completed and skipped runs`, { session: org.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/routines");
    await browser.locator(`[data-routine="${org.history}"]`).getByRole("button", "See runs").tap();
    const history = screen.getByRole("region", "Run history");
    await expect(history.getByText("Launched", { exact: true })).toBeVisible();
    await expect(history.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(history.getByRole("link", "Open sandbox")).toBeVisible();
  });
}
