import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { reset, signIn } from "./helpers";

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
    await page.screenshot({ path: info.outputPath(`codex-connection-${index}.png`), fullPage: true });
    const key = randomUUID();
    await input.fill(key);
    await dialog.getByRole("button", { name: "Add API key", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`[data-account="Foundry ${index}"]`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);
    await expect(page.locator('input[name="value"]')).toHaveCount(0);
  }
});
