import { expect, test } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "./helpers";

const post = async (path: string, body: object) => {
  const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
};
const account = (id: string, kind: string, name: string, status = "active") => ({
  id,
  kind,
  name,
  status,
  isDefault: true,
  expiresAt: null,
  version: 2,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
});
const OLD = "00000000-0000-4000-8000-000000000951";
const NEXT = "00000000-0000-4000-8000-000000000952";
const OTHER = "00000000-0000-4000-8000-000000000953";

test.beforeEach(reset);
for (const [provider, harness, oldKind, newKind] of [
  ["boat", "codex", "openai", "codex_auth"],
  ["modal", "claude", "anthropic", "claude_oauth"],
] as const) {
  test(`owner explicitly changes a removed account without replacing the workspace (${provider})`, async ({ page }) => {
    await post("accounts", {
      user: [
        account(OLD, oldKind, "Removed key", "deleted"),
        account(NEXT, newKind, "Personal default"),
        account(OTHER, harness === "codex" ? "anthropic" : "openai", "Wrong harness"),
      ],
    });
    await post("sandbox-lifecycle", {
      id: IDS.running,
      fields: {
        provider,
        harness,
        status: "stopped",
        stopped_at: "2026-11-12T00:00:00Z",
        credential_id: OLD,
        credential_version: 1,
        model: null,
        reasoning_effort: null,
        conversation_ids: ["conv-retained"],
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByText("Change account", { exact: true }).click();
    const choice = page.getByRole("region", { name: "Change this sandbox’s account" });
    await expect(choice.getByRole("radio")).toHaveCount(1);
    await expect(choice.getByRole("radio", { checked: true })).toHaveCount(0);
    await choice.getByRole("radio", { name: /Personal default/ }).click();
    await choice.getByRole("button", { name: "Use this account", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("files and conversations remain");
    const before = await (await fetch(`${MOCK}/__test/state`)).json();
    expect(before.repointCalls).toHaveLength(0);
    await dialog.getByRole("button", { name: "Change account", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("The sandbox account changed. Its workspace and conversations are retained.", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`account-repoint-${provider}.png`),
      fullPage: true,
      animations: "disabled",
    });
    const after = await (await fetch(`${MOCK}/__test/state`)).json();
    expect(after.repointCalls).toEqual([
      { id: IDS.running, credentialId: NEXT, org: "00000000-0000-4000-8000-000000000010" },
    ]);
    expect(after.launches).toHaveLength(0);
    await expect(page).toHaveURL(new RegExp(`/sandboxes/${IDS.running}$`));
  });
}

test("the persisted default-fallback note becomes visible after sending", async ({ page }) => {
  await post("accounts", { user: [account(NEXT, "codex_auth", "Personal default")] });
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: {
      harness: "codex",
      status: "ready",
      credential_id: OLD,
      credential_version: 1,
      model: null,
      reasoning_effort: null,
    },
  });
  await post("sandbox-events", {
    sandbox: IDS.running,
    events: [
      {
        id: "old-finished",
        at: 1,
        kind: "prompt",
        promptId: "old-finished",
        conversationId: "conv-a",
        text: "Previous task",
        status: "finished",
      },
    ],
  });
  await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
  const note = "The pinned account was removed. This sandbox now uses your default account.";
  await expect(page.getByText(note, { exact: true })).toHaveCount(0);
  // Supply the server's persisted fallback receipt; SQL tests own selection and delivery.
  await post("sandbox-lifecycle", {
    id: IDS.running,
    fields: { credential_id: NEXT, credential_version: 2, credential_note: note },
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue in this workspace");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
});

for (const revoked of [false, true]) {
  test(`a starting pending handoff can ${revoked ? "select another account after revocation" : "retry its eligible account"}`, async ({
    page,
  }) => {
    await post("accounts", {
      user: [
        account(NEXT, "openai", "Pending target", revoked ? "revoked" : "active"),
        { ...account(OTHER, "openai", "Alternative account"), isDefault: false },
      ],
    });
    await post("sandbox-lifecycle", {
      id: IDS.running,
      fields: {
        provider: "modal",
        harness: "codex",
        status: "starting",
        credential_id: NEXT,
        credential_version: 2,
        credential_delivery_pending: false,
        model: null,
        reasoning_effort: null,
        conversation_ids: ["conv-retained"],
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "alice@example.com", `/sandboxes/${IDS.running}`);
    const openChoices = async () => {
      await page.getByRole("button", { name: "Details", exact: true }).click();
      await page.getByText("Change account", { exact: true }).click();
    };
    await openChoices();
    const choice = page.getByRole("region", { name: "Change this sandbox’s account" });
    const submit = choice.getByRole("button", { name: /^(Use this account|Retry with this account)$/ });
    // Starting alone must not bypass the existing ordinary-operation gate.
    await choice.getByRole("radio", { name: /Alternative account/ }).click();
    await expect(submit).toHaveCount(0);
    await post("sandbox-lifecycle", {
      id: IDS.running,
      fields: { credential_delivery_pending: true, credential_note: "Account delivery is pending." },
    });
    await page.reload();
    await openChoices();
    await expect(page.getByText("Account change pending", { exact: true })).toBeVisible();
    await expect(choice.getByRole("radio", { checked: true })).toHaveCount(0);
    if (revoked) await expect(choice.getByRole("radio", { name: /Pending target/ })).toHaveCount(0);
    await choice.getByRole("radio", { name: revoked ? /Alternative account/ : /Pending target/ }).click();
    await expect(submit).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("pending-account-choice.png"),
      fullPage: true,
      animations: "disabled",
    });
    await submit.click();
    const before = await (await fetch(`${MOCK}/__test/state`)).json();
    expect(before.repointCalls).toHaveLength(0);
    await page.getByRole("alertdialog").getByRole("button", { name: "Change account", exact: true }).click();
    await expect(page.getByText("Sandbox account updated", { exact: true })).toBeVisible();
    await expect(page.getByText("Account change pending", { exact: true })).toHaveCount(0);
    const after = await (await fetch(`${MOCK}/__test/state`)).json();
    expect(after.repointCalls).toEqual([
      { id: IDS.running, credentialId: revoked ? OTHER : NEXT, org: "00000000-0000-4000-8000-000000000010" },
    ]);
    expect(after.launches).toHaveLength(0);
    await expect(page).toHaveURL(new RegExp(`/sandboxes/${IDS.running}$`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("pending-account-retry.png"),
      fullPage: true,
      animations: "disabled",
    });
  });
}
