import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const mock = "http://127.0.0.1:54399";
const running = "00000000-0000-4000-8000-000000000030";

async function reset() {
  const response = await fetch(`${mock}/__test/reset`, { method: "POST" });
  if (!response.ok) throw new Error(`Fixture reset failed: ${response.status}`);
}

test.setup("fixture sign-in lands on Sandboxes", { sessions: ["alice"] }, async ({ app, screen, browser, session }) => {
  await reset();
  await app.open("/login");
  await screen.getByLabel("Email").fill("alice@example.com");
  await screen.getByRole("button", "Email me a sign-in link").tap();
  await screen.getByLabel("Code").fill("123456");
  await screen.getByRole("button", "Sign in").tap();
  await expect(browser).toHaveURL("/sandboxes");
  await expect(screen.getByRole("heading", "Sandboxes")).toBeVisible();
  await session.save("alice");
});

test("browse sandbox activity and open a sandbox", { session: "alice" }, async ({ app, screen, browser }) => {
  await app.open("/sandboxes");
  for (const tab of ["Need you", "Working", "All"]) {
    await screen.getByRole("tab", new RegExp(`^${tab} ·`)).tap();
    await expect(screen.getByRole("tabpanel", new RegExp(`^${tab} ·`))).toBeVisible();
  }
  await screen.getByRole("link", "Claude Code on shared-golden").tap();
  await expect(browser).toHaveURL(`/sandboxes/${running}`);
  await expect(browser.locator('[role="log"][aria-label="Messages"]')).toBeVisible();
});

test("send two messages and stop the sandbox", { session: "alice" }, async ({ app, screen, browser }) => {
  await app.open(`/sandboxes/${running}`);
  for (const message of ["Inspect the fixture task", "Summarize the fixture result"]) {
    await screen.getByRole("textbox", "Message").fill(message);
    await screen.getByRole("button", /^(Send|Send as new turn)$/).tap();
    await expect(browser.locator('[role="log"][aria-label="Messages"]')).toContainText(message);
  }
  await screen.getByRole("button", "Sandbox actions").tap();
  await screen.getByRole("button", "Stop").tap();
  await screen.getByRole("button", "Stop sandbox").tap();
  await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
    "placeholder",
    "Send a message to resume the sandbox",
  );
});
