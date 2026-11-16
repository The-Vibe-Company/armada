import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const mock = "http://127.0.0.1:54399";
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
    await expect(screen.getByText("600 sandboxes", { exact: true })).toBeVisible();
    await session.save("large");
  },
);

// Both sessions use the existing mock organizations; no synthetic inventory or stand-in.
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
    for (const tab of ["Mine", "Working", "Waiting for you", "Stopped", "Failed", "All"]) {
      await screen.getByRole("link", new RegExp(`^${tab} `)).tap();
      await expect(screen.getByRole("region", tab)).toBeVisible();
    }
    await browser.locator(`main a[href="/sandboxes/${organization.id}"]`).tap();
    await expect(browser).toHaveURL(`/sandboxes/${organization.id}`);
    await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
  });

  test(`${organization.name}: send two messages and stop the sandbox`, { session: organization.session }, async ({
    app,
    screen,
    browser,
  }) => {
    await app.open(`/sandboxes/${organization.id}`);
    for (const message of ["Inspect the fixture task", "Summarize the fixture result"]) {
      await screen.getByRole("textbox", "Message").fill(message);
      await screen.getByRole("button", /^(Send|Send as new turn)$/).tap();
      await expect(browser.locator('[role="log"][aria-label="Messages"]')).toContainText(message);
    }
    await screen.getByRole("button", "Stop").tap();
    await screen.getByRole("button", "Stop sandbox").tap();
    await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
      "placeholder",
      "Send a prompt to resume this sandbox…",
    );
  });
}
