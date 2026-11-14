import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

test.beforeEach(reset);

test("Models checks only a matching owned sandbox, shows pending/error/success and creates no prompt", async ({
  page,
}, info) => {
  const accountId = "00000000-0000-4000-8000-000000000798";
  const setup = async (path: string, body: object) => {
    const response = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
  };
  await setup("/__test/accounts", {
    seed: [
      {
        id: accountId,
        kind: "openai",
        scope: "user",
        owner_id: IDS.alice,
        name: "Foundry check",
        is_default: true,
        version: 1,
        status: "active",
        expires_at: null,
        value_enc: "\\x0102",
        created_at: "2026-11-08T10:00:00Z",
        updated_at: "2026-11-08T10:00:00Z",
      },
    ],
    connectionModels: { [accountId]: [{ model: "team-deployment", input: null, output: null }] },
  });
  await setup("/__test/sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      provider: "modal",
      provider_sandbox_id: "modal_probe",
      harness: "codex",
      status: "ready",
      credential_id: accountId,
      credential_version: 1,
    },
  });
  // Admins may read another member's sandbox, but it must not be offered for this check.
  await setup("/__test/sandbox-lifecycle", {
    id: IDS.bobSecret,
    fields: { provider: "modal", status: "ready", credential_id: accountId, credential_version: 1 },
  });
  await setup("/__test/sandbox-lifecycle", {
    id: IDS.failed,
    fields: { provider: "modal", status: "stopped", credential_id: accountId, credential_version: 1 },
  });
  // More than one picker page of newer unrelated sandboxes must not hide this account's older candidate.
  await setup("/__test/add-sandboxes", {
    rows: Array.from({ length: 51 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(800 + index).padStart(12, "0")}`,
      provider: "modal",
      status: "ready",
      credential_id: null,
      credential_version: null,
      created_at: "2026-11-09T10:00:00Z",
    })),
  });
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Test connection, Foundry check" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog).toContainText("one tiny billable request");
  // The connection's declared models are listed on its row and prefill the check.
  await expect(page.locator('[data-account="Foundry check"] [data-account-models]')).toHaveText(
    "Models: team-deployment",
  );
  await expect(dialog.getByLabel("Deployment or model name")).toHaveValue("team-deployment");
  const sandbox = dialog.getByLabel("Running sandbox", { exact: true });
  await expect(sandbox).toHaveValue(IDS.running);
  await expect(sandbox.locator("option")).toHaveCount(1);
  await expect(sandbox.locator("option")).toContainText("Codex —");
  // The picker is not an authorization boundary: a forged option is still refused on submit.
  await sandbox.evaluate((node, id) => (node as HTMLSelectElement).add(new Option("Other sandbox", id)), IDS.bobSecret);
  await sandbox.selectOption(IDS.bobSecret);
  await dialog.getByLabel("Deployment or model name").fill("deployment");
  await dialog.getByRole("button", { name: "Send tiny check" }).click();
  await expect(dialog.getByRole("alert")).toContainText("no longer available for this account");
  const calls = async () =>
    (await (await fetch(`${MOCK}/__test/state`, { method: "POST", body: "{}" })).json()).controlCalls.filter(
      (row: { operation: string }) => row.operation === "sandbox/test-model-connection",
    );
  expect(await calls()).toHaveLength(0);
  await sandbox.selectOption(IDS.running);
  await dialog.getByLabel("Deployment or model name").fill("missing-deployment");
  let entered: () => void = () => {},
    release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/harness", async (route) => {
    if (route.request().method() === "POST") {
      entered();
      await paused;
    }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Send tiny check" }).click();
  await reached;
  await expect(dialog.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("Checking the runtime");
  release();
  await expect(dialog.getByRole("alert")).toContainText("The model or deployment was not found");
  await expect(sandbox).toHaveValue(IDS.running);
  await expect(dialog.getByLabel("Deployment or model name")).toHaveValue("missing-deployment");
  await page.screenshot({ path: info.outputPath("model-check-error.png"), fullPage: true, animations: "disabled" });
  await dialog.getByLabel("Deployment or model name").fill("deployment");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Send tiny check" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connection accepted.");
  expect(await calls()).toHaveLength(2);
  const state = await (await fetch(`${MOCK}/__test/state`, { method: "POST", body: "{}" })).json();
  expect(state.sent).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("model-check-mobile.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Test connection, Foundry check" })).toBeFocused();
});

test("a model check without a matching running sandbox offers the next step instead of a UUID field", async ({
  page,
}) => {
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Test connection, Anthropic API key" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No matching sandbox is running.");
  await expect(dialog.getByRole("button", { name: "Send tiny check" })).toBeDisabled();
  await expect(dialog.getByRole("link", { name: "Choose a snapshot" })).toHaveAttribute("href", "/snapshots");
  await expect(dialog.locator('[name="sandboxId"]')).toHaveCount(0);
});
