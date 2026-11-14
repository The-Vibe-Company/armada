import { expect, test } from "@playwright/test";
import { IDS, MOCK, signIn } from "./helpers";

const ACCOUNT = "00000000-0000-4000-8000-000000000790";
const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const PAUSED = "Paused — wakes on your next message";
async function post(path: string, body: object) {
  expect((await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) })).ok).toBe(true);
}
async function seed(provider: "modal" | "docker", kind: string, name: string, expired = false, status = "stopped") {
  await post("reset", {
    dockerHosts: [
      {
        id: HOST,
        name: "Office workstation",
        state: "online",
        createdAt: "2026-11-13T08:00:00Z",
        lastSeenAt: "2026-11-13T12:00:00Z",
        revokedAt: null,
        sandboxes: 1,
        version: null,
      },
    ],
  });
  await post("accounts", {
    seed: [
      {
        id: ACCOUNT,
        name,
        kind,
        scope: "user",
        owner_id: IDS.alice,
        value_enc: "\\x0102",
        created_at: "2026-11-13T08:00:00Z",
        updated_at: "2026-11-13T08:00:00Z",
        status: "active",
        is_default: true,
        version: 1,
        expires_at: null,
      },
    ],
  });
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      provider,
      docker_host_id: provider === "docker" ? HOST : null,
      harness: kind === "opencode" ? "opencode" : "codex",
      credential_id: ACCOUNT,
      credential_version: 1,
      runtime_transport: "dialout",
      model: kind === "opencode" ? "deepseek/deepseek-v4-flash" : "gpt-6.1-sol",
      status,
      status_reason: "idle_paused",
      expires_at: new Date(Date.now() + (expired ? -1 : 1) * 3600_000).toISOString(),
    },
  });
  await post("sandbox-events", { sandbox: IDS.running, events: [] });
}

for (const provider of ["modal", "docker"] as const) {
  for (const account of [
    { kind: "openai", name: "Work key", label: "OpenAI API key" },
    { kind: "opencode", name: "DeepSeek", label: "OpenCode API key" },
    { kind: "codex_auth", name: "Work plan", label: "ChatGPT subscription" },
  ]) {
    test(`${provider}/${account.kind}: the page names its pinned account kind and explains idle pause without hover`, async ({
      page,
    }) => {
      await seed(provider, account.kind, account.name);
      await page.setViewportSize({ width: 1280, height: 900 });
      await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
      const billing = page.locator("[data-sandbox-billing-account]");
      await expect(billing).toHaveText(`Account: ${account.name} (${account.label})`);
      await expect(page.locator('[data-fit="card"]').getByText(PAUSED, { exact: true })).toBeVisible();
      if (provider === "modal" && account.kind === "openai") {
        await page.screenshot({ path: "test-results/sandbox-summary-desktop.png", animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(billing).toBeVisible();
        await expect(page.locator('[data-fit="card"]').getByText(PAUSED, { exact: true })).toBeVisible();
        await page.screenshot({ path: "test-results/sandbox-summary-mobile.png", animations: "disabled" });
      }
    });
  }
}

test("accepted messages clear the live pause note and ready status reads Waiting for you", async ({ page }) => {
  await seed("modal", "openai", "Work key");
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const card = page.locator('[data-fit="card"]');
  await expect(card.getByText(PAUSED, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Wake and continue");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect(card.getByText(PAUSED, { exact: true })).toHaveCount(0);
  await post("sandbox-lifecycle", { id: IDS.running, fields: { status: "ready", status_reason: null } });
  await page.reload();
  await expect(page.locator('[data-fit="card"]').getByText("Waiting for you", { exact: true })).toBeVisible();
});

test("expired pauses do not promise wake and an unbound account has no invented kind", async ({ page }) => {
  await seed("modal", "openai", "Work key", true);
  await post("sandbox-lifecycle", { id: IDS.running, fields: { credential_id: null, credential_version: null } });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  await expect(page.locator('[data-fit="card"]').getByText(PAUSED, { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-sandbox-billing-account]")).toHaveText("Account: No account selected");
});
