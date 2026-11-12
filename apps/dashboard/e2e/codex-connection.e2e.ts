import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("Codex custom endpoint creation accepts both Foundry URL forms without returning the key", async ({
  page,
}, info) => {
  await signIn(page, "alice@example.com", "/harness");
  for (const [index, suffix] of ["", "/responses"].entries()) {
    await page.setViewportSize(index === 0 ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await page.getByRole("button", { name: "Add a model account", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /OpenAI API key/ }).check();
    await dialog.getByLabel("Name", { exact: true }).fill(`Foundry ${index}`);
    await dialog.getByLabel("Use a custom endpoint (Modal)", { exact: true }).check();
    await expect(dialog.getByText(/Codex cannot use chat-completions-only endpoints/)).toBeVisible();
    await dialog
      .getByLabel("Base URL", { exact: true })
      .fill(`https://resource.services.ai.azure.com/api/projects/project/openai/v1${suffix}`);
    await expect(dialog.getByLabel("API version (optional)")).toHaveValue("");
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
  const seeded = await fetch(`${MOCK}/__test/accounts`, {
    method: "POST",
    body: JSON.stringify({
      seed: [
        {
          id,
          scope: "user",
          owner_id: "00000000-0000-4000-8000-000000000001",
          kind: "openai",
          name: "Foundry existing",
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
