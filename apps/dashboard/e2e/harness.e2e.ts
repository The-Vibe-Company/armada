import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

const OPENAI_KEY = "sk-proj-e2e-harness-openai-key";

test("the old Credentials address lands on Harness, and the navigation names it", async ({ page }) => {
  await signIn(page, "alice@example.com", "/fleet");
  for (const old of ["/credentials", "/credentials/anything"]) {
    await page.goto(old);
    await expect(page).toHaveURL(/\/harness$/);
  }
  await expect(page.getByRole("heading", { name: "Harness", level: 1 })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Harness" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Credentials" })).toHaveCount(0);
});

test("adding a subscription leads with the sign-in; an API key is the secondary way in", async ({ page }) => {
  await signIn(page, "alice@example.com", "/harness");
  // One section per harness. Codex has nothing yet: its empty state opens the dialog on the ChatGPT subscription.
  await expect(page.locator("[data-harness]")).toHaveCount(2);
  const codex = page.locator('[data-harness="codex"]');
  await expect(codex.getByText("No Codex subscription yet")).toBeVisible();
  await codex.getByRole("button", { name: "Add a Codex subscription" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a subscription" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /ChatGPT subscription/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /Claude subscription/ })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /API key/ })).toHaveCount(0);

  // The API key is one click away, for the same harness, and back again.
  await dialog.getByRole("button", { name: "Use an API key instead" }).click();
  await expect(dialog.getByRole("heading", { name: "Add an API key" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /OpenAI API key/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /subscription/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use a subscription instead" }).click();
  await expect(dialog.getByRole("radio", { name: /ChatGPT subscription/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Use an API key instead" }).click();

  await dialog.getByLabel("Name").fill("Team key");
  await dialog.getByRole("textbox", { name: "API key" }).fill(OPENAI_KEY);
  await dialog.getByRole("button", { name: "Add API key" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(codex.locator('[data-account="Team key"]')).toBeVisible();
  expect(await page.content()).not.toContain(OPENAI_KEY);

  const calls = (
    (await (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: "{}" })).json()) as {
      calls: { route: string; body: Record<string, unknown> }[];
    }
  ).calls;
  expect(
    calls
      .filter((call) => call.route === "creds/accounts/set")
      .map((call) => [call.body.scope, call.body.kind, call.body.name]),
  ).toEqual([["user", "openai", "Team key"]]);
});
