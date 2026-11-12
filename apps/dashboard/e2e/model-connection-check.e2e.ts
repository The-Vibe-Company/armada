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
  await signIn(page, "alice@example.com", "/harness");
  await page.getByRole("button", { name: "Test connection, Foundry check" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog).toContainText("one tiny billable request");
  await dialog.getByLabel("Running Modal sandbox UUID").fill(IDS.bobSecret);
  await dialog.getByLabel("Deployment or model name").fill("deployment");
  await dialog.getByRole("button", { name: "Send tiny check" }).click();
  await expect(dialog.getByRole("alert")).toContainText("bound to this exact account version");
  const calls = async () =>
    (await (await fetch(`${MOCK}/__test/state`, { method: "POST", body: "{}" })).json()).controlCalls.filter(
      (row: { operation: string }) => row.operation === "sandbox/test-model-connection",
    );
  expect(await calls()).toHaveLength(0);
  await dialog.getByLabel("Running Modal sandbox UUID").fill(IDS.running);
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
  await expect(dialog.getByRole("alert")).toContainText("HTTP 404 model_not_found");
  await expect(dialog.getByLabel("Running Modal sandbox UUID")).toHaveValue(IDS.running);
  await expect(dialog.getByLabel("Deployment or model name")).toHaveValue("missing-deployment");
  await page.screenshot({ path: info.outputPath("model-check-error.png"), fullPage: true, animations: "disabled" });
  await dialog.getByLabel("Deployment or model name").fill("deployment");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Send tiny check" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connection accepted (HTTP 200)");
  expect(await calls()).toHaveLength(2);
  const state = await (await fetch(`${MOCK}/__test/state`, { method: "POST", body: "{}" })).json();
  expect(state.sent).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("model-check-mobile.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Test connection, Foundry check" })).toBeFocused();
});
