import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { e2eFixture, fixtureOrigin } from "../../scripts/fixture-ports.ts";

const mock = fixtureOrigin(e2eFixture.mockPort);
const running = "00000000-0000-4000-8000-000000000030";

async function reset() {
  const response = await fetch(`${mock}/__test/reset`, { method: "POST" });
  if (!response.ok) throw new Error(`Fixture reset failed: ${response.status}`);
}

test.setup(
  "fixture sign-in lands on Sandboxes",
  { sessions: ["alice", "large"] },
  async ({ app, screen, browser, session }) => {
    await reset();
    await app.open("/login");
    await screen.getByLabel("Work email").fill("alice@example.com");
    await screen.getByRole("button", "Email me a code").tap();
    await screen.getByLabel("Code").fill("123456");
    await screen.getByRole("button", "Sign in").tap();
    await expect(browser).toHaveURL("/sandboxes");
    await expect(screen.getByRole("heading", "Sandboxes")).toBeVisible();
    await session.save("alice");
    await browser.setCookies([
      { name: "armada-org", value: "00000000-0000-4000-8000-000000000014", url: app.baseUrl! },
    ]);
    await app.open("/sandboxes");
    await expect(screen.getByRole("button", "All 600", { exact: true })).toBeVisible();
    await session.save("large");
  },
);

for (const organization of [
  { session: "alice", name: "Acme", id: running },
  { session: "large", name: "Large", id: "00000000-0000-4000-8000-000000011001" },
]) {
  test(`${organization.name}: browse sandbox activity and open a sandbox`, { session: organization.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/sandboxes");
    const scope = screen.getByRole("group", "Sandbox scope");
    await scope.getByRole("button", "Mine", { exact: true }).tap();
    await expect(scope.getByRole("button", "Mine", { exact: true })).toHaveAttribute("aria-pressed", "true");
    await scope.getByRole("button", "Everyone", { exact: true }).tap();
    await expect(scope.getByRole("button", "Everyone", { exact: true })).toHaveAttribute("aria-pressed", "true");
    const states = screen.getByRole("group", "Sandbox state");
    for (const tab of [
      { label: "Active", empty: "No active sandboxes" },
      { label: "Waiting", empty: "Nothing waiting for you" },
      { label: "Stopped", empty: "No stopped sandboxes" },
      { label: "Failed", empty: "No failed sandboxes" },
      { label: "All", empty: "No sandboxes in this view" },
    ]) {
      const button = states.getByRole("button", new RegExp(`^${tab.label} \\d+`));
      const text = (await button.textContent())?.replace(/\s+/g, " ").trim() ?? "";
      const isEmpty = text === `${tab.label} 0` || text === `${tab.label}0`;
      await button.tap();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      if (isEmpty) await expect(screen.getByText(tab.empty, { exact: true })).toBeVisible();
      else await expect(screen.getByRole("region", tab.label)).toBeVisible();
    }
    await browser.locator(`section[aria-label="All"] a[href="/sandboxes/${organization.id}"]`).tap();
    await expect(browser).toHaveURL(`/sandboxes/${organization.id}`);
    await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
  });

  test(`${organization.name}: send two messages, interrupt the turn and stop the sandbox`, {
    session: organization.session,
  }, async ({ app, screen, browser }) => {
    await app.open(`/sandboxes/${organization.id}`);
    const transcript = browser.locator('[role="log"][aria-label="Messages"]');
    if (organization.session === "large") {
      const loadOlder = screen.getByRole("button", "Load older messages");
      await expect(loadOlder).toBeVisible();
      const earlier = screen.getByText("Earlier fixture response", { exact: true });
      await expect(earlier).toHaveCount(0);
      await loadOlder.tap();
      await expect(transcript).toContainText("Earlier fixture response");
    }
    for (const message of ["Inspect the fixture task", "Summarize the fixture result"]) {
      await screen.getByRole("textbox", "Message").fill(message);
      await screen.getByRole("button", /^(Send|Send as new turn)$/).tap();
      await expect(transcript).toContainText(message);
    }
    await screen.getByRole("button", "Interrupt").tap();
    await expect(transcript).toContainText("Interrupted");
    await screen.getByRole("button", "Stop").tap();
    await screen.getByRole("button", "Stop sandbox").tap();
    await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
      "placeholder",
      "Send a prompt to resume this sandbox…",
    );
  });
}
