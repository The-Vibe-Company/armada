import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

async function seedAccount(id: string, kind: "openai" | "anthropic", name: string) {
  const seeded = await fetch(`${MOCK}/__test/accounts`, {
    method: "POST",
    body: JSON.stringify({
      seed: [
        {
          id,
          scope: "user",
          owner_id: "00000000-0000-4000-8000-000000000001",
          kind,
          name,
          value_enc: "\\x0102",
          is_default: true,
          version: 4,
          status: "active",
          expires_at: null,
          created_at: "2026-11-08T10:00:00.000Z",
          updated_at: "2026-11-08T10:00:00.000Z",
        },
      ],
    }),
  });
  expect(seeded.ok).toBe(true);
}

test("Codex custom endpoint creation accepts both Foundry URL forms without returning the key", async ({
  page,
}, info) => {
  await signIn(page, "alice@example.com", "/harness");
  for (const [index, suffix] of ["", "/responses"].entries()) {
    await page.setViewportSize(index === 0 ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await page.getByRole("button", { name: "Add a model account", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Provider", { exact: true }).selectOption("openai");
    await dialog.getByLabel("Name", { exact: true }).fill(`Foundry ${index}`);
    await dialog.getByLabel("Use a custom endpoint", { exact: true }).check();
    await expect(dialog.getByText(/Codex cannot use chat-completions-only endpoints/)).toBeVisible();
    await dialog
      .getByLabel("Base URL", { exact: true })
      .fill(`https://resource.services.ai.azure.com/api/projects/project/openai/v1${suffix}`);
    await dialog.locator('textarea[name="customModels"]').fill("owner-deployment");
    await expect(dialog.getByLabel("API version (optional)")).toHaveValue("");
    await dialog.getByLabel("Set model prices (optional)", { exact: true }).check();
    await dialog.getByLabel("Priced model ID", { exact: true }).fill("owner-deployment");
    await dialog.getByLabel("Input", { exact: true }).fill("2.5");
    await dialog.getByLabel("Output", { exact: true }).fill("15");
    if (index === 0) await dialog.getByLabel("Cached input (optional)", { exact: true }).fill("0.25");
    const input = dialog.locator('input[name="value"]');
    await expect(input).toHaveAttribute("type", "password");
    // Capture before typing a generated throwaway credential: screenshots contain no key.
    await page.screenshot({
      path: info.outputPath(`codex-connection-${index}.png`),
      fullPage: true,
      animations: "disabled",
    });
    const key = randomUUID();
    await input.fill(key);
    await dialog.getByRole("button", { name: "Add API key", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`[data-account="Foundry ${index}"]`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);
    await expect(page.locator('input[name="value"]')).toHaveCount(0);
  }
});

test("Codex replacement chooses a route explicitly, keeps the version fence and clears keys", async ({
  page,
}, info) => {
  const id = "00000000-0000-4000-8000-000000000795";
  await seedAccount(id, "openai", "Foundry existing");
  await signIn(page, "alice@example.com", "/harness");
  const stale = await page.context().newPage();
  await stale.goto("/harness");
  const open = async (on: typeof page) => {
    await on.getByRole("button", { name: "More actions for Foundry existing" }).click();
    await on.getByRole("menuitem", { name: "Replace key", exact: true }).click();
    return on.getByRole("dialog");
  };
  const dialog = await open(page);
  await expect(dialog.getByLabel("Connection type")).toHaveValue("");
  await expect(dialog.locator('input[name="value"]')).toHaveCount(0);
  await expect(dialog).toHaveAccessibleDescription(/Choosing OpenAI default changes routing to OpenAI/);
  await dialog.getByLabel("Connection type").selectOption("openai");
  await dialog.locator('input[name="value"]').fill(randomUUID());
  await dialog.getByLabel("Connection type").selectOption("custom");
  await expect(dialog.locator('input[name="value"]')).toHaveValue("");
  await dialog
    .getByLabel("Base URL", { exact: true })
    .fill("https://resource.services.ai.azure.com/api/projects/project/openai/v1/responses");
  await dialog.locator('textarea[name="customModels"]').fill("owner-deployment");
  await dialog.getByLabel("Set model prices (optional)", { exact: true }).check();
  await dialog.getByLabel("Priced model ID", { exact: true }).fill("owner-deployment");
  await dialog.getByLabel("Input", { exact: true }).fill("2.5");
  await dialog.getByLabel("Output", { exact: true }).fill("15");
  await page.screenshot({ path: info.outputPath("codex-replacement.png"), fullPage: true, animations: "disabled" });
  const key = randomUUID();
  await dialog.locator('input[name="value"]').fill(key);
  await dialog.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const state = await (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: "{}" })).json();
  expect(state.calls.filter((call: { route: string }) => call.route === "creds/accounts/set")).toEqual([
    {
      route: "creds/accounts/set",
      body: expect.objectContaining({ id, expectedVersion: 4, name: "Foundry existing", value: "[sent]" }),
    },
  ]);
  await expect(page.locator("body")).not.toContainText(key);
  await stale.setViewportSize({ width: 390, height: 844 });
  const refused = await open(stale);
  await refused.getByLabel("Connection type").selectOption("openai");
  await stale.screenshot({
    path: info.outputPath("codex-replacement-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await refused.locator('input[name="value"]').fill(randomUUID());
  await refused.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(refused).toContainText("This account changed elsewhere");
  await expect(refused.getByLabel("Connection type")).toHaveValue("openai");
  await expect(refused.locator('input[name="value"]')).toHaveValue("");
});

test("Claude gateway replacement keeps explicit routing/auth and refuses a stale revision", async ({ page }, info) => {
  const id = "00000000-0000-4000-8000-000000000796";
  await seedAccount(id, "anthropic", "Gateway existing");
  await signIn(page, "alice@example.com", "/harness");
  const stale = await page.context().newPage();
  await stale.goto("/harness");
  const open = async (on: typeof page) => {
    await on.getByRole("button", { name: "More actions for Gateway existing" }).click();
    await on.getByRole("menuitem", { name: "Replace key", exact: true }).click();
    return on.getByRole("dialog");
  };
  const dialog = await open(page);
  await expect(dialog.getByLabel("Connection type")).toHaveValue("");
  await expect(dialog.locator('input[name="value"]')).toHaveCount(0);
  await expect(dialog).toHaveAccessibleDescription(/Choosing Anthropic default changes routing to Anthropic/);
  await dialog.getByLabel("Connection type").selectOption("custom");
  await dialog.getByLabel("Base URL", { exact: true }).fill("https://gateway.example.com/anthropic");
  await expect(dialog.getByLabel("Gateway authentication")).toHaveValue("bearer");
  await dialog.locator('input[name="value"]').fill(randomUUID());
  await dialog.getByLabel("Gateway authentication").selectOption("api-key");
  await expect(dialog.locator('input[name="value"]')).toHaveValue("");
  await dialog.getByLabel("Set model prices (optional)", { exact: true }).check();
  await dialog.getByLabel("Priced model ID", { exact: true }).fill("owner-deployment");
  await dialog.getByLabel("Input", { exact: true }).fill("2.5");
  await dialog.getByLabel("Output", { exact: true }).fill("15");
  await page.screenshot({ path: info.outputPath("claude-replacement.png"), fullPage: true, animations: "disabled" });
  const key = randomUUID();
  await dialog.locator('input[name="value"]').fill(key);
  await dialog.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const state = await (await fetch(`${MOCK}/__test/accounts`, { method: "POST", body: "{}" })).json();
  expect(state.calls.filter((call: { route: string }) => call.route === "creds/accounts/set")).toEqual([
    {
      route: "creds/accounts/set",
      body: expect.objectContaining({
        id,
        expectedVersion: 4,
        kind: "anthropic",
        name: "Gateway existing",
        value: "[sent]",
      }),
    },
  ]);
  await expect(page.locator("body")).not.toContainText(key);
  await stale.setViewportSize({ width: 390, height: 844 });
  const refused = await open(stale);
  await refused.getByLabel("Connection type").selectOption("custom");
  await refused.getByLabel("Base URL", { exact: true }).fill("https://gateway.example.com/anthropic");
  await refused.getByLabel("Gateway authentication").selectOption("api-key");
  await stale.screenshot({
    path: info.outputPath("claude-replacement-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await refused.locator('input[name="value"]').fill(randomUUID());
  await refused.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(refused).toContainText("This account changed elsewhere");
  await expect(refused.getByLabel("Connection type")).toHaveValue("custom");
  await expect(refused.getByLabel("Gateway authentication")).toHaveValue("api-key");
  await expect(refused.locator('input[name="value"]')).toHaveValue("");
});

test("Claude gateway creation supports bearer and API-key authentication without keeping the secret", async ({
  page,
}, info) => {
  await signIn(page, "alice@example.com", "/harness");
  for (const [index, auth] of ["bearer", "api-key"].entries()) {
    await page.setViewportSize(index === 0 ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await page.getByRole("button", { name: "Add a model account", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Provider", { exact: true }).selectOption("anthropic");
    await dialog.getByLabel("Name", { exact: true }).fill(`Gateway ${auth}`);
    await dialog.getByLabel("Use a custom endpoint", { exact: true }).check();
    await expect(dialog.getByText(/Claude Code supports Claude models only/)).toBeVisible();
    await expect(dialog.getByLabel("API version (optional)")).toHaveCount(0);
    await dialog.getByLabel("Base URL", { exact: true }).fill("https://gateway.example.com/anthropic");
    await dialog.getByLabel("Gateway authentication").selectOption(auth);
    const input = dialog.locator('input[name="value"]');
    await expect(input).toHaveAttribute("type", "password");
    await page.screenshot({
      path: info.outputPath(`claude-connection-${index}.png`),
      fullPage: true,
      animations: "disabled",
    });
    const key = randomUUID();
    await input.fill(key);
    await dialog.getByRole("button", { name: "Add API key", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`[data-account="Gateway ${auth}"]`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);
    await expect(page.locator('input[name="value"]')).toHaveCount(0);
  }
});

test("a DeepSeek connection is added by choosing the provider, pasting a key and ticking a model", async ({
  page,
}, info) => {
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Add a model account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Provider", { exact: true }).selectOption("deepseek");
  await expect(dialog.getByText("https://api.deepseek.com", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/For OpenCode/).first()).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("DeepSeek");
  await dialog.getByRole("searchbox", { name: "Search models" }).fill("flash");
  await dialog
    .getByRole("checkbox")
    .filter({ hasNot: page.locator("[name]") })
    .first()
    .check();
  await page.screenshot({ path: info.outputPath("deepseek-connection.png"), fullPage: true, animations: "disabled" });
  const key = randomUUID();
  await dialog.locator('input[name="value"]').fill(key);
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-account="DeepSeek"]')).toBeVisible();
  await expect(page.locator("body")).not.toContainText(key);

  // Replacing the key re-enters the provider: a plain plan key is never chosen silently.
  await page.getByRole("button", { name: "More actions for DeepSeek" }).click();
  await page.getByRole("menuitem", { name: "Replace key", exact: true }).click();
  const replace = page.getByRole("dialog");
  await expect(replace.getByLabel("Connection type")).toHaveValue("");
  await replace.getByLabel("Connection type").selectOption("deepseek");
  await replace.getByRole("searchbox", { name: "Search models" }).fill("flash");
  await replace.getByRole("checkbox").first().check();
  const next = randomUUID();
  await replace.locator('input[name="value"]').fill(next);
  await replace.getByRole("button", { name: /^Save/ }).click();
  await expect(replace).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(next);
});
