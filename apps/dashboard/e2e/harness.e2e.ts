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
  // The next opening leads with the subscription again, not the API key chosen last time.
  await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Add a subscription" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Claude subscription/ })).toBeChecked();
  await page.keyboard.press("Escape");

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

function seeded(id: number, name: string, extra: Record<string, unknown> = {}) {
  const now = "2026-11-08T10:00:00.000Z";
  return {
    id: `00000000-0000-4000-8000-0000000008${String(id).padStart(2, "0")}`,
    scope: "user",
    owner_id: "00000000-0000-4000-8000-000000000001",
    kind: "claude_oauth",
    value_enc: "\\x0102",
    created_at: now,
    name,
    is_default: false,
    version: 1,
    status: "active",
    expires_at: null,
    updated_at: now,
    ...extra,
  };
}

test("each subscription is one dense row: needs action first, state in words, scope as a tag, one action on the row", async ({
  page,
}) => {
  const seed = [
    seeded(1, "Work", { is_default: true }),
    seeded(2, "Old laptop", { expires_at: "2026-01-01T00:00:00.000Z" }),
    seeded(3, "Side"),
  ];
  expect((await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: JSON.stringify({ seed }) })).ok).toBe(true);
  await signIn(page, "alice@example.com", "/harness");
  const claude = page.locator('[data-harness="claude"]');
  // The expired one leads, then the default, then the rest; the org's key is a tag, not a section.
  await expect(claude.locator("[data-account]")).toHaveCount(4);
  expect(
    await claude.locator("[data-account]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-account"))),
  ).toEqual(["Old laptop", "Work", "Side", "Anthropic API key"]);
  const old = claude.locator('[data-account="Old laptop"]');
  await expect(old.locator("[data-account-state]")).toHaveText("Expired");
  await expect(old.locator('[data-account-scope="user"]')).toHaveText("Personal");
  await expect(claude.locator('[data-account="Anthropic API key"] [data-account-scope="org"]')).toHaveText("Acme");
  await expect(claude.locator('[data-account="Work"] [data-account-state]')).toHaveText("Ready");
  // One expected action per row: Reconnect for the expired one, Make default for a ready one, none for the default.
  await expect(old.getByRole("button", { name: "Reconnect, Old laptop" })).toBeVisible();
  await expect(old.getByRole("button", { name: /Make default/ })).toHaveCount(0);
  await expect(
    claude.locator('[data-account="Side"]').getByRole("button", { name: "Make default, Side" }),
  ).toBeVisible();
  await expect(
    claude.locator('[data-account="Work"]').getByRole("button", { name: /Make default|Reconnect/ }),
  ).toHaveCount(0);

  // The rarer actions are in the row's menu, reachable by keyboard; closing a dialog gives focus back to the menu.
  const more = old.getByRole("button", { name: "More actions for Old laptop" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Remove"]);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog", { name: "Rename Old laptop" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await old.getByRole("button", { name: "Reconnect, Old laptop" }).click();
  await expect(page.getByRole("dialog", { name: "Reconnect Old laptop" })).toBeVisible();
});
